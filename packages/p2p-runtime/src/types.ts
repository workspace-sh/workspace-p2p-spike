// Public types for @workspace.sh/p2p-runtime.
//
// Deliberately minimal. The whole point of the interface is that the consuming
// app shouldn't need to know whether it's talking to a Bare worklet (mobile),
// a spawned Node child (macOS), or a stub (web). Only what a P2P log + topic
// looks like.

/** Stable peer identity. Today: `did:key:z…`. */
export type Did = `did:key:${string}`;

/** Hex-encoded discovery topic. 32 bytes, hashed from a stable string. */
export type TopicId = string;

/** Hex-encoded log public key. */
export type LogKey = string;

/** Append-only log. Reads at most `length` blocks; writes append. */
export interface Log {
  /** Public key of the log, hex-encoded. */
  readonly key: LogKey;
  /** Whether this peer can append. False for replicated peer logs. */
  readonly writable: boolean;
  /** Current length (in blocks) as observed locally. */
  readonly length: number;

  /** Append a single block. Returns the new length. Writable logs only. */
  append(block: Uint8Array): Promise<number>;

  /** Read block at the given index. */
  get(index: number): Promise<Uint8Array>;

  /** Subscribe to "new block appeared" events. Returns an unsubscribe fn. */
  on(event: 'append', cb: () => void): () => void;

  /** Release this log handle. */
  close(): Promise<void>;
}

/** A P2P runtime — created once per app, owns identity + storage + swarm. */
export interface P2PRuntime {
  /** Resolves once the runtime is ready to serve calls. */
  ready(): Promise<void>;

  /** This peer's stable identity. */
  did(): Did;

  /** Create a new writable log. Returns the `LogKey` (hex public key). */
  createLog(): Promise<Log>;

  /** Open an existing log by key. Read-only if this peer is not the writer. */
  openLog(key: LogKey): Promise<Log>;

  /** Join a discovery topic. Replicates any logs the runtime knows about. */
  joinTopic(topic: TopicId): Promise<void>;

  /** Leave a discovery topic. */
  leaveTopic(topic: TopicId): Promise<void>;

  /** Tear down. After close() the runtime is unusable. */
  close(): Promise<void>;
}

/**
 * Connect-time authentication hook (topic-layer auth, #10).
 *
 * When set, the runtime gates replication behind a proof exchange: on each
 * swarm connection it presents `localProof` to the remote peer and calls
 * `verify` with the remote's proof. Replication proceeds only if `verify`
 * returns true; otherwise the connection is dropped.
 *
 * The runtime stays UCAN-agnostic — it just moves opaque proof bytes over the
 * connection and defers the decision to `verify`. The actual membership logic
 * (bind proof to the authenticated key, validate the UCAN chain to the
 * workspace root, check revocation) lives in `@workspace.sh/portable-bootstrap`'s
 * `verifyMembership`, which you wrap into `verify`.
 */
export interface ConnectionAuth {
  /** This peer's membership proof bytes, presented to the remote on connect. */
  localProof: Uint8Array;
  /**
   * Decide whether to accept a connection. `remotePublicKey` is the remote
   * peer's Noise static key (32-byte ed25519), authenticated by the handshake
   * — the trust anchor the proof must bind to. Return true to replicate.
   */
  verify(remotePublicKey: Uint8Array, remoteProof: Uint8Array): boolean | Promise<boolean>;
}

/** Options passed to the per-platform factory. */
export interface CreateRuntimeOptions {
  /**
   * Storage location.
   * - On Node/macOS: a filesystem path. `:memory:` falls back to an OS tempdir.
   * - On mobile: passed through to BareKit's persistent storage area.
   * - On web: ignored (the web runtime is a stub today).
   */
  storage?: string;

  /**
   * DHT bootstrap nodes for Hyperswarm. When set, the runtime uses these
   * instead of the public Hyperswarm DHT — useful for tests, self-hosted
   * orgs running a private DHT, or simulated multi-peer environments that
   * shouldn't emit traffic to the public internet.
   *
   * Each entry is `{ host, port }`. Pass at least one; the DHT will use
   * the others as backups.
   *
   * See `docs/discovery-layers.md` for the broader local-first /
   * LAN / WAN discovery story this fits into.
   */
  bootstrap?: Array<{ host: string; port: number }>;

  /**
   * 32-byte seed fixing this peer's identity. When set, the corestore
   * primaryKey and the swarm keypair both derive from it, so the peer's
   * `did:key` is deterministic and known ahead of `ready()` —
   * `didFromSeed(identitySeed)`. When unset, corestore generates a random
   * primaryKey (a fresh identity each run).
   *
   * Needed when a caller must know its own DID before the runtime starts —
   * e.g. to mint a membership proof addressed to it (see `auth`). Also the
   * seam for persistent identity once the spike grows one.
   */
  identitySeed?: Uint8Array;

  /**
   * Connect-time authentication (topic-layer auth, #10). When set, the
   * runtime gates replication behind a membership-proof exchange on every
   * swarm connection. When unset (the default), any peer on the topic can
   * connect and replicate — the spike's behaviour to date.
   */
  auth?: ConnectionAuth;
}
