// @workspace/portable-bootstrap
//
// Bundles a Workspace as a portable folder (or archive of one) carrying:
//   - a manifest binding workspaceId + createdAt + rootDid
//   - a root attestation signed by the rootDid (defeats tampering + replay)
//   - per-recipient bootstrap envelopes ({ucan, wrappedKey, resource} sealed
//     to each recipient's DID)
//
// This is the **offline / first-contact** carrier for permissions delivery.
// Distinct from the live key-delivery Hypercore log (issue #9), which handles
// ongoing churn between connected peers. Both carriers exist; they share the
// envelope shape and the underlying crypto.
//
// See:
//   - docs/workspace-format.md      — the on-disk format spec
//   - docs/permissions-model.md     — the protocol
//   - docs/threat-model.md          — what the attestation does and doesn't do

import {
  wrap,
  unwrap,
  signWorkspaceAttestation,
  verifyWorkspaceAttestation,
  publicKeyFromDid,
  type Did,
  type SignedAttestation,
  type AttestationPayload,
} from '@workspace/p2p-runtime';
import {
  issueDelegation,
  validateDelegation,
  toBytes as ucanToBytes,
  fromBytes as ucanFromBytes,
  principalFromSeed,
  type Principal,
  type DelegationToken,
  type RootForResource,
  type CapabilityDescriptor,
} from '@workspace/ucan-boundary';

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface Manifest {
  /** Schema version of the manifest itself. Currently 1. */
  formatVersion: number;
  /** Stable identifier for the workspace (e.g. UUID, content hash). */
  workspaceId: string;
  /** Creation time, whole-seconds-since-epoch. */
  createdAt: number;
  /** `did:key:z…` of the workspace's root. Subject of the attestation. */
  rootDid: Did;
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export interface Envelope {
  /** Recipient DID this envelope is addressed to. */
  recipient: Did;
  /** Resource URI the contained capability and key apply to. */
  resource: string;
  /** ucanto delegation, serialised. */
  ucan: Uint8Array;
  /** Symmetric key wrapped to the recipient's ed25519 public key. */
  wrappedKey: Uint8Array;
}

// ---------------------------------------------------------------------------
// Bundle (in-memory representation)
// ---------------------------------------------------------------------------

export interface Bundle {
  manifest: Manifest;
  attestation: SignedAttestation;
  envelopes: Envelope[];
}

// ---------------------------------------------------------------------------
// Creating a bundle
// ---------------------------------------------------------------------------

export interface RecipientInput {
  /** Recipient's stable identity. */
  did: Did;
  /** What resource URI the wrapped key + UCAN apply to. */
  resource: string;
  /** Symmetric key being delivered (typically 32 bytes for K0_org / K_n). */
  key: Uint8Array;
  /** The capability (typically `workspace/read` or similar). */
  capability: CapabilityDescriptor;
  /** Optional explicit expiration (whole-second epoch). Defaults to one year. */
  expiration?: number;
}

export interface CreateBundleInput {
  workspaceId: string;
  /** Defaults to `Math.floor(Date.now() / 1000)`. */
  createdAt?: number;
  /** Defaults to 1. */
  formatVersion?: number;
  /** Root principal — its DID becomes the workspace's root identity. */
  root: Principal;
  /** Root's 64-byte ed25519 secret key for signing the attestation. */
  rootSecretKey: Uint8Array;
  /** One envelope produced per recipient. */
  recipients: readonly RecipientInput[];
}

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * Default expiration: one year from now (whole-second epoch). Computed at
 * call time, not from a workspace's `createdAt` (which may be long ago for a
 * re-issued envelope delivering keys to a newly-joined peer).
 */
function defaultExpiration(): number {
  return Math.floor(Date.now() / 1000) + ONE_YEAR_SECONDS;
}

/**
 * Build a single sealed envelope: a UCAN delegation (root → recipient on the
 * resource) plus the symmetric key wrapped to the recipient's DID.
 *
 * This is the atom both carriers share — the offline bundle
 * (`createBundle`) packs many of these into `.workspace/envelopes/`; the live
 * key delivery log (`publishDelivery`) appends them one at a time. Same
 * shape, same crypto, same validation on the other side.
 */
export async function createEnvelope(
  input: RecipientInput,
  root: Principal,
): Promise<Envelope> {
  const expiration = input.expiration ?? defaultExpiration();
  const ucan = await issueDelegation({
    issuer: root,
    audience: input.did,
    capabilities: [input.capability],
    expiration,
  });
  const ucanBytes = await ucanToBytes(ucan);
  const recipientPublicKey = publicKeyFromDid(input.did);
  const wrappedKey = wrap(input.key, recipientPublicKey);
  return {
    recipient: input.did,
    resource: input.resource,
    ucan: ucanBytes,
    wrappedKey,
  };
}

/**
 * Produce a bundle in memory. No disk I/O — caller is responsible for
 * serialising and writing to wherever (`.workspace/` directory, archive, etc.).
 */
