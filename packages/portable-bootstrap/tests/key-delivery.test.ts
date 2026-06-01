// Tests for the live key delivery log (#9) — src/key-delivery.ts.
//
// Unit tests use an in-memory fake Log for the publish/scan/cursor/skip
// logic. One integration test pairs two real NodeRuntime instances via the
// direct pipe to prove a published delivery replicates and the recipient
// scans its replica and unwraps the key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { principalFromSeed } from '@workspace.sh/ucan-boundary';
import type { Log, LogKey } from '@workspace.sh/p2p-runtime';
import {
  createEnvelope,
  publishDelivery,
  scanDeliveries,
  type CapabilityDescriptor,
} from '../src/index.ts';

// NOTE: the "does it replicate over a real swarm?" proof lives in
// apps/node/src/demos/key-delivery.ts, not here — importing the Node runtime
// would drag its untyped native deps (corestore/hyperswarm/b4a) into this
// package's typecheck. These unit tests cover the publish/scan/cursor/skip
// logic against an in-memory Log; the Log interface's replication behaviour
// is proven in @workspace.sh/p2p-runtime's own tests.

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

function memoryLog(): Log {
  const blocks: Uint8Array[] = [];
  const listeners: Array<() => void> = [];
  return {
    key: 'mem' as LogKey,
    writable: true,
    get length() {
      return blocks.length;
    },
    async append(b: Uint8Array) {
      blocks.push(b);
      for (const l of listeners) l();
      return blocks.length;
    },
    async get(i: number) {
      return blocks[i]!;
    },
    on(_event: 'append', cb: () => void) {
      listeners.push(cb);
      return () => {};
    },
    async close() {},
  };
}

const enc = new TextEncoder();

// Shared fixture: a workspace root, a resource, and a read capability.
async function fixture() {
  const rootKp = seededKey(1);
  const root = await principalFromSeed(rootKp.secretKey.subarray(0, 32));
  const workspaceId = rootKp.publicKey.toString('hex');
  const resource = `workspace://v1/${workspaceId}`;
  const capability: CapabilityDescriptor = { can: 'workspace/read', with: resource };
  return { rootKp, root, resource, capability };
}

function freshSymKey(): Uint8Array {
  const k = new Uint8Array(32);
  crypto.getRandomValues(k);
  return k;
}

// ---------------------------------------------------------------------------
// Publish + scan round-trip
// ---------------------------------------------------------------------------

test('publish + scan: recipient finds and unwraps their delivery', async () => {
  const { root, resource, capability } = await fixture();
  const bobKp = seededKey(2);
  const bob = await principalFromSeed(bobKp.secretKey.subarray(0, 32));
  const key = freshSymKey();

  const log = memoryLog();
  const envelope = await createEnvelope(
    { did: bob.did(), resource, key, capability },
    root,
  );
  const len = await publishDelivery(log, envelope);
  assert.equal(len, 1);

  const result = await scanDeliveries(log, {
    selfDid: bob.did(),
    selfSecretKey: bobKp.secretKey,
    rootDid: root.did(),
  });

  assert.equal(result.deliveries.length, 1);
  assert.deepEqual(Array.from(result.deliveries[0]!.key), Array.from(key));
  assert.equal(result.deliveries[0]!.index, 0);
  assert.equal(result.deliveries[0]!.resource, resource);
  assert.equal(result.cursor, 1);
});

test('a peer not addressed sees no deliveries', async () => {
  const { root, resource, capability } = await fixture();
  const bobKp = seededKey(2);
  const carolKp = seededKey(3);
  const bob = await principalFromSeed(bobKp.secretKey.subarray(0, 32));
  const carol = await principalFromSeed(carolKp.secretKey.subarray(0, 32));

  const log = memoryLog();
  await publishDelivery(
    log,
    await createEnvelope({ did: bob.did(), resource, key: freshSymKey(), capability }, root),
  );

  const result = await scanDeliveries(log, {
    selfDid: carol.did(),
    selfSecretKey: carolKp.secretKey,
    rootDid: root.did(),
  });
  assert.equal(result.deliveries.length, 0);
  assert.equal(result.cursor, 1); // cursor still advances past the scanned block
});

// ---------------------------------------------------------------------------
// Cursor resume
// ---------------------------------------------------------------------------

test('cursor: scanning from a cursor only returns new deliveries', async () => {
  const { root, resource, capability } = await fixture();
  const bobKp = seededKey(2);
  const bob = await principalFromSeed(bobKp.secretKey.subarray(0, 32));

  const log = memoryLog();
  const scanOpts = {
    selfDid: bob.did(),
    selfSecretKey: bobKp.secretKey,
    rootDid: root.did(),
  };

  const k1 = freshSymKey();
  await publishDelivery(
    log,
    await createEnvelope({ did: bob.did(), resource, key: k1, capability }, root),
  );
  const first = await scanDeliveries(log, scanOpts);
  assert.equal(first.deliveries.length, 1);
  assert.equal(first.cursor, 1);

  // A second delivery arrives (e.g. a tier-key rotation).
  const k2 = freshSymKey();
  await publishDelivery(
    log,
    await createEnvelope({ did: bob.did(), resource, key: k2, capability }, root),
  );

  // Resuming from the prior cursor returns only the new delivery.
  const second = await scanDeliveries(log, { ...scanOpts, fromCursor: first.cursor });
  assert.equal(second.deliveries.length, 1);
  assert.equal(second.deliveries[0]!.index, 1);
  assert.deepEqual(Array.from(second.deliveries[0]!.key), Array.from(k2));
  assert.equal(second.cursor, 2);
});

