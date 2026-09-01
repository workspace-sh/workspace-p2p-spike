// @workspace.sh/workspace — the app-facing Workspace SDK.
//
// One object that composes the proven primitives (runtime + bundle +
// envelopes + encrypted log + membership gate) so the app codes against a
// single surface instead of wiring crypto by hand. Compare the ~200-line
// demos to the workspace-sdk demo that uses this.
//
//   const ws = await Workspace.create({ createRuntime, name: 'Acme', folder });
//   await ws.invite(bobDid);
//   await ws.write(enc.encode('hello'));
//   ws.on('change', render);
//
//   const ws2 = await Workspace.open({ createRuntime, folder, identitySeed });
//
// Platform-agnostic by design: it never imports a platform runtime. The
// caller injects `createRuntime` (from `@workspace.sh/p2p-runtime/node`, or a
// test double). That keeps this package free of native deps and unit-testable.
//
// v1 scope: single-writer data log under K0_org, membership gate auto-wired,
// the .workspace folder as persistence. Deferred to v2 (same API, new
// internals): Autobase multi-writer (#11), the document/section model, and
// `workspace://` join.

// SHA-256 via sodium rather than `node:crypto`, so this module packs into a
// Bare worklet for the mobile path (#229). Byte-identical output — verified
// against createHash('sha256') — so topic IDs are unchanged.
import b4a from 'b4a';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import sodiumModule from 'sodium-universal';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sodium = sodiumModule as any;

import { readBlob, writeBlob, type BlobRef } from './blobs.ts';
import {
  listWorkingTree,
  watchWorkingTree,
  type ListOptions,
  type WorkingTreeChange,
  type WorkingTreeEntry,
} from './watcher.ts';

import {
  encryptedLog,
  didFromSeed,
  keyPairFromSeed,
  type P2PRuntime,
  type Log,
  type Did,
  type CreateRuntimeOptions,
} from '@workspace.sh/p2p-runtime';
import { principalFromSeed, type Principal, type CapabilityDescriptor } from '@workspace.sh/ucan-boundary';
import {
  createBundle,
  consumeBundle,
  createEnvelope,
  writeBundleFolder,
  readBundleFolder,
  publishDelivery,
  verifyMembership,
  type Bundle,
  type Manifest,
} from '@workspace.sh/portable-bootstrap';

/** A factory that builds a platform runtime — inject from the platform package. */
export type RuntimeFactory = (opts: CreateRuntimeOptions) => Promise<P2PRuntime>;

type Bootstrap = Array<{ host: string; port: number }>;

export interface WorkspaceCreateOptions {
  /** Platform runtime factory, e.g. `createRuntime` from `@workspace.sh/p2p-runtime/node`. */
  createRuntime: RuntimeFactory;
  /** Path to the `.workspace` folder to create. */
  folder: string;
  /** Friendly name (metadata only, for now). */
  name?: string;
  /**
   * 32-byte seed fixing the WORKSPACE's root identity. Defaults to random.
   *
   * One workspace, one root keypair — `workspace-format.md` resolves this
   * explicitly: "Orgs with multiple workspaces create multiple `.workspace`
   * folders, each with its own root keypair." The root public key IS the
   * workspaceId, and the swarm topic is a hash of it, so sharing a root seed
   * between workspaces gives them one identity and one topic.
   *
   * Pass this only to make a workspace reproducible in a test. Never pass a
   * device's identity seed: that is a different identity (see `identitySeed`).
   */
  rootSeed?: Uint8Array;
  /**
   * 32-byte seed for the CREATOR's own peer identity — this device.
   *
   * Distinct from `rootSeed` by design. `identity-recovery.md`: "A device's
   * identity is an ed25519 keypair whose public half is its `did:key`; the
   * private half never leaves the device." The root identity belongs to the
   * workspace; this one belongs to the machine, and one machine can create
   * many workspaces.
   *
   * Defaults to `rootSeed`, which is the pre-#317 behaviour and is what the
   * tests rely on. Real callers should pass their device seed.
   */
  identitySeed?: Uint8Array;
  /** Working-store path (app-private). Unset → the runtime's temp default. */
  storage?: string;
  /** DHT bootstrap nodes (omit for the public DHT). */
  bootstrap?: Bootstrap;
}