export async function createBundle(input: CreateBundleInput): Promise<Bundle> {
  const formatVersion = input.formatVersion ?? 1;
  const createdAt = Math.floor(input.createdAt ?? Date.now() / 1000);
  const rootDid = input.root.did();

  // Sanity: rootSecretKey's embedded pubkey must agree with input.root's DID.
  // (Catches the easy mistake of mixing up two keypairs at creation time.)
  if (input.rootSecretKey.length !== 64) {
    throw new Error(
      `rootSecretKey must be 64 bytes (sodium format), got ${input.rootSecretKey.length}`,
    );
  }

  const manifest: Manifest = {
    formatVersion,
    workspaceId: input.workspaceId,
    createdAt,
    rootDid,
  };

  const attestationPayload: AttestationPayload = {
    workspaceId: input.workspaceId,
    createdAt,
    formatVersion,
  };
  const attestation = signWorkspaceAttestation(attestationPayload, input.rootSecretKey);

  // Each recipient gets one sealed envelope. Same atom the live key delivery
  // log appends one-at-a-time — see createEnvelope.
  const envelopes: Envelope[] = await Promise.all(
    input.recipients.map((r) => createEnvelope(r, input.root)),
  );

  return { manifest, attestation, envelopes };
}

// ---------------------------------------------------------------------------
// Consuming a bundle
// ---------------------------------------------------------------------------

export interface ConsumedEnvelope {
  /** Resource URI this delivery applies to. */
  resource: string;
  /** The unwrapped symmetric key. */
  key: Uint8Array;
  /** The validated UCAN delegation token (audience verified against self). */
  ucan: DelegationToken;
  /** The capability the UCAN grants. */
  capability: CapabilityDescriptor;
}

export interface ConsumedBundle {
  workspaceId: string;
  rootDid: Did;
  /** The unwrapped envelope addressed to this peer, if one exists. */
  mine: ConsumedEnvelope | null;
}

export interface ConsumeBundleOptions {
  /** Override "now" in whole seconds — for tests. */
  now?: number;
}

export interface ConsumeEnvelopeOptions {
  /** Override "now" in whole seconds — for tests. */
  now?: number;
}

/**
 * Validate and unwrap a single envelope from one peer's perspective. The atom
 * both carriers share on the receiving side — `consumeBundle` calls it for the
 * envelope it finds on disk; `scanDeliveries` calls it for each delivery block
 * addressed to this peer.
 *
 *   1. Decode the UCAN; check its audience is this peer
 *   2. Validate the delegation chain terminates at the workspace root
 *      (`rootDid` is the canIssue authority)
 *   3. Unwrap the symmetric key with this peer's secret key
 *
 * Throws on audience mismatch, UCAN validation failure, or unwrap failure —
 * a partial trust signal is worse than refusing to proceed.
 */
