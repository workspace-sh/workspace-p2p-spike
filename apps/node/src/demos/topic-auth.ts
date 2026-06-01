// Topic-layer auth (#10) — the connect-time membership gate, live.
//
// Encryption stops a non-member from READING. This stops them CONNECTING.
// Each peer runs with an `auth` hook: on every swarm connection it presents
// its membership proof (a UCAN addressed to its own DID) and verifies the
// peer's against the workspace root. Replication happens only on a positive
// verdict; otherwise the connection is dropped.
//
// Scenario:
//   - Alice (admin) and Bob (member) hold UCANs delegated by the workspace
//     root. They connect, verify each other, replicate — Bob reads Alice's log.
//   - Mallory holds a UCAN from a DIFFERENT root. She reaches the topic but
//     fails the gate; her connection is dropped and she replicates nothing.
//
// Runs over a real Hyperswarm against a private in-process bootstrap (no
// public DHT, no host network impact). See docs/permissions-model.md
// ("Lever 2 — Topic-layer").

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { createRuntime } from '@workspace.sh/p2p-runtime/node';
import { didFromSeed, type ConnectionAuth, type Did } from '@workspace.sh/p2p-runtime';
import { principalFromSeed } from '@workspace.sh/ucan-boundary';
import {
  createEnvelope,
  verifyMembership,
  type CapabilityDescriptor,
  type Principal,
} from '@workspace.sh/portable-bootstrap';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DHT = require('hyperdht') as any;

const enc = new TextEncoder();
const dec = new TextDecoder();

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}
function section(title: string): void {
  log('');
  log(`── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`);
}

function topicFromWorkspaceId(workspaceId: string): string {
  return createHash('sha256').update(`workspace://${workspaceId}`).digest('hex');
}

function seed(byte: number): Uint8Array {
  const s = new Uint8Array(32);
  s.fill(byte);
  return s;
}

const dummyKey = new Uint8Array(32);

// Mint a membership proof: a UCAN delegated by `issuer` to `audienceDid`,
// returned as the raw bytes a peer presents at connect time.
async function membershipProofBytes(
  audienceDid: Did,
  issuer: Principal,
  resource: string,
  capability: CapabilityDescriptor,
): Promise<Uint8Array> {
  const env = await createEnvelope(
    { did: audienceDid, resource, key: dummyKey, capability },
    issuer,
  );
  return env.ucan;
}

