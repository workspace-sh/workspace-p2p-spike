// Regression cover for the transport form's two silent-corruption bugs and
// its unbounded wait (#254).
//
// All three shipped in #250 and none had a test. They are the kind that leave
// no trace at the time: a proof destroyed by a filename collision, a flush
// that overwrites earlier messages, a close that never returns.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Corestore from 'corestore';
import b4a from 'b4a';

import { flushLogToDir, hydrateLogFromDir, nextSeq } from '../src/transport-form.ts';

/**
 * A temp base plus a `store()` factory whose corestores are ALWAYS closed,
 * including when an assertion throws.
 *
 * Not incidental hygiene: RocksDB keeps the directory open, so a store left
 * behind makes cleanup fail with ENOTEMPTY and — in a bigger suite — keeps
 * the test process alive past the run.
 */
async function withBase(
  fn: (base: string, store: (name: string) => Corestore) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'tf-test-'));
  const opened: Corestore[] = [];
  const store = (name: string): Corestore => {
    const s = new Corestore(join(base, name));
    opened.push(s);
    return s;
  };
  try {
    await fn(base, store);
  } finally {
    for (const s of opened) {
      try {
        await s.close();
      } catch {
        /* already closed */
      }
    }
    await rm(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// nextSeq — the overwrite bug
// ---------------------------------------------------------------------------

test('nextSeq continues past the highest name, not the count', () => {
  // `existing.length` was the original derivation. With a hole it points at a
  // name that already exists, so the next flush overwrites earlier messages.
  assert.equal(nextSeq([]), 0);
  assert.equal(nextSeq(['000000', '000001', '000002']), 3);
  assert.equal(nextSeq(['000000', '000001', '000003']), 4, 'a hole must not cause reuse');
  assert.equal(nextSeq(['000005']), 6, 'a sparse tail must not cause reuse');
});

// ---------------------------------------------------------------------------
// The round trip still works
// ---------------------------------------------------------------------------

test('flush then hydrate reproduces the log on a cold store', async () => {
  await withBase(async (base, store) => {
    const a = store('a');
    const core = a.get({ name: 'data' });
    await core.ready();
    await core.append(['one', 'two', 'three'].map(t => b4a.from(t)));
    const key = core.key as Uint8Array;

    const dir = join(base, 'store', 'v1', b4a.toString(key, 'hex'));
    const r = await flushLogToDir(a, store('a-cap'), key, dir);
    assert.ok(r.written > 0, 'flush wrote nothing');

    const b = store('b');
    const h = await hydrateLogFromDir(b, key, dir);
    assert.equal(h.skipped, 0);
    const replica = b.get({ key: b4a.from(key) });
    await replica.ready();
    assert.equal(replica.length, 3);
    assert.equal(b4a.toString(await replica.get(0, { wait: false }), 'utf8'), 'one');
    assert.equal(b4a.toString(await replica.get(2, { wait: false }), 'utf8'), 'three');
  });
});

test('every written file has a unique name — no proof is lost to a collision', async () => {
  // The original tap read `seq` on either side of two awaits, so concurrent
  // verifies collided on the filename and one proof was silently destroyed.
  // Enough blocks here to put many messages in flight at once.
  await withBase(async (base, store) => {
    const a = store('a');
    const core = a.get({ name: 'data' });
    await core.ready();
    await core.append(Array.from({ length: 60 }, (_, i) => b4a.from(`block ${i}`)));
    const key = core.key as Uint8Array;

    const dir = join(base, 'store', 'v1', b4a.toString(key, 'hex'));
    await flushLogToDir(a, store('a-cap'), key, dir);

    const names = (await readdir(dir)).filter(n => /^\d{6}$/.test(n));
    assert.equal(new Set(names).size, names.length, 'duplicate sequence names');
    // Every file must be non-empty: a collision truncates or clobbers one.
    for (const n of names) {
      const bytes = await readFile(join(dir, n));
      assert.ok(bytes.byteLength > 0, `${n} is empty`);
    }

    // And the whole thing must still replay.
    const b = store('b');
    const h = await hydrateLogFromDir(b, key, dir);
    assert.equal(h.skipped, 0, 'a corrupted file would be skipped here');
    assert.equal(h.length, 60);
  });
});

test('a second flush appends rather than overwriting, even with a hole', async () => {
  await withBase(async (base, store) => {
    const a = store('a');
    const cap = store('a-cap');
    const core = a.get({ name: 'data' });
    await core.ready();
    await core.append([b4a.from('first')]);
    const key = core.key as Uint8Array;
    const dir = join(base, 'store', 'v1', b4a.toString(key, 'hex'));

    await flushLogToDir(a, cap, key, dir);
    const afterFirst = (await readdir(dir)).filter(n => /^\d{6}$/.test(n)).sort();
    const firstContents = await Promise.all(
      afterFirst.map(n => readFile(join(dir, n)).then(b => b4a.toString(b, 'hex'))),
    );

    await core.append([b4a.from('second')]);
    await flushLogToDir(a, cap, key, dir);

    // Everything written by the first flush must be byte-identical still.
    for (const [i, n] of afterFirst.entries()) {
      const now = b4a.toString(await readFile(join(dir, n)), 'hex');
      assert.equal(now, firstContents[i], `${n} was overwritten by the second flush`);
    }
  });
});

test('flushing an unchanged log writes nothing and settles', async () => {
  await withBase(async (base, store) => {
    const a = store('a');
    const cap = store('a-cap');
    const core = a.get({ name: 'data' });
    await core.ready();
    await core.append([b4a.from('x')]);
    const key = core.key as Uint8Array;
    const dir = join(base, 'store', 'v1', b4a.toString(key, 'hex'));

    await flushLogToDir(a, cap, key, dir);
    const second = await flushLogToDir(a, cap, key, dir);
    assert.equal(second.written, 0);
  });
});

test('an empty log flushes without opening a capture session', async () => {
  await withBase(async (base, store) => {
    const a = store('a');
    const core = a.get({ name: 'empty' });
    await core.ready();
    const dir = join(base, 'store', 'v1', b4a.toString(core.key as Uint8Array, 'hex'));
    const r = await flushLogToDir(a, store('a-cap'), core.key as Uint8Array, dir);
    assert.deepEqual(r, { written: 0, length: 0 });
  });
});

test('hydrate ignores names that are not bare sequence numbers', async () => {
  // Sync engines leave conflicted copies beside the real files.
  await withBase(async (base, store) => {
    const a = store('a');
    const core = a.get({ name: 'data' });
    await core.ready();
    await core.append(['one', 'two'].map(t => b4a.from(t)));
    const key = core.key as Uint8Array;
    const dir = join(base, 'store', 'v1', b4a.toString(key, 'hex'));
    await flushLogToDir(a, store('a-cap'), key, dir);

    await writeFile(join(dir, '000000 (Leslie conflicted copy 2026-08-22)'), 'junk');
    await writeFile(join(dir, '.tmp-9'), 'interrupted');

    const b = store('b');
    const h = await hydrateLogFromDir(b, key, dir);
    assert.equal(h.skipped, 0, 'non-sequence names must be ignored, not skipped');
    assert.equal(h.length, 2);
  });
});
