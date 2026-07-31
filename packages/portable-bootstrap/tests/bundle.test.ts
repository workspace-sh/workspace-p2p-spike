// Tests for @workspace.sh/portable-bootstrap.
//
// End-to-end exercises: create a bundle for a small org, consume it as each
// recipient, verify the keys round-trip. Plus tamper-detection tests so the
// "refuses to proceed on integrity failure" contract is observable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { principalFromSeed } from '@workspace.sh/ucan-boundary';
import {
  createBundle,
  consumeBundle,
  serialiseBundle,
  deserialiseBundle,
  type Bundle,
  type CapabilityDescriptor,
} from '../src/index.ts';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hypercoreCrypto = require('hypercore-crypto') as any;

function freshKey(): { publicKey: Buffer; secretKey: Buffer } {
  return hypercoreCrypto.keyPair() as { publicKey: Buffer; secretKey: Buffer };
}

function seededKey(byte: number): { publicKey: Buffer; secretKey: Buffer } {
  const seed = new Uint8Array(32);
  seed.fill(byte);
  return hypercoreCrypto.keyPair(Buffer.from(seed)) as {
    publicKey: Buffer;
    secretKey: Buffer;
  };
}

const RESOURCE = 'workspace://wid-test/data/employees';
const CAN: CapabilityDescriptor = { can: 'workspace/read', with: RESOURCE };

// ---------------------------------------------------------------------------
// End-to-end: small org with two recipients
// ---------------------------------------------------------------------------

test('end-to-end: create + consume produces matching keys for each recipient', async () => {
  // Root, Alice, Bob — all distinct identities derived from deterministic seeds.
  const rootKp = seededKey(1);
  const aliceKp = seededKey(2);
  const bobKp = seededKey(3);
  const root = await principalFromSeed(rootKp.secretKey.subarray(0, 32));
  const alice = await principalFromSeed(aliceKp.secretKey.subarray(0, 32));
  const bob = await principalFromSeed(bobKp.secretKey.subarray(0, 32));

  // Two symmetric keys — what the bundle will deliver.
  const k0Org = new Uint8Array(32);
  crypto.getRandomValues(k0Org);
  const k1Alice = new Uint8Array(32);
  crypto.getRandomValues(k1Alice);

  const bundle = await createBundle({
    workspaceId: 'wid-acme',
    createdAt: 1717200000,
    root,
    rootSecretKey: rootKp.secretKey,
    recipients: [
      { did: alice.did(), resource: RESOURCE, key: k0Org, capability: CAN },
      { did: bob.did(), resource: RESOURCE, key: k0Org, capability: CAN },
      // Alice also gets her tier-1 key in the same bundle.
      {
        did: alice.did(),
        resource: `${RESOURCE}/alice`,
        key: k1Alice,
        capability: { can: 'workspace/read', with: `${RESOURCE}/alice` },
      },
    ],
  });

  assert.equal(bundle.envelopes.length, 3);
  assert.equal(bundle.manifest.rootDid, root.did());
  assert.equal(bundle.manifest.workspaceId, 'wid-acme');

  // Alice consumes: should get the first envelope addressed to her (K0_org).
  const aliceView = await consumeBundle(bundle, alice.did(), aliceKp.secretKey);
  assert.equal(aliceView.workspaceId, 'wid-acme');
  assert.equal(aliceView.rootDid, root.did());
  assert.ok(aliceView.mine);
  assert.deepEqual(Array.from(aliceView.mine.key), Array.from(k0Org));
  assert.equal(aliceView.mine.resource, RESOURCE);

  // Bob consumes: gets K0_org as well.
  const bobView = await consumeBundle(bundle, bob.did(), bobKp.secretKey);
  assert.ok(bobView.mine);
  assert.deepEqual(Array.from(bobView.mine.key), Array.from(k0Org));
});

// ---------------------------------------------------------------------------
// Non-recipient: bundle exists but no envelope for this peer
// ---------------------------------------------------------------------------

test('non-recipient: consuming a bundle with no envelope for self returns mine: null', async () => {
  const rootKp = seededKey(10);
  const aliceKp = seededKey(11);
  const eveKp = seededKey(12);
  const root = await principalFromSeed(rootKp.secretKey.subarray(0, 32));
  const alice = await principalFromSeed(aliceKp.secretKey.subarray(0, 32));
  const eve = await principalFromSeed(eveKp.secretKey.subarray(0, 32));

  const key = new Uint8Array(32);
  crypto.getRandomValues(key);

  const bundle = await createBundle({
    workspaceId: 'wid',
    createdAt: 1717200000,
    root,
    rootSecretKey: rootKp.secretKey,
    recipients: [{ did: alice.did(), resource: RESOURCE, key, capability: CAN }],
  });

  // Eve isn't a recipient; the bundle's still readable (it's not an error to
  // exist in someone else's workspace), but she has no envelope.
  const eveView = await consumeBundle(bundle, eve.did(), eveKp.secretKey);
  assert.equal(eveView.mine, null);
  assert.equal(eveView.workspaceId, 'wid');
});

// ---------------------------------------------------------------------------
// Tamper detection — refuse to proceed on integrity failure
// ---------------------------------------------------------------------------

test('tampered manifest workspaceId rejects the whole bundle', async () => {
  const bundle = await trivialBundle();
  const tampered = {
    ...bundle,
    manifest: { ...bundle.manifest, workspaceId: 'wid-evil' },
  };
  await assert.rejects(
    () => consumeBundle(tampered, tampered.envelopes[0]!.recipient, freshKey().secretKey),
    /attestation payload does not match manifest|attestation verification failed/,
  );
});

