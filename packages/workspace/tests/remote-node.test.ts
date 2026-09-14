// The Node IPC path, exercised through a real spawned child (#N).
//
// This module exists to prove the IPC layer with no native or Xcode
// involvement, and until now nothing tested the create half of it. The gap let
// a two-line omission survive: `createWorkspace` sent `rootSeedHex` and not
// `identitySeedHex`, so the child fell back to the root seed, sealed the
// bootstrap envelope to the ROOT's DID, and the machine that created the
// workspace could not reopen it.
//
// A grep says otherwise — `openWorkspace` in the same file does send it — which
// is why this is tested by round-tripping rather than by inspecting params. The
// assertion that matters is "the creating device can reopen its own workspace",
// and nothing weaker would have caught it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { didFromSeed } from '@workspace.sh/p2p-runtime';
import { NodeTransport } from '@workspace.sh/p2p-runtime/ipc';
import { RemoteWorkspace } from '../src/ipc/remote-base.ts';
import { createWorkspace, openWorkspace } from '../src/ipc/remote.node.ts';

const ROOT_SEED = new Uint8Array(32).fill(7);
// Deliberately NOT the root seed: the bug is invisible when they are equal.
const DEVICE_SEED = new Uint8Array(32).fill(11);

test('the device that creates a workspace can reopen it', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-remote-node-'));
  const folder = join(base, 'acme.workspace');
  try {
    const created = await createWorkspace({
      folder,
      name: 'Acme',
      storage: join(base, 'store'),
      rootSeed: ROOT_SEED,
      identitySeed: DEVICE_SEED,
      // No swarm: these tests copy folders, they never replicate (#254).
      bootstrap: [],
    });
    await created.close();

    // The same device, by the same seed. Without the fix this rejects with
    // "no envelope addressed to did:key:…" — the envelope was sealed to the
    // root's DID, and this device is not that.
    const reopened = await openWorkspace({
      folder,
      storage: join(base, 'store'),
      identitySeed: DEVICE_SEED,
      bootstrap: [],
    });
    assert.equal(typeof reopened.id, 'string');
    assert.ok(reopened.id.length > 0);
    await reopened.close();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('through a real child, the creating device reopens as an admin and invites', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-remote-admin-'));
  const folder = join(base, 'acme.workspace');
  const BOB_SEED = new Uint8Array(32).fill(13);
  try {
    const created = await createWorkspace({
      folder,
      name: 'Acme',
      storage: join(base, 'store'),
      rootSeed: ROOT_SEED,
      identitySeed: DEVICE_SEED,
      bootstrap: [],
    });
    await created.close();

    const admin = await openWorkspace({
      folder,
      storage: join(base, 'store'),
      identitySeed: DEVICE_SEED,
      rootSeed: ROOT_SEED,
      bootstrap: [],
    });
    assert.equal(admin.isAdmin, true);
    assert.equal(admin.writable, true, 'the creating store appends');
    await admin.invite(didFromSeed(BOB_SEED));
    await admin.close();

    const bob = await openWorkspace({
      folder,
      storage: join(base, 'bob-store'),
      identitySeed: BOB_SEED,
      bootstrap: [],
    });
    assert.equal(bob.isAdmin, false);
    assert.equal(bob.writable, false, 'an invited device reads');
    await bob.close();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a child whose parent goes away flushes its workspace into the folder before exiting', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ws-remote-quit-'));
  const folder = join(base, 'acme.workspace');
  try {
    // Driven through a transport this test owns, so it can do what quitting
    // does: close the pipe with the workspace still open, no wsClose sent.
    const transport = new NodeTransport({ scriptPath: new URL('../src/ipc/child-bin.ts', import.meta.url).pathname });
    const ws = await RemoteWorkspace.fromTransport(transport, {
      method: 'wsCreate',
      folder,
      name: 'Acme',
      storage: join(base, 'store'),
      rootSeedHex: Buffer.from(ROOT_SEED).toString('hex'),
      identitySeedHex: Buffer.from(DEVICE_SEED).toString('hex'),
      bootstrap: [],
    });
    // Written, and closed well inside the 2 s the workspace waits before it
    // copies a quiet log into the folder by itself.
    await ws.write(new TextEncoder().encode('written just before quitting'));
    await transport.close();

    // What is in the FOLDER: a fresh store, hydrated from it alone.
    const copy = await openWorkspace({ folder, storage: join(base, 'fresh-store'), identitySeed: DEVICE_SEED, bootstrap: [] });
    const contents = (await copy.entries()).map((e) => new TextDecoder().decode(e));
    await copy.close();
    assert.deepEqual(contents, ['written just before quitting']);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
