// Node implementation of @workspace/p2p-runtime.
//
// Used directly by:
//   - the apps/node smoke harness (Phase 1 of PLAN.md)
//   - the spawned Node child process on the macOS RN-host path (Phase 3)
//
// Deliberately small: every public method maps to a single corestore /
// hyperswarm call. The whole point of this package is that the consuming app
// shouldn't care about Hypercore at all, only about logs and topics.

import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Corestore from 'corestore';
import Hyperswarm from 'hyperswarm';
import b4a from 'b4a';

import type {
  CreateRuntimeOptions,
  Did,
  Log,
  LogKey,
  P2PRuntime,
  TopicId,
} from './types.ts';
import { didFromSeed } from './did.ts';

// ----------------------------------------------------------------------------
// Log wrapper around a Hypercore
// ----------------------------------------------------------------------------

class NodeLog implements Log {
  private listeners = new Set<() => void>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly core: any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(core: any) {
    this.core = core;
    core.on('append', () => {
      for (const cb of this.listeners) cb();
    });
  }

  get key(): LogKey {
    return b4a.toString(this.core.key, 'hex');
  }
  get writable(): boolean {
    return Boolean(this.core.writable);
  }
  get length(): number {
    return this.core.length;
  }

  async append(block: Uint8Array): Promise<number> {
    const result = await this.core.append(b4a.from(block));
    // Hypercore v10 returns { length, byteLength }; extract the new log length.
    return (result as { length: number }).length;
  }

  async get(index: number): Promise<Uint8Array> {
    const buf = await this.core.get(index);
    // Hypercore returns a Buffer / b4a Uint8Array — normalise to a plain Uint8Array
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  on(event: 'append', cb: () => void): () => void {
    if (event !== 'append') throw new Error(`unknown event: ${String(event)}`);
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  async close(): Promise<void> {
    await this.core.close();
  }
}

// ----------------------------------------------------------------------------
// Runtime
// ----------------------------------------------------------------------------

export class NodeRuntime implements P2PRuntime {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private store!: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private swarm!: any;
  private storagePath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private joinedTopics = new Map<string, any>();
  private logs = new Map<string, NodeLog>();
  private didCache: Did | null = null;
  private opened = false;

  constructor(opts: CreateRuntimeOptions = {}) {
    const s = opts.storage;
    if (!s || s === ':memory:') {
      this.storagePath = mkdtempSync(join(tmpdir(), 'p2p-runtime-'));
    } else {
      if (!existsSync(s)) mkdirSync(s, { recursive: true });
      this.storagePath = s;
    }
  }

  async ready(): Promise<void> {
    if (this.opened) return;
    this.store = new Corestore(this.storagePath);
    await this.store.ready();
    this.swarm = new Hyperswarm();
    this.swarm.on('connection', (conn: unknown) => {
      // Every incoming connection is paired with a corestore replication stream.
      // corestore knows which cores the peer wants and responds to gets.
      this.store.replicate(conn);
    });

    // Derive a standards-compliant did:key from the store's ed25519 seed.
    // didFromSeed uses hypercore-crypto (sodium-universal) to expand the seed
    // to a public key, then encodes it per the did:key spec (multicodec +
    // base58btc). The result is a did:key:z6Mk… that ucanto will accept.
    const pk = this.store.primaryKey as Uint8Array;
    this.didCache = didFromSeed(pk);
    this.opened = true;
  }

  did(): Did {
    if (!this.didCache) throw new Error('Runtime not ready — await ready() first');
    return this.didCache;
  }

  async createLog(): Promise<Log> {
    if (!this.opened) throw new Error('Runtime not ready');
    const name = `log/${randomName()}`;
    const core = this.store.get({ name, valueEncoding: 'binary' });
    await core.ready();
    const log = new NodeLog(core);
    this.logs.set(log.key, log);
    return log;
  }

  async openLog(key: LogKey): Promise<Log> {
    if (!this.opened) throw new Error('Runtime not ready');
    const existing = this.logs.get(key);
    if (existing) return existing;
    const core = this.store.get({ key: b4a.from(key, 'hex'), valueEncoding: 'binary' });
    await core.ready();
    const log = new NodeLog(core);
    this.logs.set(key, log);
    return log;
  }

  async joinTopic(topic: TopicId): Promise<void> {
    if (!this.opened) throw new Error('Runtime not ready');
    if (this.joinedTopics.has(topic)) return;
    const buf = b4a.from(topic, 'hex');
    if (buf.length !== 32) {
      throw new Error(`Topic must be 32 bytes (64 hex chars), got ${buf.length} bytes`);
    }
    const discovery = this.swarm.join(buf, { server: true, client: true });
    this.joinedTopics.set(topic, discovery);
    await discovery.flushed();
  }

  async leaveTopic(topic: TopicId): Promise<void> {
    const d = this.joinedTopics.get(topic);
    if (!d) return;
    await d.destroy();
    this.joinedTopics.delete(topic);
  }

  async close(): Promise<void> {
    for (const log of this.logs.values()) {
      try {
        await log.close();
      } catch {
        /* ignore */
      }
    }
    if (this.swarm) {
      try {
        await this.swarm.destroy();
      } catch {
        /* ignore */
      }
    }
    if (this.store) {
      try {
        await this.store.close();
      } catch {
        /* ignore */
      }
    }
    this.opened = false;
  }

  // --------------------------------------------------------------------------
  // Internal: direct duplex-pipe replication for tests.
  //
  // NOT part of the public P2PRuntime interface. Tests use it to pair two
  // runtimes without standing up the DHT (deterministic, no network).
  // The real apps/node smoke harness uses joinTopic and the actual swarm.
  // --------------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/naming-convention
  __pipeReplicate(other: NodeRuntime): () => Promise<void> {
    if (!this.opened || !other.opened) {
      throw new Error('both runtimes must be ready before piping');
    }
    const a = this.store.replicate(true);
    const b = other.store.replicate(false);
    a.pipe(b).pipe(a);
    return async () => {
      a.destroy();
      b.destroy();
    };
  }
}

function randomName(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export async function createRuntime(
  opts: CreateRuntimeOptions = {},
): Promise<P2PRuntime> {
  const r = new NodeRuntime(opts);
  await r.ready();
  return r;
}

export type {
  P2PRuntime,
  Log,
  Did,
  TopicId,
  LogKey,
  CreateRuntimeOptions,
} from './types.ts';
