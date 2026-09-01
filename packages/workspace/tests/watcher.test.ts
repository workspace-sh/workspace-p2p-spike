// Working-tree watcher (#221).
//
// Real filesystem, real timers: a watcher that is only tested against a fake
// fs proves nothing about the thing it exists to survive — editors that write
// a temp file and rename over the original, and large files still being
// copied in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isWatchablePath,
  listWorkingTree,
  toWorkspaceRelative,
  watchWorkingTree,
  type WorkingTreeChange,
} from '../src/watcher.ts';

const DEBOUNCE = 40;

/**
 * Collect changes while `body` runs.
 *
 * `until` waits for a predicate rather than a fixed sleep. These tests use
 * real timers over a real filesystem, and the runner executes test FILES in
 * parallel — a fixed sleep that passes alone becomes flaky the moment a
 * sibling suite (corestore replication, say) loads the machine. Polling for
 * the expected state removes that coupling; only the absence assertions have
 * to wait out a settle period, and they get a generous one.
 */
async function collect(
  folder: string,
  body: () => Promise<void>,
  until?: (seen: WorkingTreeChange[]) => boolean,
): Promise<WorkingTreeChange[]> {
  const seen: WorkingTreeChange[] = [];
  const stop = watchWorkingTree(folder, ch => seen.push(ch), {
    debounceMs: DEBOUNCE,
    stableReads: 2,
  });
  try {
    await body();
    if (until) {
      const deadline = Date.now() + 10_000;
      while (!until(seen) && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, DEBOUNCE / 2));
      }
    }
    // A short quiet period after the condition, so a duplicate event that
    // should NOT arrive has a chance to, and the collapse assertions mean
    // something.
    await new Promise(r => setTimeout(r, DEBOUNCE * 4));
  } finally {
    stop();
  }
  return seen;
}

/** Settle time for tests asserting that NOTHING is reported. */
const QUIET_MS = DEBOUNCE * 12;

