// Tests for the Workspace SDK facade (src/index.ts).
//
// A fake in-memory runtime with a shared backing store lets two Workspace
// instances — a creator (admin) and an opener (member) — share logs
// deterministically, exercising the full facade flow (bundle write/read,
// envelope delivery, K0_org recovery, encrypted round-trip, invite) without
// a network or native deps. The real-swarm proof lives in
// apps/node/src/demos/workspace-sdk.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { didFromSeed, type CreateRuntimeOptions, type Log, type LogKey, type P2PRuntime, type Did } from '@workspace/p2p-runtime';
import { Workspace } from '../src/index.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------------------
// Fake runtime: a shared backing store across all runtimes from one factory,
// so createLog on peer A and openLog(sameKey) on peer B see the same blocks.
// ---------------------------------------------------------------------------

interface Backing {
  blocks: Uint8Array[];
  listeners: Set<() => void>;
}

function makeRuntimeFactory() {
  const store = new Map<string, Backing>();
  let counter = 0;

  function viewOf(key: string, writable: boolean): Log {
    const backing = store.get(key)!;
    return {
      key: key as LogKey,
      writable,
      get length() {
        return backing.blocks.length;
      },
      async append(b: Uint8Array) {
        backing.blocks.push(b);
        for (const cb of backing.listeners) cb();
        return backing.blocks.length;
      },
      async get(i: number) {
        return backing.blocks[i]!;
      },
      on(_event: 'append', cb: () => void) {
        backing.listeners.add(cb);
        return () => backing.listeners.delete(cb);
      },
      async close() {},
    };
  }

  const factory = async (opts: CreateRuntimeOptions): Promise<P2PRuntime> => {
    const did: Did = opts.identitySeed ? didFromSeed(opts.identitySeed) : ('did:key:zFake' as Did);
    return {
      async ready() {},
      did() {
        return did;
      },
      async createLog() {
        const key = `log${counter++}`.padEnd(8, '0');
        store.set(key, { blocks: [], listeners: new Set() });
        return viewOf(key, true);
      },
      async openLog(key: LogKey) {
        if (!store.has(key)) store.set(key, { blocks: [], listeners: new Set() });
        return viewOf(key, false);
      },
      async joinTopic() {},
      async leaveTopic() {},
      async close() {},
    } as P2PRuntime;
  };

  return factory;
}

async function withTmp(fn: (folder: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-sdk-test-'));
  try {
    await fn(join(base, 'Acme.workspace'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

const ROOT_SEED = new Uint8Array(32).fill(1);
const BOB_SEED = new Uint8Array(32).fill(2);
const EVE_SEED = new Uint8Array(32).fill(3);

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

test('create: produces an admin workspace with a stable id and root identity', async () => {
  const createRuntime = makeRuntimeFactory();
  await withTmp(async (folder) => {
    const ws = await Workspace.create({ createRuntime, folder, name: 'Acme', rootSeed: ROOT_SEED });
    assert.equal(ws.isAdmin, true);
    assert.equal(ws.did, ws.rootDid); // creator IS root in v1
    assert.equal(ws.did, didFromSeed(ROOT_SEED));
    assert.ok(ws.id.length === 64); // root pubkey hex
    assert.equal(ws.length, 0);
    await ws.close();
  });
});

test('write + entries: round-trips through the encrypted log', async () => {
  const createRuntime = makeRuntimeFactory();
  await withTmp(async (folder) => {
    const ws = await Workspace.create({ createRuntime, folder, rootSeed: ROOT_SEED });
    await ws.write(enc.encode('first'));
    await ws.write(enc.encode('second'));
    const entries = await ws.entries();
    assert.deepEqual(entries.map((e) => dec.decode(e)), ['first', 'second']);
    await ws.close();
  });
});

test('on(change) fires when an entry is appended', async () => {
  const createRuntime = makeRuntimeFactory();
  await withTmp(async (folder) => {
    const ws = await Workspace.create({ createRuntime, folder, rootSeed: ROOT_SEED });
    let fired = 0;
    const off = ws.on('change', () => fired++);
    await ws.write(enc.encode('x'));
    await ws.write(enc.encode('y'));
    off();
    await ws.write(enc.encode('z'));
    assert.equal(fired, 2);
    await ws.close();
  });
});

// ---------------------------------------------------------------------------
// Invite + open (two peers, shared backing)
// ---------------------------------------------------------------------------

test('invite + open: an invited member opens the folder and reads the data', async () => {
  const createRuntime = makeRuntimeFactory(); // shared backing across both peers
  await withTmp(async (folder) => {
    const admin = await Workspace.create({ createRuntime, folder, rootSeed: ROOT_SEED });
    await admin.write(enc.encode('members only'));

    const bobDid = didFromSeed(BOB_SEED);
    await admin.invite(bobDid);

    // Bob opens the same folder with his identity seed.
    const bob = await Workspace.open({ createRuntime, folder, identitySeed: BOB_SEED });
    assert.equal(bob.isAdmin, false);
    assert.equal(bob.did, bobDid);
    assert.equal(bob.rootDid, admin.rootDid);
    assert.equal(bob.id, admin.id);

    const entries = await bob.entries();
    assert.deepEqual(entries.map((e) => dec.decode(e)), ['members only']);

    await admin.close();
    await bob.close();
  });
});

test('open without an envelope is rejected', async () => {
  const createRuntime = makeRuntimeFactory();
  await withTmp(async (folder) => {
    const admin = await Workspace.create({ createRuntime, folder, rootSeed: ROOT_SEED });
    // Eve was never invited.
    await assert.rejects(
      () => Workspace.open({ createRuntime, folder, identitySeed: EVE_SEED }),
      /no envelope addressed to/,
    );
    await admin.close();
  });
});

test('a member cannot invite (no root key)', async () => {
  const createRuntime = makeRuntimeFactory();
  await withTmp(async (folder) => {
    const admin = await Workspace.create({ createRuntime, folder, rootSeed: ROOT_SEED });
    await admin.invite(didFromSeed(BOB_SEED));
    const bob = await Workspace.open({ createRuntime, folder, identitySeed: BOB_SEED });

    await assert.rejects(() => bob.invite(didFromSeed(EVE_SEED)), /only an admin/);

    await admin.close();
    await bob.close();
  });
});

// ---------------------------------------------------------------------------
// Live propagation across the shared backing
// ---------------------------------------------------------------------------

test('a write by the admin propagates to an open member via change events', async () => {
  const createRuntime = makeRuntimeFactory();
  await withTmp(async (folder) => {
    const admin = await Workspace.create({ createRuntime, folder, rootSeed: ROOT_SEED });
    await admin.invite(didFromSeed(BOB_SEED));
    const bob = await Workspace.open({ createRuntime, folder, identitySeed: BOB_SEED });

    let bobSaw = 0;
    bob.on('change', () => bobSaw++);

    await admin.write(enc.encode('hello bob'));

    assert.equal(bobSaw, 1);
    const entries = await bob.entries();
    assert.equal(dec.decode(entries[entries.length - 1]!), 'hello bob');

    await admin.close();
    await bob.close();
  });
});
