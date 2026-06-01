// Live key delivery (#9) — inviting a peer after the workspace is already live.
//
// The bundle (acme-org demo) is the OFFLINE first-contact carrier: envelopes
// packed into `.workspace/envelopes/` at creation time. But teams grow. When
// Dave joins on Tuesday, the Friday bundle has no envelope for him — and
// re-cutting the bundle for everyone is wrong.
//
// The key delivery log is the LIVE carrier. Alice (admin) appends one sealed
// envelope addressed to Dave's DID to a replicated Hypercore log. Dave, who's
// already on the swarm, scans the log, finds the block addressed to him,
// validates the UCAN against the workspace root, and unwraps K0_org — without
// Alice and Dave ever being online at the same instant, and without touching
// anyone else's keys.
//
// This demo runs everything in one process over the runtime's direct pipe
// (deterministic, no network). See docs/permissions-model.md ("The two
// carriers") and docs/discovery-layers.md for the framing.

import { createRequire } from 'node:module';

import { NodeRuntime } from '@workspace.sh/p2p-runtime/node';
import { encryptedLog } from '@workspace.sh/p2p-runtime';
import { principalFromSeed } from '@workspace.sh/ucan-boundary';
import {
  createEnvelope,
  publishDelivery,
  scanDeliveries,
  type CapabilityDescriptor,
} from '@workspace.sh/portable-bootstrap';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hypercoreCrypto = require('hypercore-crypto') as any;

const dec = new TextDecoder();
const enc = new TextEncoder();

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

