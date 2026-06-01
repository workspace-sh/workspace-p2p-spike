// Tests for the filesystem pack/unpack layer.
//
// Exercises writeBundleFolder → readBundleFolder round-trip and verifies the
// on-disk layout matches docs/workspace-format.md (manifest.json,
// attestation.json, envelopes/* all under `.workspace/`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { principalFromSeed } from '@workspace.sh/ucan-boundary';
import {
  createBundle,
  consumeBundle,
  writeBundleFolder,
  readBundleFolder,
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

const RESOURCE = 'workspace://wid-folder-test/data';
const CAN: CapabilityDescriptor = { can: 'workspace/read', with: RESOURCE };

async function withTempWorkspace(
  name: string,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-folder-test-'));
  const workspaceDir = join(base, `${name}.workspace`);
  try {
    await fn(workspaceDir);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Round-trip: write to disk, read back, identical bundle
// ---------------------------------------------------------------------------

test('round-trip: writeBundleFolder → readBundleFolder produces an equivalent bundle', async () => {
  const rootKp = seededKey(31);
  const aliceKp = seededKey(32);
  const root = await principalFromSeed(rootKp.secretKey.subarray(0, 32));
  const alice = await principalFromSeed(aliceKp.secretKey.subarray(0, 32));

  const k0 = new Uint8Array(32);
  crypto.getRandomValues(k0);

  const original = await createBundle({
    workspaceId: 'wid-folder',
    createdAt: 1717200000,
    root,
    rootSecretKey: rootKp.secretKey,
    recipients: [{ did: alice.did(), resource: RESOURCE, key: k0, capability: CAN }],
  });

  await withTempWorkspace('acme', async (dir) => {
    await writeBundleFolder(original, dir);
    const restored = await readBundleFolder(dir);

    // Manifest round-trips byte-for-byte.
    assert.deepEqual(restored.manifest, original.manifest);

    // Attestation: payload identical; bytes identical when re-encoded.
    assert.deepEqual(restored.attestation.payload, original.attestation.payload);
    assert.equal(restored.attestation.rootDid, original.attestation.rootDid);
    assert.deepEqual(
      Array.from(restored.attestation.signature),
      Array.from(original.attestation.signature),
    );
    assert.deepEqual(
      Array.from(restored.attestation.payloadBytes),
      Array.from(original.attestation.payloadBytes),
    );

    // Envelopes preserved.
    assert.equal(restored.envelopes.length, 1);
    const e = restored.envelopes[0]!;
    assert.equal(e.recipient, alice.did());
    assert.equal(e.resource, RESOURCE);
    assert.deepEqual(
      Array.from(e.wrappedKey),
      Array.from(original.envelopes[0]!.wrappedKey),
    );
  });
});

// ---------------------------------------------------------------------------
// End-to-end: write, read, consume from disk → keys unwrap
// ---------------------------------------------------------------------------

test('end-to-end from disk: a consumer can unwrap their key after reading from a folder', async () => {
  const rootKp = seededKey(40);
  const aliceKp = seededKey(41);
  const bobKp = seededKey(42);
  const root = await principalFromSeed(rootKp.secretKey.subarray(0, 32));
  const alice = await principalFromSeed(aliceKp.secretKey.subarray(0, 32));
  const bob = await principalFromSeed(bobKp.secretKey.subarray(0, 32));

  const k0 = new Uint8Array(32);
  crypto.getRandomValues(k0);

  const bundle = await createBundle({
    workspaceId: 'wid-disk',
    createdAt: 1717200000,
    root,
    rootSecretKey: rootKp.secretKey,
    recipients: [
      { did: alice.did(), resource: RESOURCE, key: k0, capability: CAN },
      { did: bob.did(), resource: RESOURCE, key: k0, capability: CAN },
    ],
  });

  await withTempWorkspace('shared', async (dir) => {
    await writeBundleFolder(bundle, dir);

    // A second app instance comes along, reads from disk, joins as Alice.
    const restored = await readBundleFolder(dir);
    const view = await consumeBundle(restored, alice.did(), aliceKp.secretKey);

    assert.ok(view.mine);
    assert.equal(view.workspaceId, 'wid-disk');
    assert.deepEqual(Array.from(view.mine.key), Array.from(k0));
  });
});

// ---------------------------------------------------------------------------
// On-disk layout: matches docs/workspace-format.md
// ---------------------------------------------------------------------------

test('on-disk layout: .workspace/ holds manifest, attestation, and envelopes/ subdir', async () => {
  const rootKp = seededKey(50);
  const aliceKp = seededKey(51);
  const root = await principalFromSeed(rootKp.secretKey.subarray(0, 32));
  const alice = await principalFromSeed(aliceKp.secretKey.subarray(0, 32));

  const key = new Uint8Array(32);
  crypto.getRandomValues(key);

  const bundle = await createBundle({
    workspaceId: 'wid-layout',
    createdAt: 1717200000,
    root,
    rootSecretKey: rootKp.secretKey,
    recipients: [{ did: alice.did(), resource: RESOURCE, key, capability: CAN }],
  });

  await withTempWorkspace('layout', async (dir) => {
    await writeBundleFolder(bundle, dir);

    const meta = join(dir, '.workspace');
    const metaStat = await stat(meta);
    assert.ok(metaStat.isDirectory(), '.workspace/ should be a directory');

    const manifestStat = await stat(join(meta, 'manifest.json'));
    assert.ok(manifestStat.isFile(), '.workspace/manifest.json should exist');

    const attestationStat = await stat(join(meta, 'attestation.json'));
    assert.ok(attestationStat.isFile(), '.workspace/attestation.json should exist');

    const envelopesDir = join(meta, 'envelopes');
    const envelopesStat = await stat(envelopesDir);
    assert.ok(envelopesStat.isDirectory(), '.workspace/envelopes/ should be a directory');

    // Envelope filename: DID with colons replaced by underscores.
    const envelopeFiles = await readdir(envelopesDir);
    assert.equal(envelopeFiles.length, 1);
    const expectedName = alice.did().replace(/:/g, '_') + '.json';
    assert.equal(envelopeFiles[0], expectedName);

    // Manifest content is valid JSON with the expected fields.
    const manifestText = await readFile(join(meta, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    assert.equal(manifest.workspaceId, 'wid-layout');
    assert.equal(manifest.formatVersion, 1);
    assert.equal(manifest.rootDid, root.did());
  });
});

// ---------------------------------------------------------------------------
// Light bundle: zero recipients (everyone joins via live key delivery log)
// ---------------------------------------------------------------------------

test('light bundle: no recipients writes an empty envelopes/ and reads back cleanly', async () => {
  const rootKp = seededKey(60);
  const root = await principalFromSeed(rootKp.secretKey.subarray(0, 32));

  const bundle = await createBundle({
    workspaceId: 'wid-light',
    createdAt: 1717200000,
    root,
    rootSecretKey: rootKp.secretKey,
    recipients: [],
  });

  await withTempWorkspace('light', async (dir) => {
    await writeBundleFolder(bundle, dir);
    const restored = await readBundleFolder(dir);
    assert.equal(restored.envelopes.length, 0);
    assert.equal(restored.manifest.workspaceId, 'wid-light');
  });
});