export interface WorkspaceOpenOptions {
  createRuntime: RuntimeFactory;
  /** Path to an existing `.workspace` folder. */
  folder: string;
  /** This peer's 32-byte identity seed. An envelope for its DID must exist. */
  identitySeed: Uint8Array;
  /** Working-store path (app-private). Unset → the runtime's temp default. */
  storage?: string;
  bootstrap?: Bootstrap;
}

type ChangeListener = () => void;

const CAP: (resource: string) => CapabilityDescriptor = (resource) => ({
  can: 'workspace/read',
  with: resource,
});

/**
 * How long a workspace must be quiet before its log is copied into the folder.
 *
 * Long enough that a burst of edits costs one flush, short enough that the
 * folder is never far behind. The materialiser debounces disk writes on a
 * similar scale for the same reason.
 */
const FLUSH_DEBOUNCE_MS = 2_000;

/** Derive the swarm topic deterministically from the workspaceId. */
function topicForWorkspace(workspaceId: string): string {
  const out = b4a.alloc(sodium.crypto_hash_sha256_BYTES);
  sodium.crypto_hash_sha256(out, b4a.from(`workspace://${workspaceId}`));
  return b4a.toString(out, 'hex');
}

/** Transport-form directory for one log (workspace-format.md § store/). */
function transportDir(folder: string, key: string): string {
  return `${folder}/.workspace/store/v1/${key}`;
}

/**
 * A live workspace handle. Obtain one via `Workspace.create` or
 * `Workspace.open`; release it with `close()`.
 */

/**
 * Announce this workspace on the swarm — WITHOUT waiting for it.
 *
 * Measured on a cellular connection: opening the corestore takes 73 ms and
 * flushing the DHT announce takes **40 seconds**. Awaiting the announce before
 * returning a workspace made every local operation wait on a network round
 * trip, which is not what local-first means. The logs are open and readable
 * long before the announce lands; peers arrive when they arrive.
 *
 * See the spike repo's `docs/network-conditions.md` for the measurements and
 * for why a resolved `joinTopic` does not currently prove the announce
 * succeeded.
 *
 * The returned promise is handed to the caller AND observed here, so a failed
 * announce can be inspected without ever becoming an unhandled rejection.
 * Attaching a handler is what marks it observed — a caller that ignores it is
 * therefore safe.
 */
