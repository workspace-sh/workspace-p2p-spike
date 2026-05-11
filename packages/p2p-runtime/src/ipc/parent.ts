// Parent client. Drives a NodeRuntime running in a child process via the
// JSON-RPC protocol defined in ./protocol.ts.
//
// SpawnedRuntime is transport-agnostic: it takes any Transport and proxies
// P2PRuntime calls over the wire. The concrete transport (how the child was
// spawned, how bytes flow) is the caller's concern:
//
//   - NodeTransport  (child_process.spawn)  — used by tests + apps/node
//   - MacOSTransport (NSTask via TurboModule) — used by apps/macos (Phase 3b)

import type {
  CreateRuntimeOptions,
  Did,
  Log,
  LogKey,
  P2PRuntime,
  TopicId,
} from '../types.ts';
import { encode } from './framing.ts';
import { NodeTransport } from './transport.node.ts';
import type { NodeTransportOptions } from './transport.node.ts';
import type { Transport } from './transport.ts';
import type {
  AppendBlockResult,
  AppendEvent,
  GetBlockResult,
  InitResult,
  LogHandleResult,
  Method,
  OkResult,
  Params,
  Request,
} from './protocol.ts';

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

export interface SpawnedRuntimeOptions extends CreateRuntimeOptions, NodeTransportOptions {
  /**
   * Pre-initialised transport. When provided, SpawnedRuntime uses it directly
   * and the nodeBin / nodeArgs / scriptPath options are ignored.
   * Used by the macOS path (transport = MacOSTransport) and unit tests.
   */
  transport?: Transport;
}

export class SpawnedRuntime implements P2PRuntime {
  private transport: Transport;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private logs = new Map<LogKey, SpawnedLog>();
  private didCache: Did | null = null;
  private storage: string | null;
  private _ready = false;

  constructor(opts: SpawnedRuntimeOptions = {}) {
    this.storage = opts.storage ?? null;
    this.transport =
      opts.transport ??
      new NodeTransport({
        nodeBin: opts.nodeBin,
        nodeArgs: opts.nodeArgs,
        scriptPath: opts.scriptPath,
      });
  }

  async ready(): Promise<void> {
    if (this._ready) return;

    // Wire up message + exit handlers before sending any RPC.
    this.transport.onMessage((msg) => this.handleMessage(msg));
    this.transport.onExit((code) => {
      const err = new Error(`child exited (code=${code})`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this._ready = false;
    });

    const r = (await this.__rpc({
      method: 'init',
      storage: this.storage,
    })) as InitResult;
    this.didCache = r.did as Did;
    this._ready = true;
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
    if (!this._ready && this.transport.closed) return;
    try {
      await this.__rpc({ method: 'shutdown' });
    } catch {
      /* child may already be dead */
    }
    await this.transport.close();
    this._ready = false;
  }

  // --------------------------------------------------------------------------
  // Internal RPC plumbing — exposed double-underscore so log proxies and
  // tests can reach it. Not part of the P2PRuntime interface.
  // --------------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/naming-convention
  __rpc(params: Params): Promise<unknown> {
    if (!this._ready && this.transport.closed) {
      return Promise.reject(new Error('Runtime not ready — await ready() first'));
    }
    const id = this.nextId++;
    const req: Request = { id, method: params.method as Method, params };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.send(encode(req));
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

// ----- hex helpers -----------------------------------------------------------

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

// Re-export types so callers that only import from parent.ts get them.
export type { LogHandleResult, AppendEvent, InitResult, OkResult };
export type { Transport } from './transport.ts';
export type { NodeTransportOptions } from './transport.node.ts';
