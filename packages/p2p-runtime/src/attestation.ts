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
// The signature lineage is ed25519 via `hypercore-crypto`, the same algorithm
// used by ucanto's @noble/ed25519. Signatures produced here can be verified
// by either implementation (and vice versa).

import { createRequire } from 'node:module';
import type { Did } from './types.ts';
import { didFromPublicKey, publicKeyFromDid } from './did.ts';

const require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hypercoreCrypto = require('hypercore-crypto') as any;

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
  const sig = hypercoreCrypto.sign(Buffer.from(message), Buffer.from(secretKey)) as Buffer;
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
    Buffer.from(message),
    Buffer.from(signature),
    Buffer.from(publicKey),
  ) as boolean;
}

// ---------------------------------------------------------------------------
// Workspace attestation
// ---------------------------------------------------------------------------

/** The payload signed by the root DID. */
export interface AttestationPayload {
  /** Stable workspace identifier (e.g. a UUIDv4 or a content-derived hash). */
  workspaceId: string;
  /** Workspace creation time, whole-seconds-since-epoch. */
  createdAt: number;
  /** `_workspace/` format version this attestation was issued under. */
  formatVersion: number;
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
 * Canonicalisation rule for v1: explicit field order (alphabetical), no
 * whitespace, UTF-8 encoded JSON. Sufficient because the payload shape is
 * fixed; if the payload ever grows nested or open-ended, switch to a proper
 * canonical-JSON or CBOR encoding.
 */
export function buildAttestationPayload(p: AttestationPayload): Uint8Array {
  // Explicit alphabetical key order — do NOT rely on object literal order.
  const canonical = `{"createdAt":${Math.floor(p.createdAt)},"formatVersion":${
    p.formatVersion
  },"workspaceId":${JSON.stringify(p.workspaceId)}}`;
  return new TextEncoder().encode(canonical);
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
    },
    payloadBytes,
    signature,
    rootDid,
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
