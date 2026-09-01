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

import { didFromSeed, type CreateRuntimeOptions, type Log, type LogKey, type P2PRuntime, type Did } from '@workspace.sh/p2p-runtime';
import { readBundleFolder } from '@workspace.sh/portable-bootstrap';

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

test('the creator can close and reopen their own workspace', async () => {
  const createRuntime = makeRuntimeFactory();
  await withTmp(async (folder) => {
    const admin = await Workspace.create({ createRuntime, folder, rootSeed: ROOT_SEED });
    const rootDid = admin.rootDid;
    const id = admin.id;
    await admin.write(enc.encode('written before closing'));
    await admin.close();

    // The gap this covers: `create` built the creator's envelope, took its
    // UCAN for the auth gate and discarded it, so the folder was written with
    // no envelopes. Everything worked until the process that created the
    // workspace went away — and then its own author was locked out. Being
    // root is not what `open` checks; it looks for an envelope addressed to
    // the opening DID, exactly as it does for anyone else.
    const reopened = await Workspace.open({ createRuntime, folder, identitySeed: ROOT_SEED });
    assert.equal(reopened.id, id);
    assert.equal(reopened.rootDid, rootDid);
    assert.equal(reopened.did, rootDid);

    const entries = await reopened.entries();
    assert.deepEqual(entries.map((e) => dec.decode(e)), ['written before closing']);

    await reopened.close();
  });
});

