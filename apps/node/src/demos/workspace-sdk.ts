// Workspace SDK facade — the same Acme story, now in a handful of lines.
//
// Compare this to acme-org-live.ts (~200 lines of hand-wiring runtime +
// bundle + envelopes + encryptedLog + topic derivation). The facade hides all
// of it behind Workspace.create / .invite / .write / .open / .entries. This
// is the surface the Workspace app is built against.
//
// Runs over a real Hyperswarm against a private in-process bootstrap (no
// public DHT). Alice creates a workspace and invites Bob; Bob opens the
// folder, the membership gate accepts both peers, and Bob replicates +
// decrypts Alice's entry. Eve (uninvited) can't even open.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { createRuntime } from '@workspace.sh/p2p-runtime/node';
import { didFromSeed } from '@workspace.sh/p2p-runtime';
import { Workspace } from '@workspace.sh/workspace';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DHT = require('hyperdht') as any;

const enc = new TextEncoder();
const dec = new TextDecoder();

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}
function section(t: string): void {
  log('');
  log(`── ${t} ${'─'.repeat(Math.max(0, 56 - t.length))}`);
}
function seed(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

async function main(): Promise<void> {
  const bootstrapNode = DHT.bootstrapper(49739, '127.0.0.1');
  await bootstrapNode.ready();
  const bootstrap = [{ host: '127.0.0.1', port: 49739 }];

  const base = await mkdtemp(join(tmpdir(), 'ws-sdk-'));
  const folder = join(base, 'Acme.workspace');

  log('Workspace SDK — Acme, the short version');

  let admin: Workspace | null = null;
  let bob: Workspace | null = null;
  try {
    // === The whole app-facing flow ===
    section('Alice creates the workspace and invites Bob');
    admin = await Workspace.create({
      createRuntime,
      folder,
      name: 'Acme',
      rootSeed: seed(1),
      storage: join(base, 'alice-store'),
      bootstrap,
    });
    log(`  workspace id: ${admin.id.slice(0, 24)}…  (admin: ${admin.isAdmin})`);

    await admin.write(enc.encode(JSON.stringify({ path: 'welcome.md', body: 'Members only.' })));

    const bobDid = didFromSeed(seed(2));
    await admin.invite(bobDid);
    log(`  invited bob (${bobDid.slice(0, 28)}…)`);

    section('Bob opens the folder — gate accepts, data replicates');
    bob = await Workspace.open({
      createRuntime,
      folder,
      identitySeed: seed(2),
      storage: join(base, 'bob-store'),
      bootstrap,
    });
    log(`  bob opened (admin: ${bob.isAdmin}, same workspace: ${bob.id === admin.id})`);

    const start = Date.now();
    while (bob.length < 1 && Date.now() - start < 15_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (bob.length < 1) throw new Error('Bob did not replicate the data log');

    const entries = await bob.entries();
    const evt = JSON.parse(dec.decode(entries[0]!)) as { path: string; body: string };
    log(`  bob read ${evt.path}: "${evt.body}" (${Date.now() - start}ms)`);

    section('Eve (uninvited) cannot open');
    try {
      await Workspace.open({
        createRuntime,
        folder,
        identitySeed: seed(9),
        storage: join(base, 'eve-store'),
        bootstrap,
      });
      log('  ✗ Eve opened — should not happen');
    } catch (err) {
      log(`  ✓ rejected: ${(err as Error).message.split('—')[0].trim()}`);
    }

    section('Summary');
    log('  ✓ Workspace.create — identity, K0_org, logs, bundle, topic: one call');
    log('  ✓ invite — sealed envelope to both carriers: one call');
    log('  ✓ open — attestation + envelope + K0_org + gate + replication: one call');
    log('  ✓ write / entries — encrypted log, transparent');
    log('');
    log('Same flow as acme-org-live.ts, ~10 lines instead of ~200.');
  } finally {
    if (admin) await admin.close();
    if (bob) await bob.close();
    await bootstrapNode.destroy();
    await rm(base, { recursive: true, force: true });
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('FAIL:', err);
  process.exit(1);
});
