// End-to-end demonstration of the design.
//
// What this script proves
// -----------------------
// Two peers, started independently, end up sharing a workspace's content
// using only what the design says they should need:
//
//   1. Peer A creates a workspace (root identity, root attestation).
//   2. Peer A writes a `.workspace/` bundle to disk for Peer B (a sealed
//      envelope addressed to B's DID, carrying K0_org and a UCAN).
//   3. The folder is "transported" (in-process here; in real life this would
//      be a USB stick, AirDrop, NAS drop, email attachment, etc.).
//   4. Peer B reads the folder, validates the root attestation, unwraps the
//      envelope, recovers K0_org and the UCAN.
//   5. Both peers join the workspace's Hyperswarm topic — derived from the
//      workspaceId (which IS the root pubkey, per the spec).
//   6. Peer A appends data to the workspace's data log.
//   7. Peer B opens the same log and reads the data back.
//
// What this script doesn't prove (yet)
// ------------------------------------
// - The unwrapped K0_org isn't used to actually decrypt log content. The
//   encrypted store layer (issue #11 / Autobase) is the next piece. Today
//   the log carries plain bytes; in production each block would be sealed
//   under K0_org or a higher tier key.
// - The runtime's DID and the bundle's recipient DID aren't unified through
//   the runtime API in the spike yet. The script uses independent
//   principalFromSeed identities for the bundle flow; the runtime DID is
//   what it auto-generates from its corestore primaryKey. The integration
//   point between bundle and runtime is the workspaceId → topic derivation,
//   which IS unified.
// - Topic-layer auth (issue #10) doesn't yet gate connections by UCAN. Any
//   peer with the topic can join today; production gates at the noise
//   handshake.
//
// This is the "first cohesive end-to-end" demo. Each gap above is its own
// tracked issue.

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { createRuntime } from '@workspace/p2p-runtime/node';
import { principalFromSeed } from '@workspace/ucan-boundary';
import {
  createBundle,
  consumeBundle,
  writeBundleFolder,
  readBundleFolder,
  type CapabilityDescriptor,
} from '@workspace/portable-bootstrap';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hypercoreCrypto = require('hypercore-crypto') as any;

const dec = new TextDecoder();
const enc = new TextEncoder();

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[demo] ${msg}`);
}

function topicFromWorkspaceId(workspaceId: string): string {
  // The workspace's topic is a deterministic function of the workspaceId
  // (which IS the root pubkey). Both peers derive the same topic from the
  // same workspaceId — no out-of-band topic exchange needed.
  return createHash('sha256').update(`workspace://${workspaceId}`).digest('hex');
}

