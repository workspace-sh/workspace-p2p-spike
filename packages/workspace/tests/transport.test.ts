// The transport form, proven end to end (workspace#249 phase 3).
//
// These tests use the REAL NodeRuntime — real corestores, real Hypercore
// replication for the flush capture — with `bootstrap: []` so no test ever
// touches the DHT. The two runtimes in the invariant-5 test never connect:
// the copied FOLDER is the only channel between them, which is the claim
// being proven.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRuntime } from '@workspace.sh/p2p-runtime/node';
import { didFromSeed, type CreateRuntimeOptions } from '@workspace.sh/p2p-runtime';
import { Workspace } from '../src/index.ts';
import { RemoteWorkspace } from '../src/ipc/remote-base.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

const ROOT_SEED = new Uint8Array(32).fill(7);
const BOB_SEED = new Uint8Array(32).fill(8);

/** Real runtime, isolated storage, no swarm at all. */
function offlineRuntime(base: string, name: string) {
  return (opts: CreateRuntimeOptions) =>
    // `swarm: false` rather than only `bootstrap: []`: an empty bootstrap
    // still builds a Hyperswarm, and its UDP socket survives `destroy()`
    // (#254), so the test child cannot exit and the file is cancelled at the
    // timeout. These tests copy folders; they never replicate over a network.
    createRuntime({ ...opts, storage: join(base, name), swarm: false });
}

