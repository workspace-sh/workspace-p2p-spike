// The Hypercore implementation of @workspace.sh/p2p-runtime.
//
// Used directly by:
//   - the apps/node smoke harness (Phase 1 of PLAN.md)
//   - the spawned Node child process on the macOS RN-host path (Phase 3)
//   - the Bare worklet on iOS / Android, which runs in-process rather than as
//     a child (see ipc/worklet-bin.ts)
//
// Named `.node` for its original host, but deliberately host-AGNOSTIC: the
// builtins below are imported unprefixed so this package's `imports` map can
// swap them for their `bare-*` equivalents under Bare, and bytes go through
// `b4a` rather than the `Buffer` global, which Bare does not have. Keeping one
// runtime for both hosts is what makes the "same code below the byte channel"
// claim actually true — it was not, before #229.
//
// Do NOT reintroduce `node:`-prefixed specifiers or `Buffer` here. Both work
// fine under Node and both silently break the mobile bundle.
//
// Deliberately small: every public method maps to a single corestore /
// hyperswarm call. The whole point of this package is that the consuming app
// shouldn't care about Hypercore at all, only about logs and topics.

import { existsSync, mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import Corestore from 'corestore';
import Hyperswarm from 'hyperswarm';
import b4a from 'b4a';
import Protomux from 'protomux';
import c from 'compact-encoding';
// Derives the swarm keypair from the corestore primaryKey so the Noise
// identity and the did:key identity are the same key (see ready()). Imported
// statically rather than through `createRequire`, which has no Bare
// equivalent; it is a direct dependency for that reason.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import hypercoreCryptoModule from 'hypercore-crypto';

import type {
  ConnectionAuth,
  CreateRuntimeOptions,
  Did,
  Log,
  LogKey,
  P2PRuntime,
  TopicId,
} from './types.ts';
import { didFromPublicKey } from './did.ts';
import { flushLogToDir, hydrateLogFromDir } from './transport-form.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hypercoreCrypto = hypercoreCryptoModule as any;

// How long to wait for a peer's membership proof before dropping a gated
// connection. Generous — covers a slow handshake, well short of hanging.
const AUTH_TIMEOUT_MS = 10_000;

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
  get contiguousLength(): number {
    return this.core.contiguousLength as number;
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
  private swarm: any = null;
  /** False makes this runtime local-only — see CreateRuntimeOptions.swarm. */
  private wantSwarm = true;
  private storagePath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private joinedTopics = new Map<string, any>();
  private logs = new Map<string, NodeLog>();
  private didCache: Did | null = null;
  // Cold replicas used only to make flushing incremental — a rebuildable
  // cache beside the main store, never inside a workspace folder.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private captureStore: any = null;
  private opened = false;
  private bootstrap: Array<{ host: string; port: number }> | undefined;
  private auth: ConnectionAuth | undefined;
  private identitySeed: Uint8Array | undefined;

  constructor(opts: CreateRuntimeOptions = {}) {
    this.wantSwarm = opts.swarm !== false;
    const s = opts.storage;
    if (!s || s === ':memory:') {
      this.storagePath = mkdtempSync(join(tmpdir(), 'p2p-runtime-'));
    } else {
      if (!existsSync(s)) mkdirSync(s, { recursive: true });
      this.storagePath = s;
    }
    this.bootstrap = opts.bootstrap;
    this.auth = opts.auth;
    if (opts.identitySeed && opts.identitySeed.length !== 32) {
      throw new Error(`identitySeed must be 32 bytes, got ${opts.identitySeed.length}`);
    }
    this.identitySeed = opts.identitySeed;
  }

  async ready(): Promise<void> {
    if (this.opened) return;
    // A fixed identitySeed pins the corestore primaryKey (and thus the DID +
    // swarm keypair); otherwise corestore generates a random primaryKey.
    // `unsafe: true` acknowledges that we're supplying the primaryKey
    // ourselves — corestore guards against this by default because reusing a
    // primary key across unrelated stores can be dangerous. Here it's
    // deliberate: a fixed identitySeed is how a peer gets a deterministic DID.
    this.store = this.identitySeed
      ? new Corestore(this.storagePath, {
          primaryKey: b4a.from(this.identitySeed),
          unsafe: true,
        })
      : new Corestore(this.storagePath);
    await this.store.ready();

    // Derive the swarm keypair from the corestore primaryKey so the peer's
    // Noise static identity IS its did:key identity — the same ed25519 key.
    // didFromPublicKey(keyPair.publicKey) is identical to the prior
    // didFromSeed(primaryKey), so the DID value is unchanged; we just stop
    // letting Hyperswarm generate an unrelated key. This binding is what
    // makes topic-layer auth sound: a peer's authenticated connection key
    // matches the DID its membership UCAN is addressed to.
    const primaryKey = this.store.primaryKey as Uint8Array;
    const keyPair = hypercoreCrypto.keyPair(b4a.from(primaryKey)) as {
      publicKey: Uint8Array;
      secretKey: Uint8Array;
    };

    // Local-only runtimes never build one. The keypair above is derived
    // regardless, because the DID comes from the corestore primaryKey — the
    // swarm merely reuses it as its Noise identity.
    if (this.wantSwarm) {
      this.swarm = new Hyperswarm({
        keyPair,
        ...(this.bootstrap ? { bootstrap: this.bootstrap } : {}),
      });
      this.swarm.on('connection', (conn: unknown) => {
        if (!this.auth) {
          // Open swarm (default): every connection replicates immediately.
          this.store.replicate(conn);
          return;
        }
        // Gated: exchange + verify membership proofs before replicating.
        this._gatedReplicate(conn).catch(() => {
          try {
            (conn as { destroy(err?: Error): void }).destroy(new Error('auth failed'));
          } catch {
            /* already gone */
          }
        });
      });
    }

    this.didCache = didFromPublicKey(keyPair.publicKey);
    this.opened = true;
  }

  // Gate a connection behind the membership-proof exchange. Opens a dedicated
  // `workspace/auth@1` channel on the connection's shared Protomux (the same
  // muxer corestore replicates over), presents our proof, and waits for the
  // peer's. Replicates only on a positive verdict; drops the connection
  // otherwise, or on timeout.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _gatedReplicate(conn: any): Promise<void> {
    const auth = this.auth!;
    const mux = Protomux.from(conn);

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        conn.destroy(new Error('membership proof timed out'));
      } catch {
        /* already gone */
      }
    }, AUTH_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();

    const channel = mux.createChannel({ protocol: 'workspace/auth@1' });
    if (channel === null) {
      // A channel for this protocol is already open on the muxer — treat as
      // a protocol error and drop.
      clearTimeout(timer);
      conn.destroy(new Error('auth channel already open'));
      return;
    }

    const message = channel.addMessage({
      encoding: c.raw,
      onmessage: (remoteProof: Uint8Array) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        Promise.resolve(auth.verify(conn.remotePublicKey as Uint8Array, remoteProof))
          .then((ok) => {
            if (ok) this.store.replicate(conn);
            else conn.destroy(new Error('workspace membership rejected'));
          })
          .catch(() => {
            try {
              conn.destroy(new Error('membership verify error'));
            } catch {
              /* already gone */
            }
          });
      },
    });

    channel.open();
    message.send(auth.localProof);
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
    // Deliberately after the length check: the existing validation tests pass
    // a swarmless runtime a bad topic and assert the length message.
    if (this.swarm === null) {
      throw new Error(
        'joinTopic requires a swarm — this runtime was created with `swarm: false` and is local-only',
      );
    }
    const discovery = this.swarm.join(buf, { server: true, client: true });
    this.joinedTopics.set(topic, discovery);
    await discovery.flushed();
  }

  /** See P2PRuntime.replicates — false when built with `swarm: false`. */
  get replicates(): boolean {
    return this.wantSwarm;
  }

  async leaveTopic(topic: TopicId): Promise<void> {
    const d = this.joinedTopics.get(topic);
    if (!d) return;
    await d.destroy();
    this.joinedTopics.delete(topic);
  }

  private _captureStore(): unknown {
    if (this.captureStore === null) {
      this.captureStore = new Corestore(`${this.storagePath}-capture`);
    }
    return this.captureStore;
  }

  async flushLogToDir(key: LogKey, dir: string): Promise<{ written: number; length: number }> {
    if (!this.opened) throw new Error('Runtime not ready');
    return flushLogToDir(this.store, this._captureStore(), b4a.from(key, 'hex'), dir);
  }

  async hydrateLogFromDir(
    key: LogKey,
    dir: string,
  ): Promise<{ applied: number; skipped: number; length: number }> {
    if (!this.opened) throw new Error('Runtime not ready');
    return hydrateLogFromDir(this.store, b4a.from(key, 'hex'), dir);
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
    if (this.captureStore) {
      try {
        await this.captureStore.close();
      } catch {
        /* ignore */
      }
      this.captureStore = null;
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