test('tampered attestation signature rejects', async () => {
  const bundle = await trivialBundle();
  const sig = new Uint8Array(bundle.attestation.signature);
  sig[0] = sig[0]! ^ 0x01;
  const tampered: Bundle = { ...bundle, attestation: { ...bundle.attestation, signature: sig } };
  await assert.rejects(
    () => consumeBundle(tampered, tampered.envelopes[0]!.recipient, freshKey().secretKey),
    /attestation verification failed/,
  );
});

test('tampered envelope wrappedKey causes unwrap-level failure', async () => {
  // Use real recipient keys so attestation passes; we want the failure to
  // happen at unwrap, not at attestation.
  const rootKp = seededKey(20);
  const aliceKp = seededKey(21);
  const root = await principalFromSeed(rootKp.secretKey.subarray(0, 32));
  const alice = await principalFromSeed(aliceKp.secretKey.subarray(0, 32));
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);

  const bundle = await createBundle({
    workspaceId: 'wid',
    createdAt: 1717200000,
    root,
    rootSecretKey: rootKp.secretKey,
    recipients: [{ did: alice.did(), resource: RESOURCE, key, capability: CAN }],
  });

  // Flip a bit in alice's wrapped key.
  const env = bundle.envelopes[0]!;
  const w = new Uint8Array(env.wrappedKey);
  w[w.length - 1] = w[w.length - 1]! ^ 0x01;
  const tampered: Bundle = {
    ...bundle,
    envelopes: [{ ...env, wrappedKey: w }],
  };

  await assert.rejects(
    () => consumeBundle(tampered, alice.did(), aliceKp.secretKey),
    /unwrap failed/,
  );
});

// ---------------------------------------------------------------------------
// Serialisation round-trip
// ---------------------------------------------------------------------------

test('serialise + deserialise round-trip preserves consumability', async () => {
  const rootKp = seededKey(30);
  const aliceKp = seededKey(31);
  const root = await principalFromSeed(rootKp.secretKey.subarray(0, 32));
  const alice = await principalFromSeed(aliceKp.secretKey.subarray(0, 32));
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);

  const original = await createBundle({
    workspaceId: 'wid',
    createdAt: 1717200000,
    root,
    rootSecretKey: rootKp.secretKey,
    recipients: [{ did: alice.did(), resource: RESOURCE, key, capability: CAN }],
  });

  const serialised = serialiseBundle(original);
  // Round-trip through JSON to prove it actually JSON-serialises.
  const json = JSON.stringify(serialised);
  const reparsed = JSON.parse(json);
  const restored = deserialiseBundle(reparsed);

  const view = await consumeBundle(restored, alice.did(), aliceKp.secretKey);
  assert.ok(view.mine);
  assert.deepEqual(Array.from(view.mine.key), Array.from(key));
});

// ---------------------------------------------------------------------------
// Audience mismatch — envelope is for someone else
// ---------------------------------------------------------------------------

test('audience mismatch: trying to consume someone else\'s envelope is rejected', async () => {
  // Alice's envelope, Bob's secret key. The recipient field matches Bob (so
  // findEnvelope returns it), but the UCAN audience inside is Alice. Should
  // fail at the audience-mismatch check.

  const rootKp = seededKey(40);
  const aliceKp = seededKey(41);
  const bobKp = seededKey(42);
  const root = await principalFromSeed(rootKp.secretKey.subarray(0, 32));
  const alice = await principalFromSeed(aliceKp.secretKey.subarray(0, 32));
  const bob = await principalFromSeed(bobKp.secretKey.subarray(0, 32));
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);

  const bundle = await createBundle({
    workspaceId: 'wid',
    createdAt: 1717200000,
    root,
    rootSecretKey: rootKp.secretKey,
    recipients: [{ did: alice.did(), resource: RESOURCE, key, capability: CAN }],
  });

  // Re-label alice's envelope as if it were for bob.
  const tampered: Bundle = {
    ...bundle,
    envelopes: [{ ...bundle.envelopes[0]!, recipient: bob.did() }],
  };

  await assert.rejects(
    () => consumeBundle(tampered, bob.did(), bobKp.secretKey),
    /audience mismatch/,
  );
});

// ---------------------------------------------------------------------------
// Expired UCAN
// ---------------------------------------------------------------------------

test('expired envelope UCAN is rejected', async () => {
  const rootKp = seededKey(50);
  const aliceKp = seededKey(51);
  const root = await principalFromSeed(rootKp.secretKey.subarray(0, 32));
  const alice = await principalFromSeed(aliceKp.secretKey.subarray(0, 32));
  const key = new Uint8Array(32);

  const past = Math.floor(Date.now() / 1000) - 100; // 100s in the past
  const bundle = await createBundle({
    workspaceId: 'wid',
    createdAt: past - 1000,
    root,
    rootSecretKey: rootKp.secretKey,
    recipients: [
      {
        did: alice.did(),
        resource: RESOURCE,
        key,
        capability: CAN,
        expiration: past, // already expired
      },
    ],
  });

  await assert.rejects(
    () => consumeBundle(bundle, alice.did(), aliceKp.secretKey),
    /expired|validation failed/,
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function trivialBundle(): Promise<Bundle> {
  const rootKp = seededKey(99);
  const aliceKp = seededKey(98);
  const root = await principalFromSeed(rootKp.secretKey.subarray(0, 32));
  const alice = await principalFromSeed(aliceKp.secretKey.subarray(0, 32));
  const key = new Uint8Array(32);
  return createBundle({
    workspaceId: 'wid',
    createdAt: 1717200000,
    root,
    rootSecretKey: rootKp.secretKey,
    recipients: [{ did: alice.did(), resource: RESOURCE, key, capability: CAN }],
  });
}
