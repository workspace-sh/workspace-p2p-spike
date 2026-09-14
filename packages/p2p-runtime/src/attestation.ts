// Root attestation for portable Workspace bundles.
//
// A root attestation is a signature by the workspace's root DID over a small
// canonical payload binding workspace identity to creation time. It defeats:
//
//   - Tampering of the manifest after distribution
//   - Replay of stale workspaces (e.g. resurrecting a deleted org)
//
// It does **not** defeat fraudulent identity claims — verifying that a given
// `did:key:zABC…` is genuinely "Acme's org root" still requires an
// out-of-band channel (signed announcement, well-known URL, fingerprint
// comparison). See `docs/threat-model.md` for the explicit framing.
//
// The signatures are ed25519 via `hypercore-crypto`, the algorithm the UCAN
// boundary verifies with @noble/ed25519. Either implementation verifies the
// other's signatures.

import b4a from 'b4a';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import hypercoreCryptoModule from 'hypercore-crypto';
import type { Did } from './types.ts';
import { didFromPublicKey, publicKeyFromDid } from './did.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hypercoreCrypto = hypercoreCryptoModule as any;

// ---------------------------------------------------------------------------
// Low-level: sign/verify arbitrary bytes with an ed25519 keypair
// ---------------------------------------------------------------------------

/**
 * Sign arbitrary bytes with an ed25519 secret key.
 *
 * @param message    Bytes to sign
 * @param secretKey  64-byte ed25519 secret key (sodium format: 32-byte seed || 32-byte pubkey)
 * @returns          64-byte ed25519 signature
 */
export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  if (secretKey.length !== 64) {
    throw new Error(
      `ed25519 secret key must be 64 bytes (sodium format: 32-byte seed + 32-byte pubkey), got ${secretKey.length}`,
    );
  }
  const sig = hypercoreCrypto.sign(b4a.from(message), b4a.from(secretKey)) as Uint8Array;
  return new Uint8Array(sig);
}

/**
 * Verify an ed25519 signature against the given public key.
 *
 * @returns true if the signature is valid; false otherwise.
 */
export function verify(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  if (publicKey.length !== 32) {
    throw new Error(`ed25519 public key must be 32 bytes, got ${publicKey.length}`);
  }
  if (signature.length !== 64) {
    throw new Error(`ed25519 signature must be 64 bytes, got ${signature.length}`);
  }
  return hypercoreCrypto.verify(
    b4a.from(message),
    b4a.from(signature),
    b4a.from(publicKey),
  ) as boolean;
}

// ---------------------------------------------------------------------------
// Workspace attestation
// ---------------------------------------------------------------------------

/** The payload signed by the root DID. */
export interface AttestationPayload {
  /** The workspace's identifier: its root DID's multibase key. */
  workspaceId: string;
  /** Workspace creation time, whole-seconds-since-epoch. */
  createdAt: number;
  /** `.workspace/` format version this attestation was issued under. */
  formatVersion: number;
  /** The Hyperswarm topic peers meet on, 64 hex characters. */
  topicId: string;
  /** The Hypercore keys (hex) of the workspace's well-known logs. */
  logs?: AttestedLogs;
}

/** The logs a manifest names, as the attestation signs them. */
export interface AttestedLogs {
  data: string;
  keyDelivery: string;
  blobs?: string;
}

/** A signed attestation, suitable for persistence and offline verification. */
export interface SignedAttestation {
  /** Convenience: the parsed payload. */
  payload: AttestationPayload;
  /** Canonical bytes that were signed. Re-computable from `payload`. */
  payloadBytes: Uint8Array;
  /** 64-byte ed25519 signature. */
  signature: Uint8Array;
  /** `did:key:z…` of the signer. The verifier extracts the public key from this. */
  rootDid: Did;
}

/**
 * Produce the canonical bytes for an attestation payload.
 *
 * UTF-8 JSON with no whitespace and every object's keys in alphabetical
 * order, written out field by field so the bytes never depend on the order a
 * caller built the object in. Optional fields that are absent are left out.
 */
export function buildAttestationPayload(p: AttestationPayload): Uint8Array {
  const logs =
    p.logs === undefined
      ? ''
      : `"logs":{${p.logs.blobs === undefined ? '' : `"blobs":${JSON.stringify(p.logs.blobs)},`}"data":${JSON.stringify(
          p.logs.data,
        )},"keyDelivery":${JSON.stringify(p.logs.keyDelivery)}},`;
  const canonical = `{"createdAt":${Math.floor(p.createdAt)},"formatVersion":${p.formatVersion},${logs}"topicId":${JSON.stringify(
    p.topicId,
  )},"workspaceId":${JSON.stringify(p.workspaceId)}}`;
  // b4a rather than TextEncoder: Bare has no such global (#243).
  return b4a.from(canonical);
}

/**
 * Sign a workspace attestation with the root's ed25519 secret key.
 *
 * The `rootDid` field is derived from the secret key's embedded public key,
 * so the caller does not need to pass it separately.
 */
export function signWorkspaceAttestation(
  payload: AttestationPayload,
  rootSecretKey: Uint8Array,
): SignedAttestation {
  if (rootSecretKey.length !== 64) {
    throw new Error(
      `ed25519 secret key must be 64 bytes (sodium format), got ${rootSecretKey.length}`,
    );
  }
  const payloadBytes = buildAttestationPayload(payload);
  const signature = sign(payloadBytes, rootSecretKey);
  // Sodium-format secret key: bytes 32..64 are the public key.
  const rootPublicKey = rootSecretKey.subarray(32, 64);
  const rootDid = didFromPublicKey(rootPublicKey);
  return {
    payload: {
      workspaceId: payload.workspaceId,
      createdAt: Math.floor(payload.createdAt),
      formatVersion: payload.formatVersion,
      topicId: payload.topicId,
      ...(payload.logs === undefined ? {} : { logs: attestedLogs(payload.logs) }),
    },
    payloadBytes,
    signature,
    rootDid,
  };
}

/** Only the fields the attestation signs, so a wider object signs the same bytes it stores. */
function attestedLogs(logs: AttestedLogs): AttestedLogs {
  return {
    data: logs.data,
    keyDelivery: logs.keyDelivery,
    ...(logs.blobs === undefined ? {} : { blobs: logs.blobs }),
  };
}

/**
 * Verify a workspace attestation: re-compute the canonical payload bytes
 * from `att.payload`, decode the root DID to a public key, and check the
 * signature.
 *
 * Returns `true` only if the payload matches what was signed AND the
 * signature is valid against the claimed root DID. Returns `false` for any
 * mismatch (tampered payload, tampered signature, wrong-key claim).
 *
 * Caveat: this does not prove that `rootDid` belongs to the legitimate
 * workspace owner. That trust comes from an out-of-band channel — see
 * `docs/threat-model.md` "What Workspace does not protect."
 */
export function verifyWorkspaceAttestation(att: SignedAttestation): boolean {
  // Re-derive the canonical payload bytes and ensure they match what's stored.
  // (If att.payloadBytes was tampered with, the signature would fail anyway,
  // but this catches mismatches earlier and produces a clearer "tampered
  // payload" outcome.)
  const recomputed = buildAttestationPayload(att.payload);
  if (
    recomputed.length !== att.payloadBytes.length ||
    !uint8ArraysEqual(recomputed, att.payloadBytes)
  ) {
    return false;
  }
  const publicKey = publicKeyFromDid(att.rootDid);
  return verify(att.payloadBytes, att.signature, publicKey);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uint8ArraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
