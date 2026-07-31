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

import { createHash } from 'node:crypto';

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
  /** 32-byte seed fixing the workspace root identity. Defaults to random. */
  rootSeed?: Uint8Array;
  /** Corestore storage path. Defaults to `<folder>/.workspace/store`. */
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
  /** Corestore storage path. Defaults to `<folder>/.workspace/store`. */
  storage?: string;
  bootstrap?: Bootstrap;
}

type ChangeListener = () => void;

const CAP: (resource: string) => CapabilityDescriptor = (resource) => ({
  can: 'workspace/read',
  with: resource,
});

/** Derive the swarm topic deterministically from the workspaceId. */
function topicForWorkspace(workspaceId: string): string {
  return createHash('sha256').update(`workspace://${workspaceId}`).digest('hex');
}

function defaultStorage(folder: string): string {
  return `${folder}/.workspace/store`;
}

/**
 * A live workspace handle. Obtain one via `Workspace.create` or
 * `Workspace.open`; release it with `close()`.
 */
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
  // Root principal + secret are present only for the admin (creator); a
  // plain member opens without them and therefore cannot invite.
  private readonly root: Principal | null;
  private readonly listeners = new Set<ChangeListener>();
  private offChange: (() => void) | null = null;

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
    root: Principal | null;
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
    this.root = args.root;

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
    const root = await principalFromSeed(rootSeed);
    const rootKp = keyPairFromSeed(rootSeed);
    const rootSecretKey = rootKp.secretKey; // 64-byte sodium form
    const workspaceId = toHex(rootKp.publicKey);
    const rootDid = root.did();
    const resource = `workspace://v1/${workspaceId}`;

    // The workspace base key. The creator (admin) holds it; members receive
    // it via a sealed envelope.
    const k0 = randomBytes32();

    // Build the admin's own membership proof (root self-delegation) up front —
    // it's derivable from the seed, so the auth gate can be wired at runtime
    // construction. The creator's peer identity IS the root identity in v1.
    const localProof = (
      await createEnvelope({ did: rootDid, resource, key: k0, capability: CAP(resource) }, root)
    ).ucan;

    const runtime = await opts.createRuntime({
      storage: opts.storage ?? defaultStorage(opts.folder),
      identitySeed: rootSeed,
      ...(opts.bootstrap ? { bootstrap: opts.bootstrap } : {}),
      auth: {
        localProof,
        verify: (remotePublicKey, remoteProof) =>
          verifyMembership({ proof: { ucan: remoteProof }, remotePublicKey, rootDid }).then(
            (v) => v.ok,
          ),
      },
    });

    // Well-known logs: a primary data log + the live key delivery log.
    const rawDataLog = await runtime.createLog();
    const keyDeliveryLog = await runtime.createLog();

    // Persist the bundle (manifest + attestation + log keys) to the folder.
    const bundle = await createBundle({
      workspaceId,
      root,
      rootSecretKey,
      recipients: [],
      logs: { data: rawDataLog.key, keyDelivery: keyDeliveryLog.key },
    });
    await writeBundleFolder(bundle, opts.folder);

    await runtime.joinTopic(topicForWorkspace(workspaceId));

    return new Workspace({
      runtime,
      id: workspaceId,
      did: rootDid,
      rootDid,
      k0,
      resource,
      folder: opts.folder,
      dataLog: encryptedLog(rawDataLog, k0),
      keyDeliveryLog,
      root,
    });
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
      storage: opts.storage ?? defaultStorage(opts.folder),
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

    const rawDataLog = await runtime.openLog(manifest.logs.data);
    const keyDeliveryLog = await runtime.openLog(manifest.logs.keyDelivery);

    await runtime.joinTopic(topicForWorkspace(workspaceId));

    return new Workspace({
      runtime,
      id: workspaceId,
      did: selfDid,
      rootDid,
      k0,
      resource,
      folder: opts.folder,
      dataLog: encryptedLog(rawDataLog, k0),
      keyDeliveryLog,
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
  }

  /** Read all entries, decrypted. */
  async entries(): Promise<Uint8Array[]> {
    const out: Uint8Array[] = [];
    for (let i = 0; i < this.dataLog.length; i++) {
      out.push(await this.dataLog.get(i));
    }
    return out;
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

  async close(): Promise<void> {
    if (this.offChange) {
      this.offChange();
      this.offChange = null;
    }
    this.listeners.clear();
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