test('create: records the creator as a member on disk, not only in memory', async () => {
  const createRuntime = makeRuntimeFactory();
  await withTmp(async (folder) => {
    const admin = await Workspace.create({ createRuntime, folder, rootSeed: ROOT_SEED });
    await admin.close();

    // Asserted against the folder rather than a reopened handle, so a
    // regression is reported as "nothing was persisted" rather than as a
    // failure further downstream.
    const bundle = await readBundleFolder(folder);
    assert.equal(bundle.envelopes.length, 1);
    const [selfEnvelope] = bundle.envelopes;
    assert.ok(selfEnvelope, 'the creator should have an envelope written to disk');
    assert.equal(selfEnvelope.recipient, didFromSeed(ROOT_SEED));
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


// ---------------------------------------------------------------------------
// Local-first open (#313)
// ---------------------------------------------------------------------------
//
// Measured on a cellular connection: opening the corestore takes 73 ms and
// flushing the DHT announce takes 40 SECONDS. `create` and `open` awaited that
// announce before returning, so every local operation waited on a network
// round trip — which is not what local-first means.

/** The standard fake, with `joinTopic` replaced. */
function factoryWithJoin(
  joinTopic: () => Promise<void>,
  replicates?: boolean,
): (opts: CreateRuntimeOptions) => Promise<P2PRuntime> {
  const base = makeRuntimeFactory();
  return async (opts) => {
    const runtime = await base(opts);
    return { ...runtime, joinTopic, ...(replicates === undefined ? {} : { replicates }) } as P2PRuntime;
  };
}

test('create does not wait for the swarm announce', async () => {
  // The announce never settles. If `create` awaited it this would hang rather
  // than fail — which is exactly what the app did for 40 seconds.
  let release: (() => void) | null = null;
  const createRuntime = factoryWithJoin(
    () => new Promise<void>((resolve) => { release = resolve; }),
  );

  await withTmp(async (folder) => {
    const started = Date.now();
    const ws = await Workspace.create({ createRuntime, folder, name: 'Acme', rootSeed: ROOT_SEED });
    // Generous: the point is "did not wait for something that never happens",
    // not a performance assertion that would flake on a loaded machine.
    assert.ok(Date.now() - started < 5000, 'create returned without the announce');
    assert.equal(ws.isAdmin, true, 'and the workspace is fully usable');
    await ws.write(new TextEncoder().encode('a local write, with no network'));
    assert.equal(ws.length, 1);
    release?.();
    await ws.close();
  });
});

test('a failed announce does not fail the open, and stays observable', async () => {
  // A restricted network is a normal condition — carrier NAT blocks the UDP
  // hole-punching an announce needs — and must not deny someone their own
  // files. But it has to be inspectable rather than silent, or "no peers
  // nearby" and "never announced" look identical.
  const createRuntime = factoryWithJoin(() => Promise.reject(new Error('no route to host')));

  await withTmp(async (folder) => {
    const ws = await Workspace.create({ createRuntime, folder, name: 'Acme', rootSeed: ROOT_SEED });
    await assert.rejects(() => ws.announced, /no route to host/);
    // Still fully usable.
    await ws.write(new TextEncoder().encode('written anyway'));
    assert.equal(ws.length, 1);
    await ws.close();
  });
});

test('a local-only runtime never announces, and resolves rather than throwing', async () => {
  const createRuntime = factoryWithJoin(
    () => Promise.reject(new Error('joinTopic must not be called on a local-only runtime')),
    false,
  );

  await withTmp(async (folder) => {
    const ws = await Workspace.create({ createRuntime, folder, name: 'Acme', rootSeed: ROOT_SEED });
    await ws.announced; // resolves; would reject if joinTopic had been called
    await ws.close();
  });
});

// ---------------------------------------------------------------------------
// One root keypair per workspace (#317)
// ---------------------------------------------------------------------------
//
// `workspace-format.md` resolves this explicitly: "Orgs with multiple
// workspaces create multiple `.workspace` folders, each with its own root
// keypair." The desktop app was passing the device's identity seed as the root
// seed, so every workspace made on one machine had the same id — and since the
// swarm topic is a hash of that id, the same topic too.

test('two workspaces created from one device identity have different ids', async () => {
  // The regression. `workspaceId` is the root public key, so a shared root
  // seed is a shared identity: the sidebar deduped one away, and peers would
  // have been told two different workspaces were the same one.
  const DEVICE_SEED = new Uint8Array(32).fill(9);
  const createRuntime = makeRuntimeFactory();

  await withTmp(async (folder) => {
    const a = await Workspace.create({ createRuntime, folder, name: 'A', identitySeed: DEVICE_SEED });
    const b = await Workspace.create({
      createRuntime,
      folder: `${folder}-second`,
      name: 'B',
      identitySeed: DEVICE_SEED,
    });

    assert.notEqual(a.id, b.id, 'each workspace has its own root keypair');
    // Same device, so the same peer identity in both — which is the point:
    // one machine, many workspaces.
    assert.equal(a.did, b.did);
    assert.equal(a.did, didFromSeed(DEVICE_SEED));
    await a.close();
    await b.close();
  });
});

test('the creator can reopen a workspace whose root is not their device key', async () => {
  // The trap in this fix. `open` looks for an envelope addressed to the
  // OPENING device; create used to address it to the root. That only worked
  // while the two seeds were the same value, so making the root seed random
  // without moving the envelope would have given unique ids and broken
  // reopening — worse than the bug.
  const DEVICE_SEED = new Uint8Array(32).fill(9);
  const createRuntime = makeRuntimeFactory();

  await withTmp(async (folder) => {
    const created = await Workspace.create({
      createRuntime,
      folder,
      name: 'Acme',
      identitySeed: DEVICE_SEED,
    });
    const id = created.id;
    await created.write(new TextEncoder().encode('before close'));
    await created.close();

    const reopened = await Workspace.open({ createRuntime, folder, identitySeed: DEVICE_SEED });
    assert.equal(reopened.id, id, 'same workspace');
    assert.equal(reopened.did, didFromSeed(DEVICE_SEED));
    await reopened.close();
  });
});

test('a workspace root identity is not the creator device identity', async () => {
  const DEVICE_SEED = new Uint8Array(32).fill(9);
  const createRuntime = makeRuntimeFactory();
  await withTmp(async (folder) => {
    const ws = await Workspace.create({ createRuntime, folder, name: 'Acme', identitySeed: DEVICE_SEED });
    assert.notEqual(ws.did, ws.rootDid, 'the device is a member, not the workspace');
    assert.equal(ws.did, didFromSeed(DEVICE_SEED));
    await ws.close();
  });
});