async function withBase(fn: (base: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-transport-'));
  try {
    await fn(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test('a freshly created workspace has the full on-disk shape', async () => {
  await withBase(async base => {
    const folder = join(base, 'acme.workspace');
    const ws = await Workspace.create({
      createRuntime: offlineRuntime(base, 'store-a'),
      folder,
      rootSeed: ROOT_SEED,
    });
    const dirs = await readdir(join(folder, '.workspace', 'store', 'v1'));
    // One transport dir per log named in the manifest: data, keyDelivery, blobs.
    assert.equal(dirs.length, 3, `expected 3 log dirs, got ${JSON.stringify(dirs)}`);
    await ws.close();
  });
});

test('INVARIANT 5: cp -R, then a cold open on a runtime that never met the writer', async () => {
  await withBase(async base => {
    const folder = join(base, 'acme.workspace');

    const admin = await Workspace.create({
      createRuntime: offlineRuntime(base, 'store-a'),
      folder,
      rootSeed: ROOT_SEED,
    });
    await admin.invite(didFromSeed(BOB_SEED));
    await admin.write(enc.encode('first document'));
    await admin.write(enc.encode('second document'));
    const blobBytes = new Uint8Array(70_000).map((_, i) => (i * 13 + 5) % 256);
    const ref = await admin.writeBlob(blobBytes, { contentType: 'image/png' });
    const wireRef = JSON.parse(JSON.stringify(ref)) as typeof ref;
    await admin.close(); // close flushes

    // The only channel between the two runtimes: a plain filesystem copy.
    const copy = join(base, 'copy.workspace');
    await cp(folder, copy, { recursive: true });

    const bob = await Workspace.open({
      createRuntime: offlineRuntime(base, 'store-b'),
      folder: copy,
      identitySeed: BOB_SEED,
    });
    const entries = await bob.entries();
    assert.equal(entries.length, 2);
    assert.equal(dec.decode(entries[0]), 'first document');
    assert.equal(dec.decode(entries[1]), 'second document');
    assert.deepEqual(await bob.readBlob(wireRef), blobBytes, 'blob differs across the copy');
    await bob.close();
  });
});

test('a mid-write copy is valid but stale', async () => {
  await withBase(async base => {
    const folder = join(base, 'acme.workspace');
    const admin = await Workspace.create({
      createRuntime: offlineRuntime(base, 'store-a'),
      folder,
      rootSeed: ROOT_SEED,
    });
    await admin.invite(didFromSeed(BOB_SEED));
    await admin.write(enc.encode('flushed'));
    await admin.flushStore();
    await admin.write(enc.encode('not yet flushed'));

    // Copy while the writer is still open, before the next flush.
    const copy = join(base, 'copy.workspace');
    await cp(folder, copy, { recursive: true });
    await admin.close();

    const bob = await Workspace.open({
      createRuntime: offlineRuntime(base, 'store-b'),
      folder: copy,
      identitySeed: BOB_SEED,
    });
    const entries = await bob.entries();
    assert.equal(entries.length, 1, 'stale copy should hold exactly the flushed prefix');
    assert.equal(dec.decode(entries[0]), 'flushed');
    await bob.close();
  });
});

test('a tampered store file is skipped, not trusted', async () => {
  await withBase(async base => {
    const folder = join(base, 'acme.workspace');
    const admin = await Workspace.create({
      createRuntime: offlineRuntime(base, 'store-a'),
      folder,
      rootSeed: ROOT_SEED,
    });
    await admin.invite(didFromSeed(BOB_SEED));
    await admin.write(enc.encode('intact'));
    await admin.write(enc.encode('to be corrupted'));
    await admin.close();

    const copy = join(base, 'copy.workspace');
    await cp(folder, copy, { recursive: true });

    // Corrupt the LAST message file of the data log in the copy.
    const v1 = join(copy, '.workspace', 'store', 'v1');
    for (const logDir of await readdir(v1)) {
      const dir = join(v1, logDir);
      const files = (await readdir(dir)).sort();
      if (files.length < 2) continue; // only the data log has multiple messages
      const target = join(dir, files[files.length - 1]!);
      const bytes = new Uint8Array(await readFile(target));
      bytes[bytes.byteLength - 4] = bytes[bytes.byteLength - 4]! ^ 0xff;
      await writeFile(target, bytes);
    }

    const bob = await Workspace.open({
      createRuntime: offlineRuntime(base, 'store-b'),
      folder: copy,
      identitySeed: BOB_SEED,
    });
    const entries = await bob.entries();
    assert.ok(entries.length < 2, 'the corrupted tail must not fold in');
    for (const e of entries) assert.equal(dec.decode(e), 'intact');
    await bob.close();
  });
});

test('re-flushing writes nothing new when the folder is current', async () => {
  await withBase(async base => {
    const folder = join(base, 'acme.workspace');
    const ws = await Workspace.create({
      createRuntime: offlineRuntime(base, 'store-a'),
      folder,
      rootSeed: ROOT_SEED,
    });
    await ws.write(enc.encode('one'));
    const first = await ws.flushStore();
    assert.ok(first !== null && first.written > 0);
    const second = await ws.flushStore();
    assert.equal(second?.written, 0, 'an unchanged workspace must flush zero files');
    await ws.close();
  });
});

test('a failed open closes the child rather than leaking it', async () => {
  // The chain this breaks (#326): pointing Locate at a folder that is not a
  // workspace spawns a child fine, `wsOpen` then fails on the missing
  // manifest, and the child is left running. The singleton native runtime then
  // refuses the NEXT spawn with "Child process is already running", blaming an
  // operation that did nothing wrong.
  let closed = false;
  let deliver: ((msg: unknown) => void) | null = null;

  const transport = {
    async spawn() {},
    send() {
      // Reply the way the child does when `wsOpen` finds no manifest.
      queueMicrotask(() =>
        deliver?.({ id: 1, ok: false, error: { message: 'ENOENT: no such file or directory' } }),
      );
    },
    onMessage(cb: (msg: unknown) => void) {
      deliver = cb;
      return () => { deliver = null; };
    },
    onExit() { return () => {}; },
    async close() { closed = true; },
    get closed() { return closed; },
  };

  await assert.rejects(
    () => RemoteWorkspace.fromTransport(transport as never, { method: 'wsOpen' } as never),
    /ENOENT/,
    'the original failure reaches the caller',
  );
  assert.equal(closed, true, 'and the child was closed on the way out');
});

// ---------------------------------------------------------------------------
// One child, many workspaces (#314)
// ---------------------------------------------------------------------------
//
// The stack below this file was always built for it: the child keys workspaces
// by handle, the runtime keeps a Map of joined topics, and Corestore replicates
// every core it holds over ONE connection per peer. What forced
// one-at-a-time was a fresh transport — and so a fresh child — per open.

/** A fake child that holds many workspaces and echoes handles back. */
function fakeChild() {
  const listeners = new Set<(msg: unknown) => void>();
  const sent: { id: number; method: string; params: { handle?: string } }[] = [];
  let handles = 0;
  let closed = false;

  const emit = (msg: unknown) => { for (const cb of [...listeners]) cb(msg); };

  const transport = {
    async spawn() {},
    send(line: string) {
      // The transport carries newline-delimited JSON, not bytes.
      const req = JSON.parse(line) as typeof sent[number];
      sent.push(req);
      queueMicrotask(() => {
        if (req.method === 'wsOpen' || req.method === 'wsCreate') {
          const handle = `h${++handles}`;
          emit({
            id: req.id,
            ok: true,
            result: {
              handle,
              id: `ws-${handle}`,
              did: 'did:key:zSelf',
              rootDid: 'did:key:zRoot',
              isAdmin: true,
              length: 0,
            },
          });
          return;
        }
        // Echo the handle, so a reply can be attributed to a workspace.
        emit({ id: req.id, ok: true, result: { handle: req.params.handle } });
      });
    },
    onMessage(cb: (msg: unknown) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onExit() { return () => {}; },
    async close() { closed = true; },
    get closed() { return closed; },
  };

  return { transport, sent, isClosed: () => closed };
}

test('two workspaces share one child and get distinct request ids', async () => {
  // The collision this prevents: every RemoteWorkspace numbered its own
  // requests from 1, and `rpcOnce` hardcoded id 1. Sharing a child means both
  // see every reply on that transport, so two requests numbered 1 would each
  // resolve on the other's answer — silently, with the wrong data.
  const { transport, sent } = fakeChild();

  const a = await RemoteWorkspace.fromTransport(
    transport as never, { method: 'wsOpen' } as never, false);
  const b = await RemoteWorkspace.fromTransport(
    transport as never, { method: 'wsOpen' } as never, false);

  assert.notEqual(a.handle, b.handle, 'the child gave them separate handles');

  await Promise.all([a.close(), b.close()]);

  const ids = sent.map(r => r.id);
  assert.equal(new Set(ids).size, ids.length, 'every request id is distinct');
});

test('closing one workspace does not close a shared child', async () => {
  // The child outlives any single workspace — that is the point. Closing the
  // transport because ONE workspace closed would tear down every other
  // workspace still using it.
  const { transport, isClosed } = fakeChild();

  const a = await RemoteWorkspace.fromTransport(
    transport as never, { method: 'wsOpen' } as never, false);
  const b = await RemoteWorkspace.fromTransport(
    transport as never, { method: 'wsOpen' } as never, false);

  await a.close();
  assert.equal(isClosed(), false, 'the child is still up for b');

  await b.close();
  assert.equal(isClosed(), false, 'and stays up — it is torn down with the app');
});

test('a workspace that owns its child closes it', async () => {
  // The Node path still spawns per workspace, and must keep working that way.
  const { transport, isClosed } = fakeChild();
  const ws = await RemoteWorkspace.fromTransport(
    transport as never, { method: 'wsOpen' } as never);
  await ws.close();
  assert.equal(isClosed(), true);
});

// ---------------------------------------------------------------------------
// The folder keeps its log without being closed (#341)
// ---------------------------------------------------------------------------
//
// The transport form used to be written only by `close()`. Nothing closes a
// workspace — quitting terminates the child, and since workspaces became live
// by default they are never closed at all — so folders were left with a
// manifest and no log. That opens as a workspace with no documents rather than
// failing, which is worse than an obvious error, and it breaks invariant 5.

test('a write puts the log in the folder without anyone closing it', async () => {
  await withBase(async base => {
    const folder = join(base, 'acme.workspace');
    const admin = await Workspace.create({
      createRuntime: offlineRuntime(base, 'store-a'),
      folder,
      rootSeed: ROOT_SEED,
    });
    await admin.invite(didFromSeed(BOB_SEED));
    await admin.write(enc.encode('written, never closed'));

    // Wait for the debounce rather than calling flushStore — the point is that
    // nothing asked for this.
    await new Promise(resolve => setTimeout(resolve, 2_500));

    // Copy WITHOUT closing, exactly as `cp -R` on a running app would.
    const copy = join(base, 'copy.workspace');
    await cp(folder, copy, { recursive: true });

    const bob = await Workspace.open({
      createRuntime: offlineRuntime(base, 'store-b'),
      folder: copy,
      identitySeed: BOB_SEED,
    });
    const entries = await bob.entries();
    assert.equal(entries.length, 1, 'the copy carries the log, not just a manifest');
    assert.equal(dec.decode(entries[0]!), 'written, never closed');
    await bob.close();
    await admin.close();
  });
});

test('a burst of writes costs one flush, not one per write', async () => {
  // A flush replicates the whole log into a capture replica. Per-append would
  // make every keystroke pay for that.
  await withBase(async base => {
    const folder = join(base, 'acme.workspace');
    let flushes = 0;
    const base_factory = offlineRuntime(base, 'store-a');
    const counting = async (opts: never) => {
      const runtime = await base_factory(opts);
      const original = runtime.flushLogToDir!.bind(runtime);
      return Object.assign(runtime, {
        flushLogToDir: (key: never, dir: never) => {
          flushes++;
          return original(key, dir);
        },
      });
    };

    const ws = await Workspace.create({
      createRuntime: counting as never,
      folder,
      rootSeed: ROOT_SEED,
    });
    // `create` flushes once itself, which is legitimate — it is what puts the
    // manifest's logs in the folder before anything is written. Count only
    // what the writes cause.
    flushes = 0;

    for (const n of [1, 2, 3, 4, 5]) await ws.write(enc.encode(`v${n}`));
    await new Promise(resolve => setTimeout(resolve, 2_500));

    // Three logs are flushed per pass (data, key delivery, blobs), so one
    // debounced pass is three calls — not fifteen.
    assert.equal(flushes, 3, `expected one pass over three logs, saw ${flushes} calls`);
    await ws.close();
  });
});
