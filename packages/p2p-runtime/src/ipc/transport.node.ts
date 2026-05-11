// Node transport — spawns a child process via child_process.spawn.
//
// Used by SpawnedRuntime in non-RN contexts (tests, apps/node, apps/macos-probe).
// The macOS TurboModule path uses transport.macos.ts instead; both satisfy the
// same Transport interface so SpawnedRuntime never knows the difference.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { LineDecoder } from './framing.ts';
import type { Transport } from './transport.ts';

// Default child entrypoint — resolved relative to this file so it works
// regardless of the CWD when tests run.
const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CHILD_BIN = resolve(HERE, 'child-bin.ts');

export interface NodeTransportOptions {
  /** Override the Node binary. Defaults to process.execPath. */
  nodeBin?: string;
  /** Extra flags inserted *before* the script path. */
  nodeArgs?: string[];
  /** Override the child entrypoint script. Defaults to DEFAULT_CHILD_BIN. */
  scriptPath?: string;
}

export class NodeTransport implements Transport {
  private child: ChildProcess;
  private decoder = new LineDecoder();
  private msgListeners = new Set<(msg: unknown) => void>();
  private exitListeners = new Set<(code: number | null) => void>();
  private _closed = false;

  constructor(opts: NodeTransportOptions = {}) {
    const bin = opts.nodeBin ?? process.execPath;
    const script = opts.scriptPath ?? DEFAULT_CHILD_BIN;

    this.child = spawn(
      bin,
      [
        '--experimental-strip-types',
        '--no-warnings',
        ...(opts.nodeArgs ?? []),
        script,
      ],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    );

    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (chunk: string) => {
      const msgs = this.decoder.feed(chunk);
      for (const msg of msgs) {
        for (const cb of this.msgListeners) cb(msg);
      }
    });

    this.child.on('exit', (code) => {
      this._closed = true;
      for (const cb of this.exitListeners) cb(code);
    });
  }

  get closed(): boolean {
    return this._closed;
  }

  send(line: string): void {
    this.child.stdin!.write(line);
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
    this.child.stdin!.end();
    await new Promise<void>((res) => {
      if (this.child.exitCode != null) return res();
      this.child.once('exit', () => res());
    });
  }
}