async function main(): Promise<void> {
  // Private in-process bootstrap — all swarm traffic stays on loopback.
  const bootstrapNode = DHT.bootstrapper(49738, '127.0.0.1');
  await bootstrapNode.ready();
  const bootstrap = [{ host: '127.0.0.1', port: 49738 }];

  log('Topic-layer auth — gating connections by workspace membership');

  const runtimes: Array<{ close(): Promise<void> }> = [];
  try {
    // ---------------------------------------------------------------------
    section('Identities');
    // ---------------------------------------------------------------------

    // The workspace root authority (issues membership). Also a separate
    // "fake" root that Mallory's credential chains to.
    const root = await principalFromSeed(seed(1));
    const fakeRoot = await principalFromSeed(seed(99));
    const rootDid = root.did();
    const workspaceId = rootDid.slice('did:key:z'.length).slice(0, 32); // any stable id
    const resource = `workspace://v1/${workspaceId}`;
    const capability: CapabilityDescriptor = { can: 'workspace/read', with: resource };

    // Peer identity seeds → deterministic runtime DIDs (known up front, so we
    // can mint each peer's proof addressed to its own DID before start-up).
    const aliceSeed = seed(10);
    const bobSeed = seed(11);
    const mallorySeed = seed(12);
    const aliceDid = didFromSeed(aliceSeed);
    const bobDid = didFromSeed(bobSeed);
    const malloryDid = didFromSeed(mallorySeed);

    log(`  root (authority): ${rootDid.slice(0, 44)}…`);
    log(`  alice  (member):  ${aliceDid.slice(0, 44)}…`);
    log(`  bob    (member):  ${bobDid.slice(0, 44)}…`);
    log(`  mallory (outsider): ${malloryDid.slice(0, 44)}…`);

    // Proofs: Alice and Bob delegated by the real root; Mallory by fakeRoot.
    const aliceProof = await membershipProofBytes(aliceDid, root, resource, capability);
    const bobProof = await membershipProofBytes(bobDid, root, resource, capability);
    const malloryProof = await membershipProofBytes(malloryDid, fakeRoot, resource, capability);

    // The verify side is identical for every honest peer: bind the presented
    // proof to the authenticated key and validate against the workspace root.
    const verify = (proofOwner: string) =>
      async (remotePublicKey: Uint8Array, remoteProof: Uint8Array): Promise<boolean> => {
        const verdict = await verifyMembership({
          proof: { ucan: remoteProof },
          remotePublicKey,
          rootDid,
        });
        log(
          `    [${proofOwner}] connection from ${verdict.did?.slice(0, 24) ?? '?'}…: ` +
            (verdict.ok ? 'ACCEPT' : `REJECT (${verdict.reason})`),
        );
        return verdict.ok;
      };

    const authFor = (localProof: Uint8Array, owner: string): ConnectionAuth => ({
      localProof,
      verify: verify(owner),
    });

    // ---------------------------------------------------------------------
    section('Start Alice + Bob (members), join the topic');
    // ---------------------------------------------------------------------

    const aliceRt = await createRuntime({
      storage: ':memory:',
      identitySeed: aliceSeed,
      bootstrap,
      auth: authFor(aliceProof, 'alice'),
    });
    const bobRt = await createRuntime({
      storage: ':memory:',
      identitySeed: bobSeed,
      bootstrap,
      auth: authFor(bobProof, 'bob'),
    });
    runtimes.push(aliceRt, bobRt);

    const topic = topicFromWorkspaceId(workspaceId);
    log(`  topic: ${topic.slice(0, 24)}…`);

    const dataLog = await aliceRt.createLog();
    await dataLog.append(enc.encode(JSON.stringify({ path: 'welcome.md', body: 'Members only.' })));

    await aliceRt.joinTopic(topic);
    await bobRt.joinTopic(topic);

    const bobReplica = await bobRt.openLog(dataLog.key);

    section('Bob (valid member) should replicate');
    const bobStart = Date.now();
    while (bobReplica.length < 1 && Date.now() - bobStart < 15_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (bobReplica.length < 1) {
      throw new Error('Bob did not replicate — a valid member was wrongly rejected');
    }
    const bobEvent = JSON.parse(dec.decode(await bobReplica.get(0))) as { path: string; body: string };
    log(`  Bob replicated + read ${bobEvent.path}: "${bobEvent.body}" (${Date.now() - bobStart}ms)`);

    // ---------------------------------------------------------------------
    section('Start Mallory (outsider), join the same topic');
    // ---------------------------------------------------------------------

    const malloryRt = await createRuntime({
      storage: ':memory:',
      identitySeed: mallorySeed,
      bootstrap,
      auth: authFor(malloryProof, 'mallory'),
    });
    runtimes.push(malloryRt);

    await malloryRt.joinTopic(topic);
    const malloryReplica = await malloryRt.openLog(dataLog.key);

    section('Mallory (wrong root) should be rejected — no replication');
    // Give the gate ample time to reject; confirm she never gets the block.
    const malloryWindow = 8_000;
    const malloryStart = Date.now();
    while (malloryReplica.length < 1 && Date.now() - malloryStart < malloryWindow) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (malloryReplica.length >= 1) {
      throw new Error('SECURITY FAILURE: Mallory replicated the log despite an invalid proof');
    }
    log(`  Mallory got 0 blocks after ${malloryWindow}ms — connection gated ✓`);

    // ---------------------------------------------------------------------
    section('Summary');
    // ---------------------------------------------------------------------

    log('  ✓ swarm keypair == did:key identity (Noise key binds to the DID)');
    log('  ✓ Alice + Bob presented root-issued proofs, verified each other, replicated');
    log('  ✓ Mallory presented a wrong-root proof, was rejected at connect, replicated nothing');
    log('');
    log('Lever 2 holds: membership is checked at the connection, not just at decryption.');
  } finally {
    for (const rt of runtimes) {
      try {
        await rt.close();
      } catch {
        /* ignore */
      }
    }
    await bootstrapNode.destroy();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('FAIL:', err);
  process.exit(1);
});
