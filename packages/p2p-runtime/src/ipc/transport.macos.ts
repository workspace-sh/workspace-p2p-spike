// macOS transport — bridges SpawnedRuntime to the P2PRuntime TurboModule.
//
// The TurboModule (P2PRuntimeModule.mm) owns the NSTask lifecycle. This class
// is purely a JS-side adapter: it subscribes to native events and forwards
// send() calls through to the native module.
//
// Only imported by runtime.macos.ts — never by Node/test code. Metro resolves
// the .macos.ts extension automatically so other platforms never see this file.

import { NativeEventEmitter } from 'react-native';
import NativeP2PRuntime from './NativeP2PRuntime.ts';
import type { Transport } from './transport.ts';

export class MacOSTransport implements Transport {
  private emitter: NativeEventEmitter;
  private msgListeners = new Set<(msg: unknown) => void>();
  private exitListeners = new Set<(code: number | null) => void>();
  private _closed = false;
  private lineUnsub: (() => void) | null = null;
  private exitUnsub: (() => void) | null = null;

  constructor() {
    // NativeEventEmitter requires the native module as its argument so RN can
    // pair addListener / removeListeners calls to the correct module.
    this.emitter = new NativeEventEmitter(NativeP2PRuntime as never);
  }

  /**
   * Spawn the child process via the TurboModule (NSTask on macOS).
   * Must be called before passing this transport to SpawnedRuntime.
   */
  async spawn(nodeBin: string, scriptPath: string, storage: string | null): Promise<void> {
    // Subscribe to events before spawning so we never miss the first line.
    const lineSub = this.emitter.addListener('p2pLine', (event: { line: string }) => {
      try {
        const msg: unknown = JSON.parse(event.line);
        for (const cb of this.msgListeners) cb(msg);
      } catch {
        // Malformed line — ignore; child stderr is inherit so it shows up there.
      }
    });

    const exitSub = this.emitter.addListener('p2pExit', (event: { code: number | null }) => {
      this._closed = true;
      lineSub.remove();
      exitSub.remove();
      for (const cb of this.exitListeners) cb(event.code ?? null);
    });

    this.lineUnsub = () => lineSub.remove();
    this.exitUnsub = () => exitSub.remove();

    await NativeP2PRuntime.spawn(nodeBin, scriptPath, storage);
  }

  get closed(): boolean {
    return this._closed;
  }

  send(line: string): void {
    NativeP2PRuntime.send(line);
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
    await NativeP2PRuntime.close();
    // onExit fires from the native side and sets _closed; we don't need to
    // set it here — but remove our event subscriptions to avoid leaks.
    this.lineUnsub?.();
    this.exitUnsub?.();
    this._closed = true;
  }
}
