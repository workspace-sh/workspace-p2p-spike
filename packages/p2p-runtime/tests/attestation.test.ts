// Tests for src/attestation.ts.
//
// Covers low-level sign/verify (round-trip, wrong-key rejection, tamper
// detection on payload and signature, input validation) and the workspace-
// attestation flow (canonical-payload determinism, sign + verify round-trip,
// rootDid derivation, tampered-field rejection).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  sign,
  verify,
  buildAttestationPayload,
  signWorkspaceAttestation,
  verifyWorkspaceAttestation,
  type AttestationPayload,
} from '../src/attestation.ts';
import { didFromSeed, publicKeyFromDid } from '../src/did.ts';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hypercoreCrypto = require('hypercore-crypto') as any;

function keypair(): { publicKey: Buffer; secretKey: Buffer } {
  return hypercoreCrypto.keyPair() as { publicKey: Buffer; secretKey: Buffer };
}

const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// Low-level sign/verify
// ---------------------------------------------------------------------------

test('sign/verify: round-trip succeeds with the right keypair', () => {
  const kp = keypair();
  const sig = sign(enc.encode('payload'), kp.secretKey);
  assert.equal(sig.length, 64);
  assert.equal(verify(enc.encode('payload'), sig, kp.publicKey), true);
});

test('sign/verify: wrong public key rejects', () => {
  const a = keypair();
  const b = keypair();
  const sig = sign(enc.encode('hello'), a.secretKey);
  assert.equal(verify(enc.encode('hello'), sig, b.publicKey), false);
});

test('sign/verify: tampered message rejects', () => {
  const kp = keypair();
  const sig = sign(enc.encode('original'), kp.secretKey);
  assert.equal(verify(enc.encode('tampered'), sig, kp.publicKey), false);
});

test('sign/verify: tampered signature rejects', () => {
  const kp = keypair();
  const sig = sign(enc.encode('payload'), kp.secretKey);
  const tampered = new Uint8Array(sig);
  tampered[0] = tampered[0]! ^ 0x01;
  assert.equal(verify(enc.encode('payload'), tampered, kp.publicKey), false);
});

test('sign rejects secret key of wrong length', () => {
  assert.throws(() => sign(enc.encode('x'), new Uint8Array(32)), /64 bytes/);
});

test('verify rejects public key of wrong length', () => {
  const kp = keypair();
  const sig = sign(enc.encode('x'), kp.secretKey);
  assert.throws(() => verify(enc.encode('x'), sig, new Uint8Array(31)), /32 bytes/);
});

test('verify rejects signature of wrong length', () => {
  const kp = keypair();
  assert.throws(() => verify(enc.encode('x'), new Uint8Array(63), kp.publicKey), /64 bytes/);
});

// ---------------------------------------------------------------------------
// Canonical payload determinism
// ---------------------------------------------------------------------------

test('canonical payload: same input always produces same bytes', () => {
  const p: AttestationPayload = { workspaceId: 'wid-1', createdAt: 1717200000, formatVersion: 1 };
  const a = buildAttestationPayload(p);
  const b = buildAttestationPayload(p);
  assert.deepEqual(Array.from(a), Array.from(b));
});

test('canonical payload: field order in input does not matter', () => {
  const a = buildAttestationPayload({
    workspaceId: 'wid-1',
    createdAt: 1717200000,
    formatVersion: 1,
  });
  const b = buildAttestationPayload({
    formatVersion: 1,
    workspaceId: 'wid-1',
    createdAt: 1717200000,
  });
  assert.deepEqual(Array.from(a), Array.from(b));
});

test('canonical payload: keys are alphabetically ordered in the output', () => {
  const bytes = buildAttestationPayload({
    workspaceId: 'wid',
    createdAt: 100,
    formatVersion: 1,
  });
  const str = new TextDecoder().decode(bytes);
  // Expected exact form (no whitespace, sorted keys).
  assert.equal(str, '{"createdAt":100,"formatVersion":1,"workspaceId":"wid"}');
});

test('canonical payload: createdAt is floored to whole seconds', () => {
  const bytes = buildAttestationPayload({
    workspaceId: 'wid',
    createdAt: 100.9,
    formatVersion: 1,
  });
  const str = new TextDecoder().decode(bytes);
  assert.match(str, /"createdAt":100,/);
});

