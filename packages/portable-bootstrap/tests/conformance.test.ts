// Tests for the format-invariant conformance checker.
//
// Two halves, and the second is the point:
//
//   1. A workspace this codebase produces satisfies the invariants.
//   2. A workspace that violates one is CAUGHT. A checker that only ever
//      sees good input proves nothing — #233 happened because everyone
//      looked at the happy path.
//
// The `keys/` case below is the real bug, reconstructed: a tree that has had
// `.workspace/keys/` copied into it, which is exactly what the mobile seed
// produced on every device it touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { principalFromSeed } from '@workspace.sh/ucan-boundary';
import {
  assertWorkspaceInvariants,
  checkWorkspaceInvariants,
  createBundle,
  writeBundleFolder,
  type CapabilityDescriptor,
} from '../src/index.ts';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hypercoreCrypto = require('hypercore-crypto') as any;

const RESOURCE = 'workspace://wid-conformance/data';
const CAN: CapabilityDescriptor = { can: 'workspace/read', with: RESOURCE };

function seededKey(byte: number): { publicKey: Buffer; secretKey: Buffer } {
  const seed = new Uint8Array(32);
  seed.fill(byte);
  return hypercoreCrypto.keyPair(Buffer.from(seed)) as {
    publicKey: Buffer;
    secretKey: Buffer;
  };
}

