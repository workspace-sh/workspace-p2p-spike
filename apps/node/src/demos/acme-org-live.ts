// Acme small-org demo — over a *private* hyperdht swarm.
//
// Same scenario as `acme-org.ts` (Alice, Bob, Carol — sealed log via
// K0_org) but exercises the actual Hyperswarm transport rather than the
// direct pipe. Discovery happens through a private DHT bootstrap node you
// run separately (see `bootstrap-dht.ts`); zero traffic leaves your
// machine.
//
// Run order:
//   Terminal 1:  npm -w @workspace/p2p-spike-node run demo:bootstrap
//   Terminal 2:  npm -w @workspace/p2p-spike-node run demo:acme:live
//
// See docs/discovery-layers.md for why we do this (and how it relates to
// the layered local / LAN / WAN discovery story).

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { createRuntime } from '@workspace/p2p-runtime/node';
import { seal, open } from '@workspace/p2p-runtime';
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DHT = require('hyperdht') as any;

// When SPAWN_BOOTSTRAP=1, the demo runs its own bootstrap in-process on
// loopback rather than connecting to an external one. This is how the
// containerised demo works — bootstrap + all peers in one process on
// 127.0.0.1, exactly mirroring the proven single-host setup, with no
// cross-container bridge networking to negotiate. See docker-compose.yml.
const SPAWN_BOOTSTRAP = process.env.SPAWN_BOOTSTRAP === '1';

const dec = new TextDecoder();
const enc = new TextEncoder();

// When spawning our own bootstrap, peers always reach it on loopback.
const BOOTSTRAP_HOST = SPAWN_BOOTSTRAP ? '127.0.0.1' : (process.env.BOOTSTRAP_HOST ?? '127.0.0.1');
const BOOTSTRAP_PORT = Number(process.env.BOOTSTRAP_PORT ?? 49737);

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