// ---------------------------------------------------------------------------
// signWorkspaceAttestation / verifyWorkspaceAttestation
// ---------------------------------------------------------------------------

test('workspace attestation: sign + verify round-trip', () => {
  const root = keypair();
  const att = signWorkspaceAttestation(
    { workspaceId: 'wid-1', createdAt: 1717200000, formatVersion: 1 },
    root.secretKey,
  );
  assert.equal(verifyWorkspaceAttestation(att), true);
});

test('workspace attestation: rootDid matches what didFromSeed would produce', () => {
  // The seed is the first 32 bytes of the sodium secret key.
  const root = keypair();
  const seed = root.secretKey.subarray(0, 32);
  const expectedDid = didFromSeed(seed);
  const att = signWorkspaceAttestation(
    { workspaceId: 'wid-1', createdAt: 1717200000, formatVersion: 1 },
    root.secretKey,
  );
  assert.equal(att.rootDid, expectedDid);
});

test('workspace attestation: tampered workspaceId rejects', () => {
  const root = keypair();
  const att = signWorkspaceAttestation(
    { workspaceId: 'wid-1', createdAt: 1717200000, formatVersion: 1 },
    root.secretKey,
  );
  const tampered = {
    ...att,
    payload: { ...att.payload, workspaceId: 'wid-evil' },
  };
  assert.equal(verifyWorkspaceAttestation(tampered), false);
});

test('workspace attestation: tampered createdAt rejects', () => {
  const root = keypair();
  const att = signWorkspaceAttestation(
    { workspaceId: 'wid-1', createdAt: 1717200000, formatVersion: 1 },
    root.secretKey,
  );
  const tampered = { ...att, payload: { ...att.payload, createdAt: 9999999999 } };
  assert.equal(verifyWorkspaceAttestation(tampered), false);
});

test('workspace attestation: tampered signature rejects', () => {
  const root = keypair();
  const att = signWorkspaceAttestation(
    { workspaceId: 'wid-1', createdAt: 1717200000, formatVersion: 1 },
    root.secretKey,
  );
  const sig = new Uint8Array(att.signature);
  sig[0] = sig[0]! ^ 0x01;
  assert.equal(verifyWorkspaceAttestation({ ...att, signature: sig }), false);
});

test('workspace attestation: claiming a different rootDid rejects', () => {
  const root = keypair();
  const imposter = keypair();
  const imposterDid = didFromSeed(imposter.secretKey.subarray(0, 32));
  const att = signWorkspaceAttestation(
    { workspaceId: 'wid-1', createdAt: 1717200000, formatVersion: 1 },
    root.secretKey,
  );
  assert.equal(
    verifyWorkspaceAttestation({ ...att, rootDid: imposterDid }),
    false,
  );
});

test('workspace attestation: tampered payloadBytes (mismatched against payload) rejects', () => {
  const root = keypair();
  const att = signWorkspaceAttestation(
    { workspaceId: 'wid-1', createdAt: 1717200000, formatVersion: 1 },
    root.secretKey,
  );
  // Build a different payload's bytes and slip them in.
  const otherBytes = buildAttestationPayload({
    workspaceId: 'wid-other',
    createdAt: 1717200000,
    formatVersion: 1,
  });
  assert.equal(
    verifyWorkspaceAttestation({ ...att, payloadBytes: otherBytes }),
    false,
  );
});

// ---------------------------------------------------------------------------
// did.ts additions: publicKeyFromDid is the inverse of didFromSeed
// ---------------------------------------------------------------------------

test('publicKeyFromDid: returns the same bytes that produced the DID', () => {
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = i;
  const kp = hypercoreCrypto.keyPair(Buffer.from(seed)) as { publicKey: Buffer };
  const did = didFromSeed(seed);
  const recovered = publicKeyFromDid(did);
  assert.deepEqual(Array.from(recovered), Array.from(new Uint8Array(kp.publicKey)));
});

test('publicKeyFromDid: rejects non-did:key strings', () => {
  assert.throws(() => publicKeyFromDid('did:web:example.com' as `did:key:${string}`), /did:key:z…/);
});