function announceInBackground(runtime: P2PRuntime, topic: string): Promise<void> {
  // `swarm: false` runtimes are local-only and joining would throw. Nothing
  // else — logs, flush, hydrate, the folder on disk — is affected; the
  // workspace simply has no peers.
  if (runtime.replicates === false) return Promise.resolve();

  const announced = runtime.joinTopic(topic);
  announced.catch((e: unknown) => {
    // Terminal-visible, because a workspace that silently never announces
    // looks exactly like one with no peers nearby.
    // eslint-disable-next-line no-console
    console.warn(
      `[workspace] announce failed for ${topic.slice(0, 8)}…: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  });
  return announced;
}

export class Workspace {
  /** Stable workspace identifier — the root public key, hex. */
  readonly id: string;
  /** This peer's DID. */
  readonly did: Did;
  /** The workspace root authority DID. */
  readonly rootDid: Did;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly runtime: P2PRuntime;
  private readonly k0: Uint8Array;
  private readonly resource: string;
  private readonly folder: string;
  private readonly dataLog: Log; // K0_org-encrypted view
  private readonly keyDeliveryLog: Log;
  /** Binary content, K0_org-encrypted. Null on a pre-blob workspace. */
  private readonly blobLog: Log | null;
  /** Per-session content-hash cache, so one image written twice costs one copy. */
  private readonly blobsSeen = new Map<string, BlobRef>();
  // Root principal + secret are present only for the admin (creator); a
  // plain member opens without them and therefore cannot invite.
  private readonly root: Principal | null;
  private readonly listeners = new Set<ChangeListener>();
  /** Pending debounced flush, if a write has scheduled one. */
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set once close() has run, so a late timer cannot write to a closed log. */
  private closed = false;
  /**
   * Resolves once the swarm announce has landed; rejects if it failed.
   *
   * Nothing needs to await this to use the workspace — that is the point. It
   * exists so a caller that genuinely wants to know (a test, or a UI showing
   * "local only" versus "syncing") can ask, rather than guessing from silence.
   */
  readonly announced: Promise<void>;
  private offChange: (() => void) | null = null;
  private stopWatching: (() => void) | null = null;

  private constructor(args: {
    runtime: P2PRuntime;
    id: string;
    did: Did;
    rootDid: Did;
    k0: Uint8Array;
    resource: string;
    folder: string;
    dataLog: Log;
    keyDeliveryLog: Log;
    blobLog: Log | null;
    root: Principal | null;
    announced: Promise<void>;
  }) {
    this.runtime = args.runtime;
    this.id = args.id;
    this.did = args.did;
    this.rootDid = args.rootDid;
    this.k0 = args.k0;
    this.resource = args.resource;
    this.folder = args.folder;
    this.dataLog = args.dataLog;
    this.keyDeliveryLog = args.keyDeliveryLog;
    this.blobLog = args.blobLog;
    this.root = args.root;
    this.announced = args.announced;

    // Fan the underlying log's append event out to registered listeners.
    this.offChange = this.dataLog.on('append', () => {
      for (const cb of this.listeners) cb();
    });
  }

  /** True if this handle can invite members (i.e. holds the root key). */
  get isAdmin(): boolean {
    return this.root !== null;
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  static async create(opts: WorkspaceCreateOptions): Promise<Workspace> {
    const rootSeed = opts.rootSeed ?? randomSeed();
    // The creator's peer identity, which is NOT the workspace's root identity.
    // Defaults to the root seed so existing callers and tests are unchanged.
    const identitySeed = opts.identitySeed ?? rootSeed;
    const selfDid = didFromSeed(identitySeed);
    const root = await principalFromSeed(rootSeed);
    const rootKp = keyPairFromSeed(rootSeed);
    const rootSecretKey = rootKp.secretKey; // 64-byte sodium form
    const workspaceId = toHex(rootKp.publicKey);
    const rootDid = root.did();
    const resource = `workspace://v1/${workspaceId}`;

    // The workspace base key. The creator (admin) holds it; members receive
    // it via a sealed envelope.
    const k0 = randomBytes32();

    // The creator's own envelope. Built up front because the auth gate needs
    // the membership proof at runtime-construction time, and KEPT because
    // `open` recovers K0_org from exactly this envelope.
    //
    // It used to be built here, have its `.ucan` taken, and be discarded — so
    // the folder was written with no envelopes at all and the creator could
    // never reopen their own workspace. The creator's peer identity IS the
    // root identity in v1, but being root is not what `open` checks: it looks
    // for an envelope addressed to the opening DID, exactly as it does for
    // anyone else.
    //
    // Addressed to the CREATOR'S DEVICE, not to the root. Root issuing a
    // capability to a device is precisely the delegation `identity-recovery.md`
    // describes ("root → device, scoped + expiring"), and it is what lets the
    // two identities differ at all: `open` looks for an envelope addressed to
    // the opening device, so addressing it to the root only worked while the
    // two seeds were the same value (#317).
    const selfEnvelope = await createEnvelope(
      { did: selfDid, resource, key: k0, capability: CAP(resource) },
      root,
    );
    const localProof = selfEnvelope.ucan;

    const runtime = await opts.createRuntime({
      // No folder-based default: RocksDB must never live inside the
      // workspace folder (ADR 0003). Unset falls through to the runtime's
      // own default, a private temp directory.
      storage: opts.storage,
      // The device's identity on the swarm — the root keypair is the
      // workspace's identity and is not a peer.
      identitySeed,
      ...(opts.bootstrap ? { bootstrap: opts.bootstrap } : {}),
      auth: {
        localProof,
        verify: (remotePublicKey, remoteProof) =>
          verifyMembership({ proof: { ucan: remoteProof }, remotePublicKey, rootDid }).then(
            (v) => v.ok,
          ),
      },
    });

    // Well-known logs: a primary data log, the live key delivery log, and a
    // separate log for binary content. Blobs are kept out of the data log
    // because `entries()` reads that log in full on every change — see
    // ./blobs.ts.
    const rawDataLog = await runtime.createLog();
    const keyDeliveryLog = await runtime.createLog();
    const rawBlobLog = await runtime.createLog();

    // Persist the bundle (manifest + attestation + log keys) to the folder.
    const bundle = await createBundle({
      workspaceId,
      root,
      rootSecretKey,
      recipients: [],
      logs: {
        data: rawDataLog.key,
        keyDelivery: keyDeliveryLog.key,
        blobs: rawBlobLog.key,
      },
    });
    // Same push `invite` uses — the creator is a member of their own
    // workspace, and is recorded the same way every other member is.
    bundle.envelopes.push(selfEnvelope);
    await writeBundleFolder(bundle, opts.folder);

    const announced = announceInBackground(runtime, topicForWorkspace(workspaceId));

    const ws = new Workspace({
      runtime,
      announced,
      id: workspaceId,
      did: selfDid,
      rootDid,
      k0,
      resource,
      folder: opts.folder,
      dataLog: encryptedLog(rawDataLog, k0),
      keyDeliveryLog,
      blobLog: encryptedLog(rawBlobLog, k0),
      root,
    });
    // Materialise the (empty) transport dirs now: a created folder has the
    // full on-disk shape from its first second, not only after a first flush.
    await ws.flushStore();
    return ws;
  }

  // -------------------------------------------------------------------------
  // Open
  // -------------------------------------------------------------------------

  static async open(opts: WorkspaceOpenOptions): Promise<Workspace> {
    const bundle = await readBundleFolder(opts.folder);
    const manifest: Manifest = bundle.manifest;
    if (!manifest.logs) {
      throw new Error('workspace manifest has no log keys — cannot open (created by an older writer?)');
    }

    const selfDid = didFromSeed(opts.identitySeed);
    const selfSecretKey = keyPairFromSeed(opts.identitySeed).secretKey;

    // Consume the bundle: verify attestation, find our envelope, recover K0_org.
    const consumed = await consumeBundle(bundle, selfDid, selfSecretKey);
    if (!consumed.mine) {
      throw new Error(
        `no envelope addressed to ${selfDid} in this workspace — ask an admin to invite you`,
      );
    }
    const k0 = consumed.mine.key;
    const rootDid = consumed.rootDid;
    const workspaceId = consumed.workspaceId;
    const resource = consumed.mine.resource;

    // Our membership proof is the UCAN from our envelope.
    const myEnvelope = bundle.envelopes.find((e) => e.recipient === selfDid)!;
    const localProof = myEnvelope.ucan;

    const runtime = await opts.createRuntime({
      // No folder-based default: RocksDB must never live inside the
      // workspace folder (ADR 0003). Unset falls through to the runtime's
      // own default, a private temp directory.
      storage: opts.storage,
      identitySeed: opts.identitySeed,
      ...(opts.bootstrap ? { bootstrap: opts.bootstrap } : {}),
      auth: {
        localProof,
        verify: (remotePublicKey, remoteProof) =>
          verifyMembership({ proof: { ucan: remoteProof }, remotePublicKey, rootDid }).then(
            (v) => v.ok,
          ),
      },
    });

    // Hydrate the working store from the folder's transport form FIRST —
    // this is what makes a plain-copied folder open on a device that has
    // never met the writer (invariant 5). Tolerant per log: a folder with no
    // store, or a torn tail, hydrates what it can; replication heals the
    // rest.
    if (runtime.hydrateLogFromDir) {
      const keys = [manifest.logs.data, manifest.logs.keyDelivery, manifest.logs.blobs];
      for (const key of keys) {
        if (!key) continue;
        try {
          await runtime.hydrateLogFromDir(key, transportDir(opts.folder, key));
        } catch {
          /* hydration is best-effort by design */
        }
      }
    }

    const rawDataLog = await runtime.openLog(manifest.logs.data);
    const keyDeliveryLog = await runtime.openLog(manifest.logs.keyDelivery);
    // Absent on a workspace created before blob support. Opening still works;
    // only writing a blob fails, and it says why.
    const rawBlobLog = manifest.logs.blobs
      ? await runtime.openLog(manifest.logs.blobs)
      : null;

    const announced = announceInBackground(runtime, topicForWorkspace(workspaceId));

    return new Workspace({
      runtime,
      announced,
      id: workspaceId,
      did: selfDid,
      rootDid,
      k0,
      resource,
      folder: opts.folder,
      dataLog: encryptedLog(rawDataLog, k0),
      keyDeliveryLog,
      blobLog: rawBlobLog === null ? null : encryptedLog(rawBlobLog, k0),
      root: null,
    });
  }

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------

  /**
   * Invite a peer by DID: seal them an envelope carrying K0_org and a UCAN,
   * delivered via BOTH carriers — written into the `.workspace` folder
   * (offline first-contact) and published to the live key delivery log (for
   * peers already connected). Admin-only (requires the root key).
   */
  async invite(recipientDid: Did): Promise<void> {
    if (!this.root) {
      throw new Error('only an admin (root key holder) can invite members');
    }
    const envelope = await createEnvelope(
      { did: recipientDid, resource: this.resource, key: this.k0, capability: CAP(this.resource) },
      this.root,
    );
    // Offline carrier: add to the folder bundle.
    const bundle: Bundle = await readBundleFolder(this.folder);
    bundle.envelopes.push(envelope);
    await writeBundleFolder(bundle, this.folder);
    // Live carrier: publish to the key delivery log for connected peers.
    await publishDelivery(this.keyDeliveryLog, envelope);
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  /** Append an entry to the workspace's data log (sealed under K0_org). */
  async write(entry: Uint8Array): Promise<void> {
    await this.dataLog.append(entry);
    this.scheduleFlush();
  }

  /**
   * Write the log's portable copy into the folder, shortly after a write.
   *
   * The transport form under `.workspace/store/v1/` is what makes the folder
   * self-contained — invariant 5: a `cp -R` must produce a valid workspace.
   * It used to be written only by `close()`, and nothing closes a workspace:
   * quitting terminates the child, and since workspaces became live by default
   * they are not closed at all. Folders were left with a manifest and no log,
   * which opens as a workspace with no documents rather than failing (#341).
   *
   * Debounced rather than written per append. A flush replicates the whole log
   * into a capture replica, so doing it per keystroke would be wasteful; a
   * couple of seconds of quiet means the folder trails the log by seconds
   * instead of by a session.
   *
   * Failures are swallowed for the same reason `close()` swallows them: a
   * read-only or full folder must not break writing. The difference is that
   * the next write schedules another attempt, so a transient failure heals
   * rather than persisting until close.
   */
  private scheduleFlush(): void {
    if (this.closed) return;
    if (!this.runtime.flushLogToDir) return;
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.closed) return;
      void this.flushStore().catch(() => {
        // See above: the working store still holds everything, and the next
        // write tries again.
      });
    }, FLUSH_DEBOUNCE_MS);
    // Never hold the process open for a flush. Node and Bare both honour
    // unref; a host without it simply keeps its usual timer semantics.
    (this.flushTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** Read all entries, decrypted. */
  async entries(): Promise<Uint8Array[]> {
    // How far to read depends on whether a block could still arrive.
    //
    // A replicating peer MUST wait: hypercore cores are sparse, so a freshly
    // announced block is known-of before it is held, and `get()` fetching it
    // is the whole mechanism by which sync delivers anything. Stopping at the
    // downloaded prefix there would report an empty workspace whenever the
    // read raced the transfer.
    //
    // A local-only log must NOT wait: nobody can ever supply the block, so
    // `get()` past the verified prefix never returns. That is the shape a
    // folder with a corrupt or missing transport message hydrates into — and
    // stopping is also the right ANSWER, not merely the terminating one,
    // since a tail that failed verification must not fold in.
    const canReceive = this.runtime.replicates !== false;
    const readable = canReceive
      ? this.dataLog.length
      : (this.dataLog.contiguousLength ?? this.dataLog.length);
    const out: Uint8Array[] = [];
    for (let i = 0; i < readable; i++) {
      out.push(await this.dataLog.get(i));
    }
    return out;
  }

  /**
   * Store binary content and return a reference small enough to put in a
   * document entry. The bytes go to the blob log, not the data log.
   */
  async writeBlob(
    content: Uint8Array,
    options: { contentType?: string } = {},
  ): Promise<BlobRef> {
    if (this.blobLog === null) {
      throw new Error(
        'this workspace has no blob log — it was created before binary content ' +
          'was supported, so images and other files cannot be stored in it',
      );
    }
    return writeBlob(this.blobLog, content, { ...options, seen: this.blobsSeen });
  }

  /** Fetch the content a reference points at, verifying it against its hash. */
  async readBlob(ref: BlobRef): Promise<Uint8Array> {
    if (this.blobLog === null) {
      throw new Error('this workspace has no blob log — nothing to read from');
    }
    return readBlob(this.blobLog, ref);
  }

  /** Whether this workspace can store binary content. */
  get supportsBlobs(): boolean {
    return this.blobLog !== null;
  }

  /** Number of entries currently visible locally. */
  get length(): number {
    return this.dataLog.length;
  }

  /** Subscribe to "an entry was appended" (local or replicated). */
  on(event: 'change', cb: ChangeListener): () => void {
    if (event !== 'change') throw new Error(`unknown event: ${String(event)}`);
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Watch the working tree and report settled external changes.
   *
   * Reports raw bytes per path; it deliberately does not encode document
   * entries, because the log is a byte log and the document model belongs to
   * the consumer (`@workspace.sh/core`). Returns a stop function.
   *
   * NOTE for callers: this fires for OUR OWN writes too — the filesystem
   * cannot tell them apart. Whoever materialises the log to disk must filter
   * echoes before writing back, or the log grows without bound.
   */
  watchWorkingTree(onChange: (change: WorkingTreeChange) => void): () => void {
    const stop = watchWorkingTree(this.folder, onChange);
    this.stopWatching = stop;
    return stop;
  }

  /**
   * Read every watchable file in the working tree, once.
   *
   * The counterpart to `watchWorkingTree`, which reports only *changes* and so
   * can never see a file that merely exists. Without this, divergence that
   * happened while the workspace was closed is invisible, and the materialise
   * pass writes the log over it (#280).
   */
  listWorkingTree(options?: ListOptions): Promise<WorkingTreeEntry[]> {
    return listWorkingTree(this.folder, options);
  }

  /**
   * Flush every log to its transport form in `.workspace/store/v1/` —
   * what makes the folder a complete, portable copy (ADR 0003). Called
   * automatically on close; call it explicitly before sharing the folder.
   *
   * No-op (returning null) on a runtime that does not own a corestore.
   */
  async flushStore(): Promise<{ written: number } | null> {
    if (!this.runtime.flushLogToDir) return null;
    let written = 0;
    for (const log of [this.dataLog, this.keyDeliveryLog, this.blobLog]) {
      if (log === null) continue;
      const r = await this.runtime.flushLogToDir(log.key, transportDir(this.folder, log.key));
      written += r.written;
    }
    return { written };
  }

  async close(): Promise<void> {
    if (this.stopWatching) {
      this.stopWatching();
      this.stopWatching = null;
    }
    if (this.offChange) {
      this.offChange();
      this.offChange = null;
    }
    this.listeners.clear();
    this.closed = true;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      await this.flushStore();
    } catch {
      // Flush is durability icing, not correctness: the working store and
      // any replicated peers still hold everything. Close must not fail
      // because the folder was read-only or full.
    }
    await this.runtime.close();
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function randomSeed(): Uint8Array {
  return randomBytes32();
}

function randomBytes32(): Uint8Array {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return b;
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export {
  BlobIntegrityError,
  BlobSizeError,
  CHUNK_BYTES,
  isBlobRef,
  MAX_BLOB_BYTES,
  readBlob,
  writeBlob,
  type BlobRef,
} from './blobs.ts';

export {
  isWatchablePath,
  listWorkingTree,
  toWorkspaceRelative,
  watchWorkingTree,
  type ListOptions,
  type WatchOptions,
  type WorkingTreeChange,
  type WorkingTreeEntry,
} from './watcher.ts';
