// Tests for @workspace.sh/portable-bootstrap.
//
// End-to-end exercises: create a bundle for a small org, consume it as each
// recipient, verify the keys round-trip. Plus tamper-detection tests so the
// "refuses to proceed on integrity failure" contract is observable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { signWorkspaceAttestation } from '@workspace.sh/p2p-runtime';
import { principalFromSeed } from '@workspace.sh/ucan-boundary';
import {
  createBundle,
  consumeBundle,
  serialiseBundle,
  deserialiseBundle,
  FORMAT_VERSION,
  type Bundle,
  type CapabilityDescriptor,
  type Manifest,
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
  assert.equal(bundle.manifest.workspaceId, root.did().slice('did:key:'.length));

  // Alice consumes: should get the first envelope addressed to her (K0_org).
  const aliceView = await consumeBundle(bundle, alice.did(), aliceKp.secretKey);
  assert.equal(aliceView.workspaceId, bundle.manifest.workspaceId);
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
    createdAt: 1717200000,
    root,
    rootSecretKey: rootKp.secretKey,
    recipients: [{ did: alice.did(), resource: RESOURCE, key, capability: CAN }],
  });

  // Eve isn't a recipient; the bundle's still readable (it's not an error to
  // exist in someone else's workspace), but she has no envelope.
  const eveView = await consumeBundle(bundle, eve.did(), eveKp.secretKey);
  assert.equal(eveView.mine, null);
  assert.equal(eveView.workspaceId, bundle.manifest.workspaceId);
});

// ---------------------------------------------------------------------------
// Tamper detection — refuse to proceed on integrity failure
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Identity: the id and topic are the root's key
// ---------------------------------------------------------------------------

test('the manifest names the workspace by its root key, and the topic hashes that key', async () => {
  const rootKp = seededKey(60);
  const bundle = await trivialBundle(60);
  const { manifest } = bundle;
  assert.equal(manifest.formatVersion, FORMAT_VERSION);
  assert.equal(`did:key:${manifest.workspaceId}`, manifest.rootDid);
  assert.match(manifest.workspaceId, /^z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/);
  assert.equal(manifest.topicId, createHash('sha256').update(rootKp.publicKey).digest('hex'));
});

test('the attestation signs the topic and the log keys', async () => {
  const bundle = await trivialBundle(61, { data: 'aa'.repeat(32), keyDelivery: 'bb'.repeat(32), blobs: 'cc'.repeat(32) });
  assert.equal(bundle.attestation.payload.topicId, bundle.manifest.topicId);
  assert.deepEqual(bundle.attestation.payload.logs, bundle.manifest.logs);
  const signed = new TextDecoder().decode(bundle.attestation.payloadBytes);
  assert.ok(signed.includes(bundle.manifest.topicId));
  assert.ok(signed.includes('cc'.repeat(32)));
});

for (const [field, value] of [
  ['topicId', '00'.repeat(32)],
  ['logs', { data: 'dd'.repeat(32), keyDelivery: 'bb'.repeat(32), blobs: 'cc'.repeat(32) }],
  ['workspaceId', 'z6MkpKpf2nFiC5h9qDPgJrkBbYBaThkAEcVCgGuBHkXqK4Vc'],
] as const) {
  test(`a manifest whose ${field} differs from what the root signed is rejected`, async () => {
    const bundle = await trivialBundle(62, { data: 'aa'.repeat(32), keyDelivery: 'bb'.repeat(32), blobs: 'cc'.repeat(32) });
    const tampered: Bundle = { ...bundle, manifest: { ...bundle.manifest, [field]: value } };
    await assert.rejects(
      () => consumeBundle(tampered, tampered.envelopes[0]!.recipient, freshKey().secretKey),
      /attestation payload does not match manifest/,
    );
  });
}

test('a manifest the root signed with an id that is not its key is rejected', async () => {
  const rootKp = seededKey(63);
  const bundle = await trivialBundle(63);
  const manifest: Manifest = { ...bundle.manifest, workspaceId: 'z6MkpKpf2nFiC5h9qDPgJrkBbYBaThkAEcVCgGuBHkXqK4Vc' };
  const forged = resigned(bundle, manifest, rootKp.secretKey);
  await assert.rejects(
    () => consumeBundle(forged, forged.envelopes[0]!.recipient, freshKey().secretKey),
    /workspace id is not its root DID's key/,
  );
});

test('a workspace of another format version is refused, and says so', async () => {
  const bundle = await trivialBundle(65);
  const older: Bundle = { ...bundle, manifest: { ...bundle.manifest, formatVersion: 1 } };
  await assert.rejects(
    () => consumeBundle(older, older.envelopes[0]!.recipient, freshKey().secretKey),
    new RegExp(`format 1, and this version of Workspace opens format ${FORMAT_VERSION}`),
  );
});

test('creating a bundle with a secret key that is not the root\'s fails', async () => {
  const root = await principalFromSeed(seededKey(66).secretKey.subarray(0, 32));
  await assert.rejects(
    () => createBundle({ root, rootSecretKey: seededKey(67).secretKey, recipients: [] }),
    /not the root principal's key/,
  );
});

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

async function trivialBundle(rootByte = 99, logs?: Manifest['logs']): Promise<Bundle> {
  const rootKp = seededKey(rootByte);
  const aliceKp = seededKey(98);
  const root = await principalFromSeed(rootKp.secretKey.subarray(0, 32));
  const alice = await principalFromSeed(aliceKp.secretKey.subarray(0, 32));
  const key = new Uint8Array(32);
  return createBundle({
    createdAt: 1717200000,
    root,
    rootSecretKey: rootKp.secretKey,
    recipients: [{ did: alice.did(), resource: RESOURCE, key, capability: CAN }],
    ...(logs ? { logs } : {}),
  });
}

/** `bundle` with `manifest`, and an attestation the root really signed over it. */
function resigned(bundle: Bundle, manifest: Manifest, rootSecretKey: Uint8Array): Bundle {
  const { rootDid: _rootDid, ...payload } = manifest;
  return { ...bundle, manifest, attestation: signWorkspaceAttestation(payload, rootSecretKey) };
}
