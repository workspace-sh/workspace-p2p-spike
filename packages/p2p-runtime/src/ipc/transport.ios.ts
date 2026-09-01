// iOS/Android transport — bridges SpawnedRuntime to a Bare worklet.
//
// The macOS sibling (`transport.macos.ts`) adapts an NSTask child reached
// through a TurboModule. This one adapts a `react-native-bare-kit` Worklet:
// Bare runs in-process, so there is no process to spawn and no binary to
// bundle — the "child" is a worklet started from a `bare-pack` bundle.
//
// The Transport contract is five members wide (send / onMessage / onExit /
// close / closed), which is why the mobile path is an adapter rather than a
// port. Nothing above this file changes.
//
// Naming: `.ios.ts` so Metro resolves it on iOS. Android takes the same
// binding, so `runtime.android.ts` imports this module directly rather than
// duplicating it under a second extension.

import type { Transport } from './transport.ts';

/** The slice of `react-native-bare-kit`'s Worklet we depend on. */
export interface BareWorklet {
  start(filename: string, source: ArrayBuffer | Uint8Array | string): void;
  terminate(): Promise<void> | void;
  readonly IPC: {
    write(data: Uint8Array | string): void;
    on(event: 'data', cb: (data: Uint8Array) => void): void;
    on(event: 'close', cb: () => void): void;
    end?(): void;
  };
}

export interface BareTransportOptions {
  /** A `new Worklet()` from `react-native-bare-kit`, injected so this module
   *  stays importable (and testable) without the native dependency present. */
  worklet: BareWorklet;
  /** Path the worklet reports as its entry filename, e.g. `/app.bundle`. */
  filename?: string;
}

export class BareTransport implements Transport {
  private worklet: BareWorklet;
  private filename: string;
  private msgListeners = new Set<(msg: unknown) => void>();
  private exitListeners = new Set<(code: number | null) => void>();
  private _closed = false;
  private decoder = new TextDecoder();
  // Bare's IPC is a byte stream, not a message channel: a write on the worklet
  // side can arrive here split across reads, or several coalesced into one.
  // Same problem stdio has, and it gets the same fix — buffer until newline.
  // Getting this wrong yields JSON.parse failures only under load, which is
  // the worst way to find out.
  private buffer = '';

  constructor(opts: BareTransportOptions) {
    this.worklet = opts.worklet;
    this.filename = opts.filename ?? '/app.bundle';
  }

  /**
   * Start the worklet from a `bare-pack` bundle. Must be called before the
   * transport is handed to SpawnedRuntime.
   *
   * Listeners are attached before `start` so the first line can't be missed —
   * the worklet begins executing immediately.
   */
  async start(bundle: ArrayBuffer | Uint8Array | string): Promise<void> {
    this.worklet.IPC.on('data', (data: Uint8Array) => {
      this.buffer += typeof data === 'string' ? data : this.decoder.decode(data);
      const parts = this.buffer.split('\n');
      this.buffer = parts.pop() ?? '';
      for (const part of parts) {
        if (!part) continue;
        try {
          const msg: unknown = JSON.parse(part);
          for (const cb of this.msgListeners) cb(msg);
        } catch {
          // Malformed line — the worklet's console output goes to the system
          // log, so diagnostics are there rather than in-band.
        }
      }
    });

    this.worklet.IPC.on('close', () => {
      this.markClosed(null);
    });

    this.worklet.start(this.filename, bundle);
  }

  private markClosed(code: number | null): void {
    if (this._closed) return;
    this._closed = true;
    for (const cb of this.exitListeners) cb(code);
  }

  get closed(): boolean {
    return this._closed;
  }

  send(line: string): void {
    if (this._closed) return;
    this.worklet.IPC.write(line);
  }

  onMessage(cb: (msg: unknown) => void): () => void {
    this.msgListeners.add(cb);
    return () => {
      this.msgListeners.delete(cb);
    };
  }

  onExit(cb: (code: number | null) => void): () => void {
    this.exitListeners.add(cb);
    return () => {
      this.exitListeners.delete(cb);
    };
  }

  async close(): Promise<void> {
    if (this._closed) return;
    // Close the write side first so the worklet sees end-of-input and can
    // shut down cleanly, mirroring how the macOS path closes stdin before
    // terminating. Fall back to terminate() for an unresponsive worklet.
    this.worklet.IPC.end?.();
    await this.worklet.terminate();
    this.markClosed(0);
  }
}
