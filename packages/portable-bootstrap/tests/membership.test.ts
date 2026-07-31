// Tests for topic-layer membership auth (#10) — src/membership.ts.
//
// verifyMembership is the security core of the connect-time gate. These tests
// hammer the rejection paths, because that's where the security lives: a
// valid member must be accepted, and every flavour of invalid peer — replay,
// revoked, expired, wrong-root, garbage — must be rejected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { principalFromSeed } from '@workspace.sh/ucan-boundary';
import {
  createEnvelope,
  createMembershipProof,
  verifyMembership,
  type CapabilityDescriptor,
} from '../src/index.ts';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hypercoreCrypto = require('hypercore-crypto') as any;

function seededKey(byte: number): { publicKey: Buffer; secretKey: Buffer } {
  const seed = new Uint8Array(32);
  seed.fill(byte);
  return hypercoreCrypto.keyPair(Buffer.from(seed)) as {
    publicKey: Buffer;
    secretKey: Buffer;
  };
}

const dummyKey = new Uint8Array(32); // membership cares about the UCAN, not the wrapped key

// Build a fixture: a workspace root, a resource, a read capability, and a
// helper to mint a membership proof (root → audience delegation bytes).
async function fixture() {
  const rootKp = seededKey(1);
  const root = await principalFromSeed(rootKp.secretKey.subarray(0, 32));
  const workspaceId = rootKp.publicKey.toString('hex');
  const resource = `workspace://v1/${workspaceId}`;
  const capability: CapabilityDescriptor = { can: 'workspace/read', with: resource };

  async function proofFor(
    audienceDid: ReturnType<Awaited<ReturnType<typeof principalFromSeed>>['did']>,
    issuer = root,
    expiration?: number,
  ) {
    const env = await createEnvelope(
      { did: audienceDid, resource, key: dummyKey, capability, ...(expiration !== undefined ? { expiration } : {}) },
      issuer,
    );
    return createMembershipProof(env.ucan);
  }

  return { rootKp, root, resource, capability, proofFor };
}

// ---------------------------------------------------------------------------
// Accept the legitimate member
// ---------------------------------------------------------------------------

test('valid member: accepted, verdict carries the verified DID + capability', async () => {
  const { root, proofFor } = await fixture();
  const memberKp = seededKey(2);
  const member = await principalFromSeed(memberKp.secretKey.subarray(0, 32));

  const proof = await proofFor(member.did());
  const verdict = await verifyMembership({
    proof,
    remotePublicKey: memberKp.publicKey,
    rootDid: root.did(),
  });

  assert.equal(verdict.ok, true);
  assert.equal(verdict.did, member.did());
  assert.ok(verdict.capability);
});

// ---------------------------------------------------------------------------
// Replay: a sniffed UCAN presented on someone else's connection
// ---------------------------------------------------------------------------

test('replay: a proof for member A presented on member B-authenticated connection is rejected', async () => {
  const { root, proofFor } = await fixture();
  const memberKp = seededKey(2);
  const attackerKp = seededKey(3);
  const member = await principalFromSeed(memberKp.secretKey.subarray(0, 32));

  // The attacker sniffed the member's UCAN and presents it — but the Noise
  // handshake authenticated the attacker's OWN key, not the member's.
  const stolenProof = await proofFor(member.did());
  const verdict = await verifyMembership({
    proof: stolenProof,
    remotePublicKey: attackerKp.publicKey, // attacker's authenticated identity
    rootDid: root.did(),
  });

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason!, /does not match connection identity/);
});

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

test('revoked: a member with a valid UCAN is rejected when isRevoked returns true', async () => {
  const { root, proofFor } = await fixture();
  const memberKp = seededKey(2);
  const member = await principalFromSeed(memberKp.secretKey.subarray(0, 32));

  const proof = await proofFor(member.did());
  const verdict = await verifyMembership({
    proof,
    remotePublicKey: memberKp.publicKey,
    rootDid: root.did(),
    isRevoked: (did) => did === member.did(),
  });

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason!, /revoked/);
});

test('not revoked: isRevoked returning false for this DID still accepts', async () => {
  const { root, proofFor } = await fixture();
  const memberKp = seededKey(2);
  const other = seededKey(8);
  const member = await principalFromSeed(memberKp.secretKey.subarray(0, 32));
  const otherPrincipal = await principalFromSeed(other.secretKey.subarray(0, 32));

  const proof = await proofFor(member.did());
  const verdict = await verifyMembership({
    proof,
    remotePublicKey: memberKp.publicKey,
    rootDid: root.did(),
    isRevoked: (did) => did === otherPrincipal.did(), // someone else is revoked
  });

  assert.equal(verdict.ok, true);
});

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

test('expired: a UCAN whose expiration is in the past is rejected', async () => {
  const { root, proofFor } = await fixture();
  const memberKp = seededKey(2);
  const member = await principalFromSeed(memberKp.secretKey.subarray(0, 32));

  const pastExpiry = Math.floor(Date.now() / 1000) - 100;
  const proof = await proofFor(member.did(), root, pastExpiry);

  const verdict = await verifyMembership({
    proof,
    remotePublicKey: memberKp.publicKey,
    rootDid: root.did(),
  });

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason!, /validation failed/);
});

// ---------------------------------------------------------------------------
// Wrong root
// ---------------------------------------------------------------------------

test('wrong root: a UCAN delegated by a non-root issuer is rejected', async () => {
  const { root, proofFor } = await fixture();
  const fakeRootKp = seededKey(9);
  const fakeRoot = await principalFromSeed(fakeRootKp.secretKey.subarray(0, 32));
  const memberKp = seededKey(2);
  const member = await principalFromSeed(memberKp.secretKey.subarray(0, 32));

  // Proof issued by fakeRoot, but verified against the real workspace root.
  const proof = await proofFor(member.did(), fakeRoot);
  const verdict = await verifyMembership({
    proof,
    remotePublicKey: memberKp.publicKey,
    rootDid: root.did(),
  });

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason!, /validation failed/);
});

// ---------------------------------------------------------------------------
// Malformed inputs are rejections, not exceptions
// ---------------------------------------------------------------------------

test('garbage proof: undecodable UCAN bytes are rejected, not thrown', async () => {
  const { root } = await fixture();
  const memberKp = seededKey(2);
  const verdict = await verifyMembership({
    proof: { ucan: new Uint8Array([1, 2, 3, 4]) },
    remotePublicKey: memberKp.publicKey,
    rootDid: root.did(),
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason!, /undecodable proof/);
});

test('bad remote key: a wrong-length public key is rejected, not thrown', async () => {
  const { root, proofFor } = await fixture();
  const memberKp = seededKey(2);
  const member = await principalFromSeed(memberKp.secretKey.subarray(0, 32));
  const proof = await proofFor(member.did());

  const verdict = await verifyMembership({
    proof,
    remotePublicKey: new Uint8Array(16), // not a 32-byte ed25519 key
    rootDid: root.did(),
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason!, /bad remote key/);
});