// ---------------------------------------------------------------------------
// Interleaved recipients
// ---------------------------------------------------------------------------

test('interleaved deliveries: each peer gets only theirs', async () => {
  const { root, resource, capability } = await fixture();
  const bobKp = seededKey(2);
  const carolKp = seededKey(3);
  const bob = await principalFromSeed(bobKp.secretKey.subarray(0, 32));
  const carol = await principalFromSeed(carolKp.secretKey.subarray(0, 32));

  const log = memoryLog();
  const mk = (did: typeof bob) =>
    createEnvelope({ did: did.did(), resource, key: freshSymKey(), capability }, root);

  await publishDelivery(log, await mk(bob));
  await publishDelivery(log, await mk(carol));
  await publishDelivery(log, await mk(bob));

  const bobScan = await scanDeliveries(log, {
    selfDid: bob.did(),
    selfSecretKey: bobKp.secretKey,
    rootDid: root.did(),
  });
  assert.deepEqual(
    bobScan.deliveries.map((d) => d.index),
    [0, 2],
  );

  const carolScan = await scanDeliveries(log, {
    selfDid: carol.did(),
    selfSecretKey: carolKp.secretKey,
    rootDid: root.did(),
  });
  assert.deepEqual(
    carolScan.deliveries.map((d) => d.index),
    [1],
  );
});

// ---------------------------------------------------------------------------
// Robustness: skip unknown blocks; bad blocks route to onError, scan continues
// ---------------------------------------------------------------------------

test('unrecognised and unparseable blocks are skipped', async () => {
  const { root, resource, capability } = await fixture();
  const bobKp = seededKey(2);
  const bob = await principalFromSeed(bobKp.secretKey.subarray(0, 32));

  const log = memoryLog();
  // A future-variant block (e.g. a revocation block) and a non-JSON block.
  await log.append(enc.encode(JSON.stringify({ kind: 'workspace/revocation@1', foo: 1 })));
  await log.append(enc.encode('not json at all'));
  // Then a real delivery.
  await publishDelivery(
    log,
    await createEnvelope({ did: bob.did(), resource, key: freshSymKey(), capability }, root),
  );

  const result = await scanDeliveries(log, {
    selfDid: bob.did(),
    selfSecretKey: bobKp.secretKey,
    rootDid: root.did(),
  });
  assert.equal(result.deliveries.length, 1);
  assert.equal(result.deliveries[0]!.index, 2);
  assert.equal(result.cursor, 3);
});

test('a delivery for us that fails validation routes to onError without aborting the scan', async () => {
  const { root, resource, capability } = await fixture();
  const fakeRootKp = seededKey(9);
  const fakeRoot = await principalFromSeed(fakeRootKp.secretKey.subarray(0, 32));
  const bobKp = seededKey(2);
  const bob = await principalFromSeed(bobKp.secretKey.subarray(0, 32));

  const log = memoryLog();
  // Block 0: an envelope addressed to Bob but delegated by the WRONG root —
  // its chain won't terminate at the workspace root, so validation fails.
  await publishDelivery(
    log,
    await createEnvelope({ did: bob.did(), resource, key: freshSymKey(), capability }, fakeRoot),
  );
  // Block 1: a legitimate delivery from the real root.
  const goodKey = freshSymKey();
  await publishDelivery(
    log,
    await createEnvelope({ did: bob.did(), resource, key: goodKey, capability }, root),
  );

  const errors: Array<{ index: number; message: string }> = [];
  const result = await scanDeliveries(log, {
    selfDid: bob.did(),
    selfSecretKey: bobKp.secretKey,
    rootDid: root.did(),
    onError: (index, err) => errors.push({ index, message: err.message }),
  });

  // The bad block errored but didn't stop the scan; the good one came through.
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.index, 0);
  assert.equal(result.deliveries.length, 1);
  assert.equal(result.deliveries[0]!.index, 1);
  assert.deepEqual(Array.from(result.deliveries[0]!.key), Array.from(goodKey));
});

// ---------------------------------------------------------------------------
// publish guard
// ---------------------------------------------------------------------------

test('publishDelivery refuses a non-writable log', async () => {
  const { root, resource, capability } = await fixture();
  const bobKp = seededKey(2);
  const bob = await principalFromSeed(bobKp.secretKey.subarray(0, 32));
  const envelope = await createEnvelope(
    { did: bob.did(), resource, key: freshSymKey(), capability },
    root,
  );

  const readOnly: Log = { ...memoryLog(), writable: false };
  await assert.rejects(() => publishDelivery(readOnly, envelope), /not writable/);
});
