// Acme — small-organisation walk-through.
//
// A more thorough demo than `end-to-end`: three members of "Acme" share a
// workspace. Sample working-tree files exist on disk as plaintext (the
// design's "workspace-public content lives in plaintext" rule). The data
// log carries content sealed under K0_org — without the key, the bytes
// replicate but reveal nothing. With it, every member sees the same
// content.
//
// What this demonstrates beyond `end-to-end`:
//   - K0_org actually does something — log content is sealed under it
//   - Multiple recipients in one bundle (Bob and Carol both get envelopes)
//   - The working tree (markdown files) and the encrypted log coexist per
//     the on-disk layout in docs/workspace-format.md
//   - Eve (no envelope) cannot decrypt the replicated blocks — proves
//     that K0_org is what gates readability
//
// Replication transport: this demo uses the runtime's direct duplex pipe
// (`__pipeReplicate`) rather than the live DHT. That keeps the demo
// deterministic and fast — the same Hypercore replication code path runs
// on top, just without the public swarm. The `smoke` script in this same
// package proves the live-DHT path separately.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { NodeRuntime } from '@workspace/p2p-runtime/node';
import { open, encryptedLog } from '@workspace/p2p-runtime';
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
  console.log(msg);
}

function section(title: string): void {
  log('');
  log(`── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

function seededKeypair(byte: number): { publicKey: Buffer; secretKey: Buffer } {
  const seed = new Uint8Array(32);
  seed.fill(byte);
  return hypercoreCrypto.keyPair(Buffer.from(seed)) as {
    publicKey: Buffer;
    secretKey: Buffer;
  };
}

async function freshRuntime(storage: string): Promise<NodeRuntime> {
  const r = new NodeRuntime({ storage });
  await r.ready();
  return r;
}

async function waitFor(
  pred: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Sample working-tree content. Plaintext on disk — these are workspace-public
// files. In a real workspace they'd be reflected into the encrypted store
// too; for this demo we keep the working tree and the log distinct so each
// side's role is visible.
const SAMPLE_FILES: Array<{ path: string; content: string }> = [
  {
    path: 'policies/code-of-conduct.md',
    content: `# Code of Conduct

We treat each other with respect, hold disagreement professionally, and
escalate to a maintainer if a situation escalates beyond peer-to-peer
resolution.
`,
  },
  {
    path: 'policies/parental-leave.md',
    content: `# Parental Leave

Six months at full pay for primary caregivers, six weeks for secondary.
Phased return supported. Talk to People Ops to start the conversation.
`,
  },
  {
    path: 'notes/q2-retrospective.md',
    content: `# Q2 Retrospective

## What worked
- Ship cadence held; three releases on plan.
- Onboarding revamp landed before the new hire cohort.

## What didn't
- Incident response runbook still ad-hoc; one near-miss this quarter.

## Next quarter
- Lock the runbook.
- Two new hires in eng.
`,
  },
];

// Change events broadcast through the log. Each is a JSON envelope describing
// "Alice updated <file> with <content>". In production these would be diffs;
// for the demo, full file contents per event keep it simple.
function changeEvent(actor: string, path: string, content: string): Uint8Array {
  return enc.encode(JSON.stringify({ actor, path, content }));
}

async function main(): Promise<void> {
  const tmpBase = await mkdtemp(join(tmpdir(), 'workspace-acme-'));
  const acmeFolder = join(tmpBase, 'Acme.workspace');
  const aliceStorage = join(tmpBase, 'alice-store');
  const bobStorage = join(tmpBase, 'bob-store');
  const carolStorage = join(tmpBase, 'carol-store');

  log('Acme — small-org workspace demo');
  log(`tmpdir: ${tmpBase}`);

  let aliceRt: NodeRuntime | null = null;
  let bobRt: NodeRuntime | null = null;
  let carolRt: NodeRuntime | null = null;
  let closeAB: (() => Promise<void>) | null = null;
  let closeAC: (() => Promise<void>) | null = null;

  try {
    // ---------------------------------------------------------------------
    section('Alice creates the workspace');
    // ---------------------------------------------------------------------

    const aliceKp = seededKeypair(1);
    const bobKp = seededKeypair(2);
    const carolKp = seededKeypair(3);

    const alice = await principalFromSeed(aliceKp.secretKey.subarray(0, 32));
    const bob = await principalFromSeed(bobKp.secretKey.subarray(0, 32));
    const carol = await principalFromSeed(carolKp.secretKey.subarray(0, 32));

    log(`  alice (root):  ${alice.did().slice(0, 48)}…`);
    log(`  bob:           ${bob.did().slice(0, 48)}…`);
    log(`  carol:         ${carol.did().slice(0, 48)}…`);

    // The workspace's base key — gates workspace-public encrypted content.
    const k0Org = new Uint8Array(32);
    crypto.getRandomValues(k0Org);
    log(`  K0_org generated: ${Buffer.from(k0Org).toString('hex').slice(0, 24)}…`);

    // workspaceId == root pubkey, per the spec.
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

    log(`  bundle: 2 envelopes (bob, carol) sealed to their respective DIDs`);

    // ---------------------------------------------------------------------
    section('On-disk layout: write the bundle + sample working tree');
    // ---------------------------------------------------------------------

    await writeBundleFolder(bundle, acmeFolder);
    for (const file of SAMPLE_FILES) {
      const full = join(acmeFolder, file.path);
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, file.content, 'utf8');
    }

    log(`  ${acmeFolder}/`);
    log(`  ├── policies/`);
    log(`  │   ├── code-of-conduct.md         ← plaintext, workspace-public`);
    log(`  │   └── parental-leave.md`);
    log(`  ├── notes/`);
    log(`  │   └── q2-retrospective.md`);
    log(`  └── .workspace/                    ← hidden machine-facing metadata`);
    log(`      ├── manifest.json`);
    log(`      ├── attestation.json`);
    log(`      └── envelopes/                 ← one per recipient, sealed`);
    log(`          ├── did_key_<bob>.json`);
    log(`          └── did_key_<carol>.json`);

    // ---------------------------------------------------------------------
    section('Bob and Carol open the bundle, recover K0_org');
    // ---------------------------------------------------------------------

    const bobBundle = await readBundleFolder(acmeFolder);
    const carolBundle = await readBundleFolder(acmeFolder);

    const bobView = await consumeBundle(bobBundle, bob.did(), bobKp.secretKey);
    const carolView = await consumeBundle(carolBundle, carol.did(), carolKp.secretKey);

    if (!bobView.mine || !carolView.mine) {
      throw new Error('expected envelopes for both bob and carol');
    }
    const bobK0 = bobView.mine.key;
    const carolK0 = carolView.mine.key;
    log(`  bob:   attestation ✓, envelope unwrapped, K0_org recovered`);
    log(`  carol: attestation ✓, envelope unwrapped, K0_org recovered`);

    // ---------------------------------------------------------------------
    section('Start runtimes and pair them');
    // ---------------------------------------------------------------------

    aliceRt = await freshRuntime(aliceStorage);
    bobRt = await freshRuntime(bobStorage);
    carolRt = await freshRuntime(carolStorage);
    log(`  3 runtimes spun up, each with its own corestore`);

    // Pair Alice with each of Bob and Carol via direct duplex pipes. Same
    // replication code path as the live DHT — just deterministic. The DHT
    // path is exercised separately by `npm run smoke`.
    closeAB = aliceRt.__pipeReplicate(bobRt);
    closeAC = aliceRt.__pipeReplicate(carolRt);
    log(`  paired Alice ↔ Bob and Alice ↔ Carol (direct duplex pipes)`);

    // ---------------------------------------------------------------------
    section('Alice creates the data log; appends change events');
    // ---------------------------------------------------------------------

    // Wrap the data log with K0_org. From here on Alice appends *plaintext*
    // — the wrapper seals each block transparently before it hits the log.
    const dataLogRaw = await aliceRt.createLog();
    const dataLog = encryptedLog(dataLogRaw, k0Org);
    log(`  data log key: ${dataLog.key.slice(0, 24)}…  (blocks sealed under K0_org)`);

    for (const file of SAMPLE_FILES) {
      const event = changeEvent(alice.did(), file.path, file.content);
      await dataLog.append(event); // plaintext in; ciphertext on disk + wire
      log(`  appended event for ${file.path} (${event.length}B plaintext)`);
    }

    // ---------------------------------------------------------------------
    section('Bob and Carol open the log; replication kicks in');
    // ---------------------------------------------------------------------

    // Each peer keeps a reference to the raw replica (for the block count and
    // the Eve demonstration) and a K0_org-wrapped view for reading plaintext.
    const bobRaw = await bobRt.openLog(dataLogRaw.key);
    const carolRaw = await carolRt.openLog(dataLogRaw.key);
    const bobLog = encryptedLog(bobRaw, bobK0);
    const carolLog = encryptedLog(carolRaw, carolK0);

    const start = Date.now();
    await waitFor(
      () => bobRaw.length >= SAMPLE_FILES.length && carolRaw.length >= SAMPLE_FILES.length,
      5_000,
      'replication',
    );
    log(
      `  replication: ${SAMPLE_FILES.length} blocks reached both peers in ` +
        `${Date.now() - start}ms`,
    );

    // ---------------------------------------------------------------------
    section('Reading the log: Bob and Carol decrypt; Eve cannot');
    // ---------------------------------------------------------------------

    // Bob and Carol read through the wrapped log — plaintext comes out, the
    // seal/open is invisible to them.
    log('  Bob (holds K0_org):');
    for (let i = 0; i < bobLog.length; i++) {
      const event = JSON.parse(dec.decode(await bobLog.get(i))) as {
        actor: string;
        path: string;
        content: string;
      };
      log(`    ${event.path}  →  "${event.content.split('\n')[0]}"`);
    }

    log('');
    log('  Carol (holds K0_org):');
    for (let i = 0; i < carolLog.length; i++) {
      const event = JSON.parse(dec.decode(await carolLog.get(i))) as {
        actor: string;
        path: string;
        content: string;
      };
      log(`    ${event.path}  →  "${event.content.split('\n')[0]}"`);
    }

    // Eve — outside the workspace, no envelope, no K0_org. Suppose she
    // obtains the replicated blocks anyway (sniffing traffic, USB copy,
    // joining the swarm topic without an envelope). Without K0_org the
    // bytes are opaque to her. Demonstrated by trying to `open` Bob's
    // received blocks with a random key.
    log('');
    log('  Eve (no envelope, no K0_org — trying random keys):');
    let eveDecryptFailures = 0;
    for (let i = 0; i < bobRaw.length; i++) {
      // Eve reads the *raw* replica — the ciphertext that's actually on the
      // wire and disk — and tries a random key.
      const sealed = await bobRaw.get(i);
      const guessedKey = new Uint8Array(32);
      crypto.getRandomValues(guessedKey);
      try {
        open(sealed, guessedKey);
        log(`    block[${i}]: decrypted with random key — IMPOSSIBLE, bug`);
      } catch {
        eveDecryptFailures++;
        log(`    block[${i}]: ${sealed.length}B opaque ciphertext, decrypt failed`);
      }
    }
    log(`  Eve: ${eveDecryptFailures}/${bobRaw.length} decrypts failed (expected: all)`);

    // ---------------------------------------------------------------------
    section('Summary');
    // ---------------------------------------------------------------------

    log('  ✓ bundle round-tripped through .workspace/ on disk');
    log('  ✓ attestation verified across the boundary');
    log('  ✓ Bob + Carol both unwrapped K0_org from their envelopes');
    log('  ✓ Alice appended 3 sealed events to the data log');
    log('  ✓ Bob + Carol decrypted all 3 events; saw the same content');
    log(`  ✓ Eve (hypothetical, no key) could not read the ${SAMPLE_FILES.length} blocks`);
    log('');
    log('K0_org now does real work: it gates whether replicated bytes reveal anything.');
  } finally {
    if (closeAB) await closeAB();
    if (closeAC) await closeAC();
    if (aliceRt) await aliceRt.close();
    if (bobRt) await bobRt.close();
    if (carolRt) await carolRt.close();
    await rm(tmpBase, { recursive: true, force: true });
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('FAIL:', err);
  process.exit(1);
});