function section(title: string): void {
  log('');
  log(`── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

function seededKeypair(byte: number): { publicKey: Buffer; secretKey: Buffer } {
  const seed = new Uint8Array(32);
  seed.fill(byte);
  return hypercoreCrypto.keyPair(Buffer.from(seed)) as {
    publicKey: Buffer;
    secretKey: Buffer;
  };
}

async function freshRuntime(): Promise<NodeRuntime> {
  const r = new NodeRuntime({ storage: ':memory:' });
  await r.ready();
  return r;
}

async function waitFor(pred: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main(): Promise<void> {
  let aliceRt: NodeRuntime | null = null;
  let daveRt: NodeRuntime | null = null;
  let closeAD: (() => Promise<void>) | null = null;

  log('Live key delivery — inviting Dave after the workspace is live');

  try {
    // ---------------------------------------------------------------------
    section('Setup: Alice (admin) and Dave (late joiner)');
    // ---------------------------------------------------------------------

    const aliceKp = seededKeypair(1);
    const daveKp = seededKeypair(7);
    const alice = await principalFromSeed(aliceKp.secretKey.subarray(0, 32));
    const dave = await principalFromSeed(daveKp.secretKey.subarray(0, 32));

    // workspaceId == root pubkey; Dave already knows it (he was handed the
    // workspace URI / light bundle, which carries the root DID + topic, but
    // no envelope for him yet).
    const workspaceId = aliceKp.publicKey.toString('hex');
    const resource = `workspace://v1/${workspaceId}`;
    const capability: CapabilityDescriptor = { can: 'workspace/read', with: resource };

    // The workspace's base key. Alice holds it; Dave doesn't — yet.
    const k0Org = new Uint8Array(32);
    crypto.getRandomValues(k0Org);
    log(`  alice (root): ${alice.did().slice(0, 48)}…`);
    log(`  dave:         ${dave.did().slice(0, 48)}…`);
    log(`  K0_org held by Alice; Dave has no envelope yet`);

    // ---------------------------------------------------------------------
    section('Runtimes join; Alice opens the key delivery log');
    // ---------------------------------------------------------------------

    aliceRt = await freshRuntime();
    daveRt = await freshRuntime();
    closeAD = aliceRt.__pipeReplicate(daveRt);

    // The key delivery log is a normal Hypercore Alice writes and everyone
    // replicates. Its blocks are public (sealed envelopes); only addressees
    // can unwrap. In a real workspace its key lives in the manifest.
    const deliveryLog = await aliceRt.createLog();
    log(`  key delivery log: ${deliveryLog.key.slice(0, 24)}…`);

    // Dave opens the same log (read-only replica) and starts scanning.
    const daveDeliveryReplica = await daveRt.openLog(deliveryLog.key);

    // ---------------------------------------------------------------------
    section('Before the invite: Dave scans, finds nothing');
    // ---------------------------------------------------------------------

    let cursor = 0;
    const before = await scanDeliveries(daveDeliveryReplica, {
      selfDid: dave.did(),
      selfSecretKey: daveKp.secretKey,
      rootDid: alice.did(),
      fromCursor: cursor,
    });
    cursor = before.cursor;
    log(`  Dave: ${before.deliveries.length} deliveries (cursor now ${cursor})`);

    // ---------------------------------------------------------------------
    section('Alice invites Dave — publishes a sealed envelope to the log');
    // ---------------------------------------------------------------------

    const envelope = await createEnvelope(
      { did: dave.did(), resource, key: k0Org, capability },
      alice,
    );
    await publishDelivery(deliveryLog, envelope);
    log(`  Alice published 1 envelope addressed to Dave's DID`);

    // ---------------------------------------------------------------------
    section('Dave scans again — finds it, validates, unwraps K0_org');
    // ---------------------------------------------------------------------

    await waitFor(() => daveDeliveryReplica.length >= 1, 5_000, 'delivery to replicate');

    const after = await scanDeliveries(daveDeliveryReplica, {
      selfDid: dave.did(),
      selfSecretKey: daveKp.secretKey,
      rootDid: alice.did(),
      fromCursor: cursor, // resume from where he left off
    });
    cursor = after.cursor;

    if (after.deliveries.length !== 1) {
      throw new Error(`expected 1 delivery for Dave, got ${after.deliveries.length}`);
    }
    const daveK0 = after.deliveries[0]!.key;
    const k0Match =
      daveK0.length === k0Org.length && daveK0.every((b, i) => b === k0Org[i]);
    log(`  Dave: 1 delivery at block ${after.deliveries[0]!.index}`);
    log(`  Dave: UCAN validated against workspace root ✓`);
    log(`  Dave: unwrapped K0_org, matches Alice's ${k0Match ? '✓' : '✗'}`);
    if (!k0Match) throw new Error('recovered K0_org does not match');

    // ---------------------------------------------------------------------
    section('Proof: Dave can now read the workspace data log');
    // ---------------------------------------------------------------------

    // Alice writes a sealed data log; Dave, now holding K0_org, reads it.
    const dataLogRaw = await aliceRt.createLog();
    const dataLog = encryptedLog(dataLogRaw, k0Org);
    await dataLog.append(enc.encode(JSON.stringify({ path: 'welcome.md', body: 'Welcome, Dave.' })));

    const daveDataReplica = await daveRt.openLog(dataLogRaw.key);
    await waitFor(() => daveDataReplica.length >= 1, 5_000, 'data block to replicate');
    const daveData = encryptedLog(daveDataReplica, daveK0);
    const event = JSON.parse(dec.decode(await daveData.get(0))) as { path: string; body: string };
    log(`  Dave reads ${event.path}: "${event.body}"`);

    // ---------------------------------------------------------------------
    section('Summary');
    // ---------------------------------------------------------------------

    log('  ✓ Dave joined live — no envelope in any bundle, none re-cut');
    log('  ✓ Alice published one sealed envelope to the key delivery log');
    log('  ✓ Dave scanned from his cursor, validated the UCAN, unwrapped K0_org');
    log('  ✓ Dave then decrypted workspace content with the recovered key');
    log('');
    log('The live carrier completes the two-carrier model: bundles for offline');
    log('first-contact, the delivery log for everyone who joins after.');
  } finally {
    if (closeAD) await closeAD();
    if (aliceRt) await aliceRt.close();
    if (daveRt) await daveRt.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('FAIL:', err);
  process.exit(1);
});
