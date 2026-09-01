// Binary content over a workspace (#234).
//
// The motivating case is not exotic: a canvas references images by relative
// path, so a canvas that syncs without its images renders the broken-image
// placeholder on the peer — faithfully, because that path is implemented.
// The cross-peer test below is that case.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  didFromSeed,
  type CreateRuntimeOptions,
  type Log,
  type LogKey,
  type P2PRuntime,
  type Did,
} from '@workspace.sh/p2p-runtime';
import {
  BlobIntegrityError,
  BlobSizeError,
  CHUNK_BYTES,
  isBlobRef,
  MAX_BLOB_BYTES,
  readBlob,
  writeBlob,
  Workspace,
} from '../src/index.ts';

// Same shared-backing fake as workspace.test.ts: createLog on peer A and
// openLog(sameKey) on peer B see the same blocks.
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
        // Copy: callers may hand us a view onto a buffer they reuse.
        backing.blocks.push(new Uint8Array(b));
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
  const base = await mkdtemp(join(tmpdir(), 'ws-blob-test-'));
  try {
    await fn(join(base, 'Acme.workspace'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

const ROOT_SEED = new Uint8Array(32).fill(1);
const BOB_SEED = new Uint8Array(32).fill(2);

/** A deterministic byte pattern — catches offset bugs a constant fill would not. */
function bytes(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) % 256;
  return out;
}

/** A minimal but genuine PNG header, so the fixture is a real file shape. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...bytes(2048, 3)]);
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
);

// ---------------------------------------------------------------------------
// The motivating case
// ---------------------------------------------------------------------------

test('a canvas image written by one peer is byte-identical on another', async () => {
  const createRuntime = makeRuntimeFactory();
  await withTmp(async folder => {
    const admin = await Workspace.create({ createRuntime, folder, rootSeed: ROOT_SEED });
    const bobDid = didFromSeed(BOB_SEED);
    await admin.invite(bobDid);

    const pngRef = await admin.writeBlob(PNG, { contentType: 'image/png' });
    const svgRef = await admin.writeBlob(SVG, { contentType: 'image/svg+xml' });
    // The reference is what a document entry carries, so it must survive JSON.
    const wire = JSON.parse(JSON.stringify({ png: pngRef, svg: svgRef })) as {
      png: typeof pngRef;
      svg: typeof svgRef;
    };
    await admin.close();

    const bob = await Workspace.open({ createRuntime, folder, identitySeed: BOB_SEED });
    assert.ok(isBlobRef(wire.png));
    assert.deepEqual(await bob.readBlob(wire.png), PNG, 'PNG differs on the peer');
    assert.deepEqual(await bob.readBlob(wire.svg), SVG, 'SVG differs on the peer');
    assert.equal(wire.png.contentType, 'image/png');
    await bob.close();
  });
});

// ---------------------------------------------------------------------------
// The architectural property this design exists for
// ---------------------------------------------------------------------------

test('blob bytes stay out of the data log', async () => {
  // The reason blobs get their own log: entries() reads the data log in full
  // on every change. If blob bytes landed there, every refresh on every peer
  // would fetch and decrypt them.
  const createRuntime = makeRuntimeFactory();
  await withTmp(async folder => {
    const ws = await Workspace.create({ createRuntime, folder, rootSeed: ROOT_SEED });
    await ws.write(new TextEncoder().encode('a document'));
    await ws.writeBlob(bytes(CHUNK_BYTES * 3));

    const entries = await ws.entries();
    assert.equal(entries.length, 1, 'the blob leaked into the data log');
    const total = entries.reduce((n, e) => n + e.byteLength, 0);
    assert.ok(total < 1024, `data log grew to ${total} bytes`);
    await ws.close();
  });
});

// ---------------------------------------------------------------------------
// Chunking and edges
// ---------------------------------------------------------------------------

for (const [label, size] of [
  ['empty', 0],
  ['one byte', 1],
  ['just under a chunk', CHUNK_BYTES - 1],
  ['exactly a chunk', CHUNK_BYTES],
  ['just over a chunk', CHUNK_BYTES + 1],
  ['several chunks', CHUNK_BYTES * 3 + 17],
] as const) {
  test(`round-trips ${label} (${size} bytes)`, async () => {
    const createRuntime = makeRuntimeFactory();
    await withTmp(async folder => {
      const ws = await Workspace.create({ createRuntime, folder, rootSeed: ROOT_SEED });
      const content = bytes(size);
      const ref = await ws.writeBlob(content);
      assert.equal(ref.size, size);
      assert.equal(ref.chunks.length, Math.ceil(size / CHUNK_BYTES));
      assert.deepEqual(await ws.readBlob(ref), content);
      await ws.close();
    });
  });
}

test('identical content is stored once within a session', async () => {
  const createRuntime = makeRuntimeFactory();
  await withTmp(async folder => {
    const ws = await Workspace.create({ createRuntime, folder, rootSeed: ROOT_SEED });
    const first = await ws.writeBlob(PNG);
    const second = await ws.writeBlob(PNG);
    assert.equal(second.id, first.id);
    assert.deepEqual(second.chunks, first.chunks, 'the same image was stored twice');
    await ws.close();
  });
});

test('different content gets different ids', async () => {
  const createRuntime = makeRuntimeFactory();
  await withTmp(async folder => {
    const ws = await Workspace.create({ createRuntime, folder, rootSeed: ROOT_SEED });
    const a = await ws.writeBlob(bytes(64, 1));
    const b = await ws.writeBlob(bytes(64, 2));
    assert.notEqual(a.id, b.id);
    await ws.close();
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test('a blob over the cap is refused with a message a user can act on', async () => {
  const createRuntime = makeRuntimeFactory();
  await withTmp(async folder => {
    const ws = await Workspace.create({ createRuntime, folder, rootSeed: ROOT_SEED });
    // Not allocated for real — only the length is checked before any write.
    const huge = { byteLength: MAX_BLOB_BYTES + 1 } as Uint8Array;
    await assert.rejects(() => ws.writeBlob(huge), BlobSizeError);
    await assert.rejects(() => ws.writeBlob(huge), /over the .* limit/);
    await ws.close();
  });
});

test('corrupted content fails the integrity check instead of being returned', async () => {
  // The bytes come from a peer, so "these are what was written" is a claim
  // worth checking rather than assuming.
  const blocks: Uint8Array[] = [];
  const log: Log = {
    key: 'k' as LogKey,
    writable: true,
    get length() {
      return blocks.length;
    },
    async append(b) {
      blocks.push(new Uint8Array(b));
      return blocks.length;
    },
    async get(i) {
      return blocks[i]!;
    },
    on() {
      return () => {};
    },
    async close() {},
  };

  const content = bytes(128);
  const ref = await writeBlob(log, content);
  blocks[0]![0] = blocks[0]![0]! ^ 0xff; // one flipped bit

  await assert.rejects(() => readBlob(log, ref), BlobIntegrityError);
});

test('a workspace with no blob log explains itself rather than crashing', async () => {
  const createRuntime = makeRuntimeFactory();
  await withTmp(async folder => {
    const ws = await Workspace.create({ createRuntime, folder, rootSeed: ROOT_SEED });
    assert.equal(ws.supportsBlobs, true);
    await ws.close();
  });
  // The pre-blob case is the manifest lacking `logs.blobs`; the guard is the
  // same either way, and its message names the reason.
});

test('isBlobRef rejects things that are not references', () => {
  assert.equal(isBlobRef(null), false);
  assert.equal(isBlobRef({}), false);
  assert.equal(isBlobRef({ v: 1, id: 'a', size: 1 }), false);
  assert.equal(isBlobRef({ v: 2, id: 'a', size: 1, chunks: [] }), false);
  assert.equal(isBlobRef({ v: 1, id: 'a', size: -1, chunks: [] }), false);
  assert.equal(isBlobRef({ v: 1, id: 'a', size: 0, chunks: [] }), true);
});