/** A real workspace on disk, with a small working tree beside the container. */
async function makeWorkspace(fn: (dir: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-conformance-'));
  const dir = join(base, 'acme.workspace');
  try {
    const rootKp = seededKey(41);
    const aliceKp = seededKey(42);
    const root = await principalFromSeed(rootKp.secretKey.subarray(0, 32));
    const alice = await principalFromSeed(aliceKp.secretKey.subarray(0, 32));
    const k0 = new Uint8Array(32);
    crypto.getRandomValues(k0);

    const bundle = await createBundle({
      workspaceId: 'wid-conformance',
      createdAt: 1717200000,
      root,
      rootSecretKey: rootKp.secretKey,
      recipients: [{ did: alice.did(), resource: RESOURCE, key: k0, capability: CAN }],
    });
    await writeBundleFolder(bundle, dir);

    // A plausible working tree, including a decoy `keys/` folder that a user
    // may legitimately have and which must NOT be flagged.
    await mkdir(join(dir, 'policies'), { recursive: true });
    await writeFile(join(dir, 'policies', 'code-of-conduct.md'), '# CoC\n', 'utf8');
    await mkdir(join(dir, 'keys'), { recursive: true });
    await writeFile(join(dir, 'keys', 'notes-about-keys.md'), '# not secret\n', 'utf8');

    await fn(dir);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test('a workspace written by writeBundleFolder satisfies the invariants', async () => {
  await makeWorkspace(async dir => {
    assert.deepEqual(await checkWorkspaceInvariants(dir), []);
    await assert.doesNotReject(assertWorkspaceInvariants(dir));
  });
});

test('a plain cp -R of a workspace is still a valid workspace (invariant 5)', async () => {
  await makeWorkspace(async dir => {
    const copy = `${dir}-copy`;
    // fs.cp is what a backup tool or Finder drag does: bytes, no app.
    const { cp } = await import('fs/promises');
    await cp(dir, copy, { recursive: true });
    assert.deepEqual(await checkWorkspaceInvariants(copy), []);
  });
});

test('a legitimate keys/ folder in the working tree is not flagged', async () => {
  // The distinction the seed fix turned on: only `.workspace/keys` is private
  // key state. Matching on basename would break a user's own folder.
  await makeWorkspace(async dir => {
    const violations = await checkWorkspaceInvariants(dir);
    assert.equal(violations.length, 0, JSON.stringify(violations));
  });
});

// ---------------------------------------------------------------------------
// The violations — a checker that never fires is worth nothing
// ---------------------------------------------------------------------------

test('REGRESSION #233: a seeded .workspace/keys/ is caught', async () => {
  await makeWorkspace(async dir => {
    // Exactly what the mobile seed produced: another peer's identity, copied.
    await mkdir(join(dir, '.workspace', 'keys'), { recursive: true });
    await writeFile(
      join(dir, '.workspace', 'keys', 'identity.json'),
      '{"secret":"…"}\n',
      'utf8',
    );

    const violations = await checkWorkspaceInvariants(dir);
    assert.equal(violations.length, 1, JSON.stringify(violations));
    assert.equal(violations[0]!.invariant, 6);
    assert.match(violations[0]!.path, /\.workspace[/\\]keys$/);
    await assert.rejects(assertWorkspaceInvariants(dir), /invariant 6/);
  });
});

test('metadata scattered outside .workspace/ is caught (invariant 1)', async () => {
  await makeWorkspace(async dir => {
    await writeFile(join(dir, '.workspace-state'), 'stray\n', 'utf8');
    const violations = await checkWorkspaceInvariants(dir);
    assert.equal(violations.length, 1, JSON.stringify(violations));
    assert.equal(violations[0]!.invariant, 1);
  });
});

test('a mutable lock file is caught (invariant 4)', async () => {
  await makeWorkspace(async dir => {
    // The thing that cannot survive a Dropbox conflicted-copy race.
    await writeFile(join(dir, '.workspace', 'store.lock'), '', 'utf8');
    const violations = await checkWorkspaceInvariants(dir);
    assert.ok(violations.some(v => v.invariant === 4), JSON.stringify(violations));
  });
});

test('an unrecognised entry in .workspace/ is caught (invariant 1)', async () => {
  await makeWorkspace(async dir => {
    await writeFile(join(dir, '.workspace', 'scratch.json'), '{}\n', 'utf8');
    const violations = await checkWorkspaceInvariants(dir);
    assert.ok(
      violations.some(v => v.invariant === 1 && v.path.includes('scratch.json')),
      JSON.stringify(violations),
    );
  });
});

test('a missing manifest is caught', async () => {
  await makeWorkspace(async dir => {
    await rm(join(dir, '.workspace', 'manifest.json'));
    const violations = await checkWorkspaceInvariants(dir);
    assert.ok(violations.some(v => v.message.includes('manifest.json')));
  });
});

test('a corrupt manifest is caught rather than crashing the check', async () => {
  await makeWorkspace(async dir => {
    await writeFile(join(dir, '.workspace', 'manifest.json'), 'not json', 'utf8');
    const violations = await checkWorkspaceInvariants(dir);
    assert.ok(violations.some(v => v.invariant === 5), JSON.stringify(violations));
  });
});

test('a tree with no .workspace/ is not a workspace', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-conformance-bare-'));
  try {
    await writeFile(join(base, 'a.md'), '# hi\n', 'utf8');
    const violations = await checkWorkspaceInvariants(base);
    assert.ok(violations.some(v => v.invariant === 1));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Export mode — the other half of invariant 6
// ---------------------------------------------------------------------------

test('an export that still carries .workspace/ is caught (invariant 6)', async () => {
  await makeWorkspace(async dir => {
    const violations = await checkWorkspaceInvariants(dir, { export: true });
    assert.ok(violations.some(v => v.invariant === 6), JSON.stringify(violations));
  });
});

test('a true plaintext export passes in export mode', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-conformance-export-'));
  try {
    await mkdir(join(base, 'policies'), { recursive: true });
    await writeFile(join(base, 'policies', 'coc.md'), '# CoC\n', 'utf8');
    assert.deepEqual(await checkWorkspaceInvariants(base, { export: true }), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('REGRESSION #249: a manifest naming logs without transport dirs is a stub, and caught', async () => {
  await makeWorkspace(async dir => {
    // Graft log keys into the manifest without creating store/v1/ dirs —
    // exactly the shape a pre-ADR-0003 workspace left on disk.
    const manifestPath = join(dir, '.workspace', 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.logs = { data: 'a'.repeat(64), keyDelivery: 'b'.repeat(64) };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    const violations = await checkWorkspaceInvariants(dir);
    assert.equal(violations.filter(v => v.invariant === 5).length, 2, JSON.stringify(violations));

    // And with the dirs present, clean again.
    await mkdir(join(dir, '.workspace', 'store', 'v1', 'a'.repeat(64)), { recursive: true });
    await mkdir(join(dir, '.workspace', 'store', 'v1', 'b'.repeat(64)), { recursive: true });
    assert.deepEqual(await checkWorkspaceInvariants(dir), []);
  });
});
