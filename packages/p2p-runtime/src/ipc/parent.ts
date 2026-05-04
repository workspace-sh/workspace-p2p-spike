// Parent client. Spawns a Node child and proxies P2PRuntime calls over the
// JSON-RPC protocol defined in ./protocol.ts.
//
// This is the Node-side parent — it uses `child_process.spawn`. The macOS
// TurboModule parent (Phase 3b) will mirror this shape but spawn via
// `NSTask` instead. The wire protocol is identical.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import type {
  CreateRuntimeOptions,
  Did,
  Log,
  LogKey,
  P2PRuntime,
  TopicId,
} from '../types.ts';
import { encode, LineDecoder } from './framing.ts';
import type {
  AppendBlockResult,
  AppendEvent,
  DidResult,
  GetBlockResult,
  InitResult,
  LogHandleResult,
  Method,
  OkResult,
  Params,
  Request,
} from './protocol.ts';

// ----- Resolve child entrypoint relative to this file ----------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD_BIN = resolve(HERE, 'child-bin.ts');

// ----------------------------------------------------------------------------
// Pending-request map
// ----------------------------------------------------------------------------

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

// ----------------------------------------------------------------------------
// Log proxy — a P2PRuntime.Log backed by RPC calls
// ----------------------------------------------------------------------------

class SpawnedLog implements Log {
  private listeners = new Set<() => void>();
  readonly key: LogKey;
  readonly writable: boolean;
  private _length: number;
  private parent: SpawnedRuntime;

  constructor(parent: SpawnedRuntime, handle: LogHandleResult) {
    this.parent = parent;
    this.key = handle.key;
    this.writable = handle.writable;
    this._length = handle.length;
  }

  get length(): number {
    return this._length;
  }

  /** Internal — called when the child emits an 'append' event for this log. */
  __onAppendEvent(newLength: number): void {
    this._length = newLength;
    for (const cb of this.listeners) cb();
  }

  async append(block: Uint8Array): Promise<number> {
    const r = (await this.parent.__rpc({
      method: 'appendBlock',
      key: this.key,
      blockHex: bytesToHex(block),
    })) as AppendBlockResult;
    this._length = r.length;
    return r.length;
  }

  async get(index: number): Promise<Uint8Array> {
    const r = (await this.parent.__rpc({
      method: 'getBlock',
      key: this.key,
      index,
    })) as GetBlockResult;
    return hexToBytes(r.blockHex);
  }

  on(event: 'append', cb: () => void): () => void {
    if (event !== 'append') throw new Error(`unknown event: ${String(event)}`);
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  async close(): Promise<void> {
    await this.parent.__rpc({ method: 'closeLog', key: this.key });
  }
}

// ----------------------------------------------------------------------------
// Runtime
// ----------------------------------------------------------------------------

export interface SpawnedRuntimeOptions extends CreateRuntimeOptions {
  /** Override the spawned Node binary. Defaults to `process.execPath`. */
  nodeBin?: string;
  /** Extra args before the script path (e.g. extra --enable-... flags). */
  nodeArgs?: string[];
}

export class SpawnedRuntime implements P2PRuntime {
  private child: ChildProcess | null = null;
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private logs = new Map<LogKey, SpawnedLog>();
  private didCache: Did | null = null;
  private storage: string | null;
  private nodeBin: string;
  private nodeArgs: string[];

  constructor(opts: SpawnedRuntimeOptions = {}) {
    this.storage = opts.storage ?? null;
    this.nodeBin = opts.nodeBin ?? process.execPath;
    this.nodeArgs = opts.nodeArgs ?? [];
  }

  async ready(): Promise<void> {
    if (this.child) return;
    this.child = spawn(
      this.nodeBin,
      [
        '--experimental-strip-types',
        '--no-warnings',
        ...this.nodeArgs,
        CHILD_BIN,
      ],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    );

    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (chunk: string) => {
      const messages = this.decoder.feed(chunk);
      for (const m of messages) this.handleMessage(m);
    });

    this.child.on('exit', (code) => {
      // Reject every still-pending request so callers don't hang.
      const err = new Error(`child exited (code=${code})`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.child = null;
    });

    const r = (await this.__rpc({
      method: 'init',
      storage: this.storage,
    })) as InitResult;
    this.didCache = r.did as Did;
  }

  did(): Did {
    if (!this.didCache) throw new Error('Runtime not ready — await ready() first');
    return this.didCache;
  }

  async createLog(): Promise<Log> {
    const r = (await this.__rpc({ method: 'createLog' })) as LogHandleResult;
    const log = new SpawnedLog(this, r);
    this.logs.set(log.key, log);
    return log;
  }

  async openLog(key: LogKey): Promise<Log> {
    const existing = this.logs.get(key);
    if (existing) return existing;
    const r = (await this.__rpc({ method: 'openLog', key })) as LogHandleResult;
    const log = new SpawnedLog(this, r);
    this.logs.set(log.key, log);
    return log;
  }

  async joinTopic(topic: TopicId): Promise<void> {
    await this.__rpc({ method: 'joinTopic', topic });
  }

  async leaveTopic(topic: TopicId): Promise<void> {
    await this.__rpc({ method: 'leaveTopic', topic });
  }

  async close(): Promise<void> {
    if (!this.child) return;
    try {
      await this.__rpc({ method: 'shutdown' });
    } catch {
      /* if the child already died, fall through */
    }
    if (this.child) {
      this.child.stdin!.end();
      // Wait for exit so tests don't race against process cleanup.
      await new Promise<void>((res) => {
        const c = this.child;
        if (!c) return res();
        if (c.exitCode != null) return res();
        c.once('exit', () => res());
      });
      this.child = null;
    }
  }

  // --------------------------------------------------------------------------
  // Internal RPC plumbing — exposed double-underscore so log proxies can use
  // them. Not part of the P2PRuntime interface.
  // --------------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/naming-convention
  __rpc(params: Params): Promise<unknown> {
    if (!this.child) {
      return Promise.reject(new Error('Runtime not ready — await ready() first'));
    }
    const id = this.nextId++;
    const req: Request = { id, method: params.method as Method, params };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.stdin!.write(encode(req));
    });
  }

  private handleMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    if ('event' in msg) {
      const evt = msg as AppendEvent;
      if (evt.event === 'append') {
        const proxy = this.logs.get(evt.key);
        if (proxy) proxy.__onAppendEvent(evt.length);
      }
      return;
    }
    const r = msg as { id: number; ok: boolean; result?: unknown; error?: { message: string } };
    const pending = this.pending.get(r.id);
    if (!pending) return;
    this.pending.delete(r.id);
    if (r.ok) pending.resolve(r.result);
    else pending.reject(new Error(r.error?.message ?? 'IPC error'));
  }
}

// ----- hex helpers (mirror of ipc/child.ts) -------------------------------

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd-length hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    s += b[i]!.toString(16).padStart(2, '0');
  }
  return s;
}

// Re-export so `OkResult` etc. are accessible to test code if they want them.
export type { LogHandleResult, AppendEvent, DidResult, OkResult };
