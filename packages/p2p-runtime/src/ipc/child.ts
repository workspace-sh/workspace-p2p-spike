// Child worker. Wraps a NodeRuntime and serves the JSON-RPC protocol
// (see ./protocol.ts) over stdin/stdout.
//
// The parent — whether a Node parent (tests + apps/node) or a future macOS
// TurboModule parent — only ever sees the wire shape. The child code is
// reused unchanged.

import { NodeRuntime } from '../runtime.node.ts';
import type { Log } from '../types.ts';
import { encode, LineDecoder } from './framing.ts';
import type {
  AppendBlockResult,
  AppendEvent,
  ChildToParent,
  DidResult,
  GetBlockResult,
  Hex,
  InitResult,
  LogHandleResult,
  OkResult,
  Params,
  ParentToChild,
  Request,
} from './protocol.ts';

interface OpenLog {
  log: Log;
  unsubscribe: () => void;
}

export class Child {
  private runtime: NodeRuntime | null = null;
  private logs = new Map<Hex, OpenLog>();
  private decoder = new LineDecoder();
  private write: (s: string) => void;
  private shuttingDown = false;

  constructor(write: (s: string) => void) {
    this.write = write;
  }

  /** Feed a chunk read from stdin. Dispatches each complete message. */
  async feed(chunk: string): Promise<void> {
    const messages = this.decoder.feed(chunk);
    for (const m of messages) {
      await this.handle(m as Request);
    }
  }

  private async handle(req: Request): Promise<void> {
    try {
      const result = await this.dispatch(req.params);
      this.send({ id: req.id, ok: true, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.send({ id: req.id, ok: false, error: { message } });
    }
  }

  private async dispatch(params: Params): Promise<unknown> {
    switch (params.method) {
      case 'init': {
        if (this.runtime) {
          return { did: this.runtime.did() } satisfies InitResult;
        }
        this.runtime = new NodeRuntime({ storage: params.storage ?? undefined });
        await this.runtime.ready();
        return { did: this.runtime.did() } satisfies InitResult;
      }
      case 'did': {
        return { did: this.requireRuntime().did() } satisfies DidResult;
      }
      case 'createLog': {
        const log = await this.requireRuntime().createLog();
        this.track(log);
        return { key: log.key, writable: log.writable, length: log.length } satisfies LogHandleResult;
      }
      case 'openLog': {
        const log = await this.requireRuntime().openLog(params.key);
        this.track(log);
        return { key: log.key, writable: log.writable, length: log.length } satisfies LogHandleResult;
      }
      case 'closeLog': {
        const open = this.logs.get(params.key);
        if (!open) return { ok: true } satisfies OkResult;
        open.unsubscribe();
        await open.log.close();
        this.logs.delete(params.key);
        return { ok: true } satisfies OkResult;
      }
      case 'appendBlock': {
        const open = this.logs.get(params.key);
        if (!open) throw new Error(`unknown log: ${params.key}`);
        const block = hexToBytes(params.blockHex);
        const length = await open.log.append(block);
        return { length } satisfies AppendBlockResult;
      }
      case 'getBlock': {
        const open = this.logs.get(params.key);
        if (!open) throw new Error(`unknown log: ${params.key}`);
        const block = await open.log.get(params.index);
        return { blockHex: bytesToHex(block) } satisfies GetBlockResult;
      }
      case 'joinTopic': {
        await this.requireRuntime().joinTopic(params.topic);
        return { ok: true } satisfies OkResult;
      }
      case 'leaveTopic': {
        await this.requireRuntime().leaveTopic(params.topic);
        return { ok: true } satisfies OkResult;
      }
      case 'shutdown': {
        this.shuttingDown = true;
        for (const { unsubscribe, log } of this.logs.values()) {
          unsubscribe();
          try { await log.close(); } catch { /* ignore */ }
        }
        this.logs.clear();
        if (this.runtime) {
          try { await this.runtime.close(); } catch { /* ignore */ }
          this.runtime = null;
        }
        return { ok: true } satisfies OkResult;
      }
    }
  }

  private track(log: Log): void {
    if (this.logs.has(log.key)) return;
    const unsubscribe = log.on('append', () => {
      // Send an event whenever a new block lands — covers both local appends
      // and replicated appends from peers.
      const evt: AppendEvent = { event: 'append', key: log.key, length: log.length };
      this.send(evt);
    });
    this.logs.set(log.key, { log, unsubscribe });
  }

  private requireRuntime(): NodeRuntime {
    if (!this.runtime) throw new Error('runtime not initialised — send init first');
    return this.runtime;
  }

  private send(msg: ChildToParent): void {
    if (this.shuttingDown && !('event' in msg)) {
      // Always allow responses through; never write events after shutdown
    }
    this.write(encode(msg));
  }
}

// ----- hex helpers ----------------------------------------------------------

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

// Re-export the parent-side shape for callers that just want the type.
export type { ParentToChild };