function section(title: string): void {
  log('');
  log(`── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

function topicFromWorkspaceId(workspaceId: string): string {
  return createHash('sha256').update(`workspace://${workspaceId}`).digest('hex');
}

function seededKeypair(byte: number): { publicKey: Buffer; secretKey: Buffer } {
  const seed = new Uint8Array(32);
  seed.fill(byte);
  return hypercoreCrypto.keyPair(Buffer.from(seed)) as {
    publicKey: Buffer;
    secretKey: Buffer;
  };
}

const SAMPLE_FILES: Array<{ path: string; content: string }> = [
  {
    path: 'policies/code-of-conduct.md',
    content: '# Code of Conduct\n\nRespect, professionalism, escalation.\n',
  },
  {
    path: 'notes/q2-retrospective.md',
    content: '# Q2 Retrospective\n\nWhat worked, what didn\'t, next quarter.\n',
  },
];

function changeEvent(actor: string, path: string, content: string): Uint8Array {
  return enc.encode(JSON.stringify({ actor, path, content }));
}

async function main(): Promise<void> {
  const tmpBase = await mkdtemp(join(tmpdir(), 'workspace-acme-live-'));
  const acmeFolder = join(tmpBase, 'Acme.workspace');
  const aliceStorage = join(tmpBase, 'alice-store');
  const bobStorage = join(tmpBase, 'bob-store');
  const carolStorage = join(tmpBase, 'carol-store');

  log('Acme — small-org demo over private hyperdht');
  log(`bootstrap: ${BOOTSTRAP_HOST}:${BOOTSTRAP_PORT}${SPAWN_BOOTSTRAP ? ' (in-process)' : ''}`);
  log(`tmpdir:    ${tmpBase}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let inProcessBootstrap: any = null;

  try {
    // ---------------------------------------------------------------------
    // Optionally spawn an in-process bootstrap on loopback. Everything —
    // bootstrap + all three peers — then lives in one process on 127.0.0.1,
    // which is the configuration we verified works on the bare host.
    // ---------------------------------------------------------------------
    if (SPAWN_BOOTSTRAP) {
      section('Spawn in-process bootstrap (loopback)');
      inProcessBootstrap = DHT.bootstrapper(BOOTSTRAP_PORT, BOOTSTRAP_HOST);
      await inProcessBootstrap.ready();
      log(`  bootstrap ready on ${BOOTSTRAP_HOST}:${BOOTSTRAP_PORT}`);
    }

    // ---------------------------------------------------------------------
    section('Bundle creation (same as demo:acme)');
    // ---------------------------------------------------------------------

    const aliceKp = seededKeypair(1);
    const bobKp = seededKeypair(2);
    const carolKp = seededKeypair(3);

    const alice = await principalFromSeed(aliceKp.secretKey.subarray(0, 32));
    const bob = await principalFromSeed(bobKp.secretKey.subarray(0, 32));
    const carol = await principalFromSeed(carolKp.secretKey.subarray(0, 32));

    const k0Org = new Uint8Array(32);
    crypto.getRandomValues(k0Org);

    const workspaceId = aliceKp.publicKey.toString('hex');
    const resource = `workspace://v1/${workspaceId}`;
    const capability: CapabilityDescriptor = { can: 'workspace/read', with: resource };

    const bundle = await createBundle({
      workspaceId,
      createdAt: Math.floor(Date.now() / 1000),
      root: alice,
      rootSecretKey: aliceKp.secretKey,
      recipients: [
        { did: bob.did(), resource, key: k0Org, capability },
        { did: carol.did(), resource, key: k0Org, capability },
      ],
    });

    await writeBundleFolder(bundle, acmeFolder);
    for (const file of SAMPLE_FILES) {
      const full = join(acmeFolder, file.path);
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, file.content, 'utf8');
    }
    log(`  wrote bundle + working tree to ${acmeFolder}`);

    // ---------------------------------------------------------------------
    section('Bob and Carol open the bundle, recover K0_org');
    // ---------------------------------------------------------------------

    const bobView = await consumeBundle(
      await readBundleFolder(acmeFolder),
      bob.did(),
      bobKp.secretKey,
    );
    const carolView = await consumeBundle(
      await readBundleFolder(acmeFolder),
      carol.did(),
      carolKp.secretKey,
    );
    if (!bobView.mine || !carolView.mine) {
      throw new Error('expected envelopes for both bob and carol');
    }
    const bobK0 = bobView.mine.key;
    const carolK0 = carolView.mine.key;
    log(`  bob + carol both unwrapped K0_org`);

    // ---------------------------------------------------------------------
    section('Start runtimes pointed at the private DHT');
    // ---------------------------------------------------------------------

    const bootstrap = [{ host: BOOTSTRAP_HOST, port: BOOTSTRAP_PORT }];
    const aliceRt = await createRuntime({ storage: aliceStorage, bootstrap });
    const bobRt = await createRuntime({ storage: bobStorage, bootstrap });
    const carolRt = await createRuntime({ storage: carolStorage, bootstrap });
    log(`  3 runtimes ready, configured to use bootstrap ${BOOTSTRAP_HOST}:${BOOTSTRAP_PORT}`);

    // ---------------------------------------------------------------------
    section('Alice creates the data log; appends sealed events');
    // ---------------------------------------------------------------------

    const dataLog = await aliceRt.createLog();
    for (const file of SAMPLE_FILES) {
      const event = changeEvent(alice.did(), file.path, file.content);
      const sealedEvent = seal(event, k0Org);
      await dataLog.append(sealedEvent);
    }
    log(`  appended ${SAMPLE_FILES.length} sealed events`);

    // ---------------------------------------------------------------------
    section('Topic join + replication over the private swarm');
    // ---------------------------------------------------------------------

    const topic = topicFromWorkspaceId(workspaceId);
    log(`  topic: ${topic.slice(0, 24)}…`);
    await aliceRt.joinTopic(topic);
    await bobRt.joinTopic(topic);
    await carolRt.joinTopic(topic);

    const bobLog = await bobRt.openLog(dataLog.key);
    const carolLog = await carolRt.openLog(dataLog.key);

    const deadlineMs = 30_000;
    const start = Date.now();
    let lastProgress = '';
    while (
      (bobLog.length < SAMPLE_FILES.length || carolLog.length < SAMPLE_FILES.length) &&
      Date.now() - start < deadlineMs
    ) {
      await new Promise((r) => setTimeout(r, 250));
      const progress = `bob=${bobLog.length}, carol=${carolLog.length}`;
      if (progress !== lastProgress) {
        log(`  progress: ${progress} (t+${Date.now() - start}ms)`);
        lastProgress = progress;
      }
    }

    if (bobLog.length < SAMPLE_FILES.length || carolLog.length < SAMPLE_FILES.length) {
      throw new Error(
        `replication timed out (bob=${bobLog.length}, carol=${carolLog.length}) — ` +
          `is the bootstrap node running on ${BOOTSTRAP_HOST}:${BOOTSTRAP_PORT}?`,
      );
    }
    log(`  replication: ${SAMPLE_FILES.length} blocks reached both peers in ${Date.now() - start}ms`);

    // ---------------------------------------------------------------------
    section('Decrypt + verify');
    // ---------------------------------------------------------------------

    for (let i = 0; i < bobLog.length; i++) {
      const sealed = await bobLog.get(i);
      const event = JSON.parse(dec.decode(open(sealed, bobK0))) as {
        actor: string;
        path: string;
        content: string;
      };
      log(`  bob   block[${i}]: ${event.path}`);
    }
    for (let i = 0; i < carolLog.length; i++) {
      const sealed = await carolLog.get(i);
      const event = JSON.parse(dec.decode(open(sealed, carolK0))) as {
        actor: string;
        path: string;
        content: string;
      };
      log(`  carol block[${i}]: ${event.path}`);
    }

    log('');
    log('OK — full bundle + sealed-log + private-swarm flow end-to-end');

    await aliceRt.close();
    await bobRt.close();
    await carolRt.close();
  } finally {
    if (inProcessBootstrap) {
      await inProcessBootstrap.destroy().catch(() => {});
    }
    await rm(tmpBase, { recursive: true, force: true });
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('FAIL:', err);
  process.exit(1);
});