export async function consumeEnvelope(
  envelope: Envelope,
  selfDid: Did,
  selfSecretKey: Uint8Array,
  rootDid: Did,
  opts: ConsumeEnvelopeOptions = {},
): Promise<ConsumedEnvelope> {
  if (selfSecretKey.length !== 64) {
    throw new Error(
      `selfSecretKey must be 64 bytes (sodium format), got ${selfSecretKey.length}`,
    );
  }
  const ucan = await ucanFromBytes(envelope.ucan);
  if (ucan.meta.audience !== selfDid) {
    throw new Error(
      `envelope UCAN audience mismatch: expected ${selfDid}, got ${ucan.meta.audience}`,
    );
  }
  const rootForResource: RootForResource = () => rootDid;
  const validation = await validateDelegation(ucan, {
    rootForResource,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  if (!validation.ok) {
    throw new Error(`envelope UCAN validation failed: ${validation.error}`);
  }
  const key = unwrap(envelope.wrappedKey, selfSecretKey);
  return {
    resource: envelope.resource,
    key,
    ucan,
    capability: validation.capability,
  };
}

/**
 * Consume a bundle from the perspective of a single peer:
 *   1. Verify the root attestation defeats tampering + replay
 *   2. Find the envelope addressed to this peer's DID, if any
 *   3. Validate the UCAN inside, with the workspace's root as the canIssue authority
 *   4. Unwrap the symmetric key
 *
 * Throws on attestation failure (the manifest cannot be trusted). Returns
 * `mine: null` if no envelope is addressed to this peer (their existence in
 * the workspace is still possible — they may receive keys via the live
 * delivery log instead). Throws on envelope-level integrity failure (a
 * partial trust signal would be worse than refusing to proceed).
 */
export async function consumeBundle(
  bundle: Bundle,
  selfDid: Did,
  selfSecretKey: Uint8Array,
  opts: ConsumeBundleOptions = {},
): Promise<ConsumedBundle> {
  if (selfSecretKey.length !== 64) {
    throw new Error(
      `selfSecretKey must be 64 bytes (sodium format), got ${selfSecretKey.length}`,
    );
  }

  // Step 1: verify attestation. Without this, nothing in the bundle is
  // trustworthy — any field could have been tampered with after distribution.
  if (!verifyWorkspaceAttestation(bundle.attestation)) {
    throw new Error('bundle attestation verification failed — refusing to proceed');
  }
  // Attestation's payload must match the manifest. Otherwise the attestation
  // is for a different workspace and the manifest cannot be trusted.
  if (
    bundle.attestation.payload.workspaceId !== bundle.manifest.workspaceId ||
    bundle.attestation.payload.createdAt !== bundle.manifest.createdAt ||
    bundle.attestation.payload.formatVersion !== bundle.manifest.formatVersion ||
    bundle.attestation.rootDid !== bundle.manifest.rootDid
  ) {
    throw new Error(
      'bundle attestation payload does not match manifest — refusing to proceed',
    );
  }

  // Step 2: find envelope.
  const myEnvelope = bundle.envelopes.find((e) => e.recipient === selfDid);
  if (!myEnvelope) {
    return {
      workspaceId: bundle.manifest.workspaceId,
      rootDid: bundle.manifest.rootDid,
      mine: null,
    };
  }

  // Steps 3–4: validate the UCAN against the workspace root and unwrap the
  // key. Shared with the live key delivery log via consumeEnvelope.
  const mine = await consumeEnvelope(
    myEnvelope,
    selfDid,
    selfSecretKey,
    bundle.manifest.rootDid,
    opts.now !== undefined ? { now: opts.now } : {},
  );

  return {
    workspaceId: bundle.manifest.workspaceId,
    rootDid: bundle.manifest.rootDid,
    mine,
  };
}

// ---------------------------------------------------------------------------
// Serialisation — JSON-friendly form for disk
// ---------------------------------------------------------------------------

/** Serialised form of a bundle, ready to JSON.stringify. */
export interface SerialisedBundle {
  manifest: Manifest;
  attestation: SerialisedAttestation;
  envelopes: SerialisedEnvelope[];
}

interface SerialisedAttestation {
  payload: AttestationPayload;
  payloadBytes: string; // base64
  signature: string; // base64
  rootDid: Did;
}

export interface SerialisedEnvelope {
  recipient: Did;
  resource: string;
  ucan: string; // base64
  wrappedKey: string; // base64
}

/** Serialise a single envelope to a plain JSON-able object. */
export function serialiseEnvelope(e: Envelope): SerialisedEnvelope {
  return {
    recipient: e.recipient,
    resource: e.resource,
    ucan: bytesToBase64(e.ucan),
    wrappedKey: bytesToBase64(e.wrappedKey),
  };
}

/** Restore a single envelope from its serialised form. */
export function deserialiseEnvelope(s: SerialisedEnvelope): Envelope {
  return {
    recipient: s.recipient,
    resource: s.resource,
    ucan: base64ToBytes(s.ucan),
    wrappedKey: base64ToBytes(s.wrappedKey),
  };
}

/** Serialise a bundle to a plain JSON-able object. */
export function serialiseBundle(bundle: Bundle): SerialisedBundle {
  return {
    manifest: bundle.manifest,
    attestation: {
      payload: bundle.attestation.payload,
      payloadBytes: bytesToBase64(bundle.attestation.payloadBytes),
      signature: bytesToBase64(bundle.attestation.signature),
      rootDid: bundle.attestation.rootDid,
    },
    envelopes: bundle.envelopes.map(serialiseEnvelope),
  };
}

/** Restore a bundle from its serialised form. */
export function deserialiseBundle(s: SerialisedBundle): Bundle {
  return {
    manifest: s.manifest,
    attestation: {
      payload: s.attestation.payload,
      payloadBytes: base64ToBytes(s.attestation.payloadBytes),
      signature: base64ToBytes(s.attestation.signature),
      rootDid: s.attestation.rootDid,
    },
    envelopes: s.envelopes.map(deserialiseEnvelope),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

// Convenience re-exports so callers don't need to import basic types from
// @workspace/ucan-boundary directly when starting a bundle workflow.
export { principalFromSeed };
export type { CapabilityDescriptor, DelegationToken, Principal } from '@workspace/ucan-boundary';

// Filesystem pack/unpack — write a bundle to a `.workspace/` folder layout
// per docs/workspace-format.md and read it back.
export { writeBundleFolder, readBundleFolder } from './folder.ts';

// Live key delivery log (#9) — the second carrier. Publishes envelopes to a
// replicated Hypercore log and scans it for deliveries addressed to a peer.
export { publishDelivery, scanDeliveries } from './key-delivery.ts';
export type { Delivery, ScanResult, ScanDeliveriesOptions } from './key-delivery.ts';

// Topic-layer auth (#10) — the connect-time membership gate. Decides whether
// to accept a swarm connection from a peer presenting a UCAN membership proof.
export { verifyMembership, createMembershipProof } from './membership.ts';
export type {
  MembershipProof,
  VerifyMembershipInput,
  MembershipVerdict,
} from './membership.ts';