async function withFolder(fn: (folder: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ws-watch-'));
  const folder = join(base, 'acme.workspace');
  await mkdir(join(folder, '.workspace'), { recursive: true });
  try {
    await fn(folder);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

const text = (bytes: Uint8Array | null) =>
  bytes === null ? null : new TextDecoder().decode(bytes);

// ---------------------------------------------------------------------------
// The promise the format makes
// ---------------------------------------------------------------------------

test('an external edit is reported with its new contents', async () => {
  await withFolder(async folder => {
    await writeFile(join(folder, 'notes.md'), '# original\n');
    const seen = await collect(folder, async () => {
      await new Promise(r => setTimeout(r, DEBOUNCE * 2));
      await writeFile(join(folder, 'notes.md'), '# edited externally\n');
    }, seen => seen.some(c => c.path === 'notes.md'));
    const hit = seen.find(c => c.path === 'notes.md');
    assert.ok(hit, `no event for notes.md; saw ${JSON.stringify(seen.map(s => s.path))}`);
    assert.equal(text(hit.bytes), '# edited externally\n');
  });
});

test('a nested file reports a workspace-relative path', async () => {
  await withFolder(async folder => {
    await mkdir(join(folder, 'ideas'), { recursive: true });
    const seen = await collect(folder, async () => {
      await writeFile(join(folder, 'ideas', 'q2.md'), 'nested\n');
    }, seen => seen.some(c => c.path === 'ideas/q2.md'));
    assert.ok(
      seen.some(c => c.path === 'ideas/q2.md'),
      `expected ideas/q2.md, saw ${JSON.stringify(seen.map(s => s.path))}`,
    );
  });
});

test('a deleted file reports null bytes', async () => {
  await withFolder(async folder => {
    await writeFile(join(folder, 'gone.md'), 'here\n');
    const seen = await collect(folder, async () => {
      await new Promise(r => setTimeout(r, DEBOUNCE * 2));
      await unlink(join(folder, 'gone.md'));
    }, seen => seen.some(c => c.path === 'gone.md' && c.bytes === null));
    const hit = seen.find(c => c.path === 'gone.md');
    assert.ok(hit, 'no event for the deletion');
    assert.equal(hit.bytes, null);
  });
});

// ---------------------------------------------------------------------------
// The cases that make it survive real editors
// ---------------------------------------------------------------------------

test('an atomic save (temp write + rename) collapses to ONE report of the final file', async () => {
  // Vim/Sublime write `foo.md.tmp` then rename over `foo.md`. The debounce is
  // what makes this one ingest rather than three, with no per-editor casing.
  await withFolder(async folder => {
    await writeFile(join(folder, 'doc.md'), 'v1\n');
    const seen = await collect(folder, async () => {
      await new Promise(r => setTimeout(r, DEBOUNCE * 2));
      const tmp = join(folder, 'doc.md.tmp');
      await writeFile(tmp, 'v2 via atomic save\n');
      await rename(tmp, join(folder, 'doc.md'));
    }, seen => seen.some(c => c.path === 'doc.md'));
    const docEvents = seen.filter(c => c.path === 'doc.md');
    assert.equal(docEvents.length, 1, `expected 1 event, got ${docEvents.length}`);
    assert.equal(text(docEvents[0]!.bytes), 'v2 via atomic save\n');
    // The temp file must never surface as a document.
    assert.equal(seen.filter(c => c.path.endsWith('.tmp')).length, 0);
  });
});

test('rapid successive writes collapse to one report with the final contents', async () => {
  await withFolder(async folder => {
    const seen = await collect(folder, async () => {
      const f = join(folder, 'fast.md');
      for (const v of ['a', 'b', 'c', 'final']) await writeFile(f, `${v}\n`);
    }, seen => seen.some(c => c.path === 'fast.md'));
    const events = seen.filter(c => c.path === 'fast.md');
    assert.equal(events.length, 1, `expected 1 event, got ${events.length}`);
    assert.equal(text(events[0]!.bytes), 'final\n');
  });
});

// ---------------------------------------------------------------------------
// Exclusions — invariant 1's hidden directory, and the noise around it
// ---------------------------------------------------------------------------

test('changes inside .workspace/ are never reported', async () => {
  // The container is machine-facing: only the app writes it, and ingesting
  // our own store writes would be an unbounded echo loop.
  await withFolder(async folder => {
    const seen = await collect(folder, async () => {
      await mkdir(join(folder, '.workspace', 'store', 'v1', 'abc'), { recursive: true });
      await writeFile(join(folder, '.workspace', 'store', 'v1', 'abc', '000000'), 'block');
      await writeFile(join(folder, '.workspace', 'manifest.json'), '{}');
      await new Promise(r => setTimeout(r, QUIET_MS));
    });
    assert.deepEqual(seen.filter(c => c.path.startsWith('.workspace')), []);
  });
});

test('OS junk and editor sidecars are filtered', () => {
  for (const bad of [
    '.workspace/manifest.json',
    '.git/config',
    'node_modules/x/index.js',
    '.DS_Store',
    'notes/.DS_Store',
    'doc.md.swp',
    'doc.md~',
    '.~lock.doc.md#',
    'ideas/.obsidian/app.json',
  ]) {
    assert.equal(isWatchablePath(bad), false, `should be excluded: ${bad}`);
  }
  for (const good of ['notes.md', 'ideas/q2.canvas', 'data/customers.table/rows.ndjson', 'keys/notes.md']) {
    assert.equal(isWatchablePath(good), true, `should be watched: ${good}`);
  }
});

test('toWorkspaceRelative refuses paths outside the folder', () => {
  assert.equal(toWorkspaceRelative('/a/b', '/a/b/notes.md'), 'notes.md');
  assert.equal(toWorkspaceRelative('/a/b', '/a/b/x/y.md'), 'x/y.md');
  assert.equal(toWorkspaceRelative('/a/b', '/a/elsewhere.md'), null);
  assert.equal(toWorkspaceRelative('/a/b', '/a/b'), null);
});

test('stopping is idempotent and silences further events', async () => {
  await withFolder(async folder => {
    const seen: WorkingTreeChange[] = [];
    const stop = watchWorkingTree(folder, c => seen.push(c), { debounceMs: DEBOUNCE });
    stop();
    stop(); // must not throw
    await writeFile(join(folder, 'after-stop.md'), 'x\n');
    await new Promise(r => setTimeout(r, QUIET_MS));
    assert.deepEqual(seen, []);
  });
});

// ---------------------------------------------------------------------------
// A read error is not a deletion (#289)
//
// `bytes: null` is taken by the consumer as an external delete, and that
// tombstone REPLICATES — so a file the watcher merely could not read would be
// removed from every device. Only ENOENT may say "gone".
// ---------------------------------------------------------------------------

test('an unreadable file is not reported as deleted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ws-unreadable-'));
  try {
    const target = join(dir, 'secret.md');
    await writeFile(target, 'contents that must not be tombstoned');

    const seen = await collect(dir, async () => {
      // Deny reads without removing the file: `stat` still succeeds and the
      // size is stable, so the walk reaches `readFile` and fails there with
      // EACCES — the exact shape a cloud provider produces when it cannot
      // materialise an evicted file.
      await chmod(target, 0o000);
      await writeFile(join(dir, 'trigger.md'), 'unrelated');
    });

    await chmod(target, 0o644); // restore before the temp dir is removed

    // Scoped to the file itself. macOS `fs.watch` also emits an event naming
    // the watched directory, which stats as ENOENT and is reported as gone —
    // harmless, because the consumer ignores paths it never tracked, but not
    // what this test is about.
    assert.ok(
      !seen.some(c => c.path === 'secret.md' && c.bytes === null),
      'a read failure must never be reported as a deletion',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a genuinely deleted file is still reported as gone', async () => {
  // The other half: narrowing to ENOENT must not stop real deletions working.
  const dir = await mkdtemp(join(tmpdir(), 'ws-deleted-'));
  try {
    const target = join(dir, 'gone.md');
    await writeFile(target, 'here for now');

    const seen = await collect(
      dir,
      async () => {
        await unlink(target);
      },
      s => s.some(c => c.path === 'gone.md' && c.bytes === null),
    );

    assert.ok(
      seen.some(c => c.path === 'gone.md' && c.bytes === null),
      'ENOENT must still mean deleted',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// One-shot scan (#280)
//
// The watcher reports CHANGES, so a file that merely exists is invisible to it
// forever. That gap is how divergence occurring while a workspace was closed
// went unseen — and then got overwritten. These cover the scan that fills it.
// ---------------------------------------------------------------------------

test('listWorkingTree reports files that already existed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ws-list-'));
  try {
    await writeFile(join(dir, 'a.md'), 'A');
    await mkdir(join(dir, 'notes'), { recursive: true });
    await writeFile(join(dir, 'notes', 'b.md'), 'B');

    const found = await listWorkingTree(dir);
    const byPath = new Map(found.map(f => [f.path, new TextDecoder().decode(f.bytes)]));

    assert.equal(byPath.size, 2);
    assert.equal(byPath.get('a.md'), 'A');
    // Workspace-relative and `/`-separated — the same key the watcher reports,
    // which is what lets the two be compared at all.
    assert.equal(byPath.get('notes/b.md'), 'B');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listWorkingTree applies the same exclusions as the watcher', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ws-list-'));
  try {
    await writeFile(join(dir, 'keep.md'), 'keep');
    // The container, VCS/tooling directories, OS junk and editor sidecars.
    for (const seg of ['.workspace', '.git', 'node_modules', '.obsidian']) {
      await mkdir(join(dir, seg), { recursive: true });
      await writeFile(join(dir, seg, 'inside.md'), 'no');
    }
    await writeFile(join(dir, '.DS_Store'), 'no');
    await writeFile(join(dir, 'draft.md.swp'), 'no');
    await writeFile(join(dir, 'notes.md~'), 'no');
    await writeFile(join(dir, '.tmp-123'), 'no');

    const found = await listWorkingTree(dir);
    assert.deepEqual(found.map(f => f.path), ['keep.md']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listWorkingTree only reads what the caller asked for', async () => {
  // The filter has to apply BEFORE the read: applying it downstream meant
  // every binary in the folder was read into memory and hex-encoded across
  // the IPC boundary just to be discarded (#293).
  const dir = await mkdtemp(join(tmpdir(), 'ws-list-'));
  try {
    await writeFile(join(dir, 'note.md'), 'text');
    await writeFile(join(dir, 'photo.png'), 'not really a png');
    await writeFile(join(dir, 'data.bin'), 'binary');

    const found = await listWorkingTree(dir, { extensions: ['.md', '.txt'] });
    assert.deepEqual(found.map(f => f.path), ['note.md']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listWorkingTree matches extensions case-insensitively', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ws-list-'));
  try {
    await writeFile(join(dir, 'SHOUTING.MD'), 'text');
    const found = await listWorkingTree(dir, { extensions: ['.md'] });
    assert.deepEqual(found.map(f => f.path), ['SHOUTING.MD']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listWorkingTree reads a settled file whole', async () => {
  // The size and dataless guards both compare the bytes read against what
  // `stat` reported. This pins the NEGATIVE case — that an ordinary file is
  // not caught by them.
  //
  // The positive cases are not reachable from a test: producing a genuinely
  // torn read means winning a race against a writer, and producing a dataless
  // file means having a cloud provider evict one. Both are asserted by
  // construction in the walk and verified by inspection, not here. Saying so
  // is better than a test whose name claims more than it checks.
  const dir = await mkdtemp(join(tmpdir(), 'ws-settled-'));
  try {
    await writeFile(join(dir, 'whole.md'), 'complete');
    const found = await listWorkingTree(dir, { extensions: ['.md'] });
    assert.equal(found.length, 1);
    assert.equal(new TextDecoder().decode(found[0]!.bytes), 'complete');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listWorkingTree is empty for an empty folder, not an error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ws-list-'));
  try {
    assert.deepEqual(await listWorkingTree(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