function seededKey(byte: number): { publicKey: Buffer; secretKey: Buffer } {
  const seed = new Uint8Array(32);
  seed.fill(byte);
  return hypercoreCrypto.keyPair(Buffer.from(seed)) as {
    publicKey: Buffer;
    secretKey: Buffer;
  };
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // 0. Setup — tmp dirs for storage and the .workspace bundle folder
  // -------------------------------------------------------------------------
  const tmpBase = await mkdtemp(join(tmpdir(), 'workspace-demo-'));
  const peerAStorage = join(tmpBase, 'peerA-store');
  const peerBStorage = join(tmpBase, 'peerB-store');
  const bundleDir = join(tmpBase, 'Acme.workspace');

  log(`tmpdir: ${tmpBase}`);

  try {
    // -----------------------------------------------------------------------
    // 1. Workspace creation (Peer A side)
    // -----------------------------------------------------------------------
    log('peer A: creating the workspace…');

    // Workspace identities. The root signs the workspace's attestation; its
    // pubkey IS the workspaceId.
    const rootKp = seededKey(1);
    const root = await principalFromSeed(rootKp.secretKey.subarray(0, 32));

    // The recipient — Bob (Peer B) — has his own identity.
    const bobKp = seededKey(2);
    const bob = await principalFromSeed(bobKp.secretKey.subarray(0, 32));

    // The workspace's base key (K0_org). In production this would gate access
    // to workspace-public encrypted content; here we just demonstrate that it
    // round-trips through the envelope intact.
    const k0Org = new Uint8Array(32);
    // eslint-disable-next-line no-restricted-globals
    crypto.getRandomValues(k0Org);

    // workspaceId is the root pubkey, multibase-encoded. We use the raw bytes
    // from rootKp for the demo's topic derivation; the actual multibase form
    // would be the URI-layer identifier.
    const workspaceIdBytes = rootKp.publicKey;
    const workspaceId = workspaceIdBytes.toString('hex');
    const resource = `workspace://v1/${workspaceId}`;
    const capability: CapabilityDescriptor = { can: 'workspace/read', with: resource };

    const bundle = await createBundle({
      workspaceId,
      createdAt: Math.floor(Date.now() / 1000),
      root,
      rootSecretKey: rootKp.secretKey,
      recipients: [{ did: bob.did(), resource, key: k0Org, capability }],
    });

    log(`peer A: bundle created (rootDid=${bundle.manifest.rootDid.slice(0, 32)}…)`);

    // -----------------------------------------------------------------------
    // 2. Write to disk — the .workspace/ bundle on the filesystem
    // -----------------------------------------------------------------------
    await writeBundleFolder(bundle, bundleDir);
    log(`peer A: wrote bundle to ${bundleDir}/.workspace/`);

    // -----------------------------------------------------------------------
    // 3. Start both runtimes — each with its own storage directory
    // -----------------------------------------------------------------------
    log('starting peer A and peer B runtimes…');
    const peerA = await createRuntime({ storage: peerAStorage });
    const peerB = await createRuntime({ storage: peerBStorage });
    log(`peer A runtime did: ${peerA.did().slice(0, 32)}…`);
    log(`peer B runtime did: ${peerB.did().slice(0, 32)}…`);

    // -----------------------------------------------------------------------
    // 4. Peer A creates the data log and writes some content
    // -----------------------------------------------------------------------
    const dataLog = await peerA.createLog();
    log(`peer A: created data log key=${dataLog.key.slice(0, 16)}…`);

    await dataLog.append(enc.encode('# Q2 retrospective'));
    await dataLog.append(enc.encode('action item 1: ship the spike'));
    await dataLog.append(enc.encode('action item 2: talk to design about onboarding'));
    log(`peer A: appended 3 blocks (logA.length=${dataLog.length})`);

    // -----------------------------------------------------------------------
    // 5. Peer B reads the bundle from disk and consumes it
    //    (in real life this is the "Bob opens the .workspace folder" moment)
    // -----------------------------------------------------------------------
    log('peer B: reading the .workspace bundle from disk…');
    const restoredBundle = await readBundleFolder(bundleDir);

    const view = await consumeBundle(restoredBundle, bob.did(), bobKp.secretKey);
    if (!view.mine) {
      throw new Error('peer B: no envelope addressed to bob — bundle should contain one');
    }

    // Verify the recovered K0_org matches what Peer A sealed.
    const k0Match =
      view.mine.key.length === k0Org.length &&
      view.mine.key.every((b, i) => b === k0Org[i]);
    if (!k0Match) {
      throw new Error('peer B: unwrapped K0_org does not match what was sealed');
    }
    log(`peer B: attestation verified, envelope unwrapped, K0_org recovered ✓`);
    log(`peer B: workspaceId matches: ${view.workspaceId === workspaceId ? '✓' : '✗'}`);

    // -----------------------------------------------------------------------
    // 6. Both peers join the workspace's topic, derived from workspaceId
    // -----------------------------------------------------------------------
    const topic = topicFromWorkspaceId(workspaceId);
    log(`joining topic derived from workspaceId: ${topic.slice(0, 16)}…`);
    await peerA.joinTopic(topic);
    await peerB.joinTopic(topic);

    // -----------------------------------------------------------------------
    // 7. Peer B opens the log and waits for replication
    //    NOTE: passing dataLog.key out-of-band here. In the full design the
    //    manifest carries the log addresses (manifest.logs.data — see
    //    workspace-format.md). Wiring that into the Manifest type is its own
    //    follow-up.
    // -----------------------------------------------------------------------
    const replicaLog = await peerB.openLog(dataLog.key);
    log('peer B: opened the log; waiting for replication…');

    const deadlineMs = 30_000;
    const start = Date.now();
    while (replicaLog.length < 3 && Date.now() - start < deadlineMs) {
      await new Promise((r) => setTimeout(r, 250));
    }

    if (replicaLog.length < 3) {
      throw new Error(
        `replication timed out after ${deadlineMs}ms (replicaLog.length=${replicaLog.length})`,
      );
    }

    const elapsed = Date.now() - start;
    log(`peer B: replicated ${replicaLog.length} blocks in ${elapsed}ms`);

    for (let i = 0; i < replicaLog.length; i++) {
      const block = await replicaLog.get(i);
      log(`  block[${i}] = ${dec.decode(block)}`);
    }

    // -----------------------------------------------------------------------
    // 8. Shutdown
    // -----------------------------------------------------------------------
    await peerA.close();
    await peerB.close();

    log('');
    log('END-TO-END OK');
    log('  - bundle round-tripped through .workspace/ on disk');
    log('  - root attestation verified across the boundary');
    log('  - envelope sealed to bob unwrapped K0_org cleanly');
    log('  - topic derived from workspaceId reached both peers');
    log('  - Hypercore log replicated under that topic via Hyperswarm');
  } finally {
    await rm(tmpBase, { recursive: true, force: true });
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[demo] FAIL:', err);
  process.exit(1);
});
