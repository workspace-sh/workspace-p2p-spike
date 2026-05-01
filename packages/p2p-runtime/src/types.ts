// Public types for @workspace/p2p-runtime.
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

/** Options passed to the per-platform factory. */
export interface CreateRuntimeOptions {
  /**
   * Storage location.
   * - On Node/macOS: a filesystem path. `:memory:` falls back to an OS tempdir.
   * - On mobile: passed through to BareKit's persistent storage area.
   * - On web: ignored (the web runtime is a stub today).
   */
  storage?: string;
}
