// Topic-layer authentication (#10) — the connect-time membership gate.
//
// Encryption keeps a departed or non-member peer from READING content. This
// is the second, distinct lever: keeping them from CONNECTING at all. An org
// peer rejects swarm connections from anyone who cannot present a current,
// valid UCAN proving workspace membership.
//
// The security hinges on binding the presented UCAN to the actual connection.
// Hyperswarm's Noise handshake cryptographically authenticates each peer's
// static public key — so the accepting side KNOWS the remote peer controls
// `remotePublicKey`. We derive the peer's DID from that key and require the
// presented UCAN's audience to equal it. A UCAN sniffed off someone else's
// connection is useless: its audience won't match the replayer's authenticated
// key. No separate challenge-response needed — the handshake is the challenge.
//
// This module is pure and transport-agnostic: it decides accept/reject given
// an authenticated key + a presented proof. The runtime wires it into the
// connection handler (sending/receiving proofs over the wire, calling
// verifyMembership, replicating only on a positive verdict). Keeping the
// decision logic here — independent of Hyperswarm — makes it fully testable
// without a network.
//
// See docs/permissions-model.md ("Lever 2 — Topic-layer") and
// docs/threat-model.md.

import {
  fromBytes as ucanFromBytes,
  validateDelegation,
  type RootForResource,
  type CapabilityDescriptor,
} from '@workspace/ucan-boundary';
import { didFromPublicKey, type Did } from '@workspace/p2p-runtime';

/**
 * What a connecting peer presents to prove membership. Today: the UCAN
 * delegation (audience == the peer's DID) that the peer holds from their
 * bundle envelope or a key delivery. Wrapped in a struct so the proof can
 * grow later (e.g. a signed connection nonce) without changing call sites.
 */
export interface MembershipProof {
  /** Serialised UCAN delegation bytes (as produced by `toBytes`). */
  ucan: Uint8Array;
}

/** Build a membership proof from a peer's UCAN delegation bytes. */
export function createMembershipProof(ucanBytes: Uint8Array): MembershipProof {
  return { ucan: ucanBytes };
}

export interface VerifyMembershipInput {
  /** The proof the connecting peer presented. */
  proof: MembershipProof;
  /**
   * The remote peer's Noise static public key (32-byte ed25519), as
   * authenticated by the Hyperswarm handshake. This is the trust anchor —
   * the handshake proves the peer controls the matching secret key.
   */
  remotePublicKey: Uint8Array;
  /** The workspace root DID — the canIssue authority the chain must reach. */
  rootDid: Did;
  /** Override "now" in whole seconds — for tests. */
  now?: number;
  /**
   * Optional revocation check. Returns true if the given DID has been
   * revoked (e.g. it appears in a revocation block on the key delivery log).
   * A revoked peer is rejected even with an otherwise-valid UCAN.
   */
  isRevoked?: (did: Did) => boolean;
}

export interface MembershipVerdict {
  /** Whether the connection should be accepted. */
  ok: boolean;
  /** The verified member DID (derived from the authenticated key). Set iff ok. */
  did?: Did;
  /** The capability the membership UCAN grants. Set iff ok. */
  capability?: CapabilityDescriptor;
  /** Human-readable rejection reason. Set iff !ok. */
  reason?: string;
}

/**
 * Decide whether to accept a connection from a peer presenting `proof`.
 *
 * Steps, in order (cheapest / most decisive first):
 *   1. Derive the peer's DID from the authenticated Noise key.
 *   2. Require the proof's UCAN audience to equal that DID — this is the
 *      binding that defeats replay of a sniffed UCAN.
 *   3. Reject if the DID is revoked.
 *   4. Validate the delegation chain terminates at the workspace root and is
 *      unexpired (UCAN expiry is whole-seconds — handled by the boundary).
 *
 * Never throws on a bad proof — returns `{ ok: false, reason }`. A malformed
 * proof is a rejection, not an exception, so the caller's connection handler
 * stays simple.
 */
export async function verifyMembership(
  input: VerifyMembershipInput,
): Promise<MembershipVerdict> {
  let peerDid: Did;
  try {
    peerDid = didFromPublicKey(input.remotePublicKey);
  } catch (err) {
    return { ok: false, reason: `bad remote key: ${(err as Error).message}` };
  }

  let ucan;
  try {
    ucan = await ucanFromBytes(input.proof.ucan);
  } catch (err) {
    return { ok: false, reason: `undecodable proof: ${(err as Error).message}` };
  }

  if (ucan.meta.audience !== peerDid) {
    // The presented credential was issued to a different DID than the one
    // this connection authenticated. Classic replay attempt — reject.
    return {
      ok: false,
      reason: `proof audience ${ucan.meta.audience} does not match connection identity ${peerDid}`,
    };
  }

  if (input.isRevoked?.(peerDid)) {
    return { ok: false, reason: `peer ${peerDid} is revoked` };
  }

  const rootForResource: RootForResource = () => input.rootDid;
  const validation = await validateDelegation(ucan, {
    rootForResource,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  if (!validation.ok) {
    return { ok: false, reason: `UCAN validation failed: ${validation.error}` };
  }

  return { ok: true, did: peerDid, capability: validation.capability };
}
