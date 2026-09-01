// Flush / hydrate between a corestore-backed log and the transport form —
// `.workspace/store/v1/<log-key>/<seq>` — defined in workspace-format.md
// § `store/` (workspace-p2p-spike, ADR 0003).
//
// The transport form is the replication protocol, persisted. Flushing runs a
// REAL in-process replication from the main store into a persistent capture
// replica, and every proof message the capture replica verifies is written to
// a sequence file. Hydration replays those files into a core exactly as a
// replica applies messages from a live peer. Nothing here invents a
// verification story: a cold replica verified each message once, so a cold
// replica can verify it again.
//
// Hand-building per-index proofs against imagined reader state was tried
// first and fails — the protocol interleaves upgrades with out-of-order
// blocks, and each proof is shaped for a reader that has applied exactly the
// preceding messages. Capture order IS the contract; sequence numbers order
// the replay, not the blocks.
//
// Bare-portable on purpose: unprefixed builtins via the package `imports`
// map, `b4a` for bytes. This code runs inside the mobile worklet.

import { mkdir, readdir, readFile, rename, writeFile } from 'fs/promises';
import { join } from 'path';

import b4a from 'b4a';
import c from 'compact-encoding';
// Deep import: hypercore has no exports map, and these are the protocol's
// own message codecs — reusing them is the point.
import { wire } from 'hypercore/lib/messages.js';

/** File names are zero-padded so lexicographic order is replay order. */
const SEQ_WIDTH = 6;

const SEQ_RE = /^\d{6}$/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Core = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Corestore = any;

export interface FlushResult {
  /** Message files written by this flush. */
  written: number;
  /** The log length the transport form now covers. */
  length: number;
}

export interface HydrateResult {
  /** Messages that verified and were applied. */
  applied: number;
  /** Files that failed to decode or verify — torn writes, tampering. */
  skipped: number;
  /** The core's length after replay. */
  length: number;
}

function seqName(n: number): string {
  return String(n).padStart(SEQ_WIDTH, '0');
}

/**
 * The next sequence number to write.
 *
 * Derived from the HIGHEST existing name, not the count. Counting assumes the
 * numbering is dense, and it need not be: a skipped file, an interrupted
 * write, or a sync engine's conflicted copy leaves a hole, after which the
 * count points at a name that already exists and the next flush silently
 * overwrites earlier messages.
 */
export function nextSeq(names: string[]): number {
  let highest = -1;
  for (const name of names) {
    const value = Number(name);
    if (Number.isInteger(value) && value > highest) highest = value;
  }
  return highest + 1;
}

async function listSeqFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  // Anything that is not a bare sequence number is ignored: temp files from
  // an interrupted atomic write, and sync engines' conflicted-copy siblings.
  return names.filter(n => SEQ_RE.test(n)).sort();
}

/** Replay message files into `core`, one verify per file, tolerant per-file. */
async function replayInto(core: Core, dir: string): Promise<HydrateResult> {
  let applied = 0;
  let skipped = 0;
  for (const name of await listSeqFiles(dir)) {
    try {
      const bytes = await readFile(join(dir, name));
      const proof = c.decode(wire.data, bytes);
      await core.core.verify(proof);
      applied++;
    } catch {
      // A torn or tampered file. Skipping rather than aborting keeps a
      // partially-synced folder useful; replication heals the rest.
      skipped++;
    }
  }
  return { applied, skipped, length: core.length as number };
}

/**
 * Flush a log to its transport directory.
 *
 * `captureStore` is a SEPARATE corestore holding a cold replica per log — it
 * is what makes flushing incremental and the files stable: its length is
 * exactly what previous flushes have written, so only the delta produces new
 * messages. If it has been lost (it is a cache), it self-heals by replaying
 * the existing files first.
 */
export async function flushLogToDir(
  store: Corestore,
  captureStore: Corestore,
  key: Uint8Array,
  dir: string,
): Promise<FlushResult> {
  const main: Core = store.get({ key: b4a.from(key) });
  await main.ready();
  await mkdir(dir, { recursive: true });

  const existing = await listSeqFiles(dir);
  let seq = nextSeq(existing);

  if (main.length === 0) {
    await main.close();
    return { written: 0, length: 0 };
  }

  const cap: Core = captureStore.get({ key: b4a.from(key) });
  await cap.ready();

  try {
    if (cap.length === 0 && existing.length > 0) {
      // The capture replica is a rebuildable cache; the folder is the record.
      await replayInto(cap, dir);
    }
    if (cap.length >= main.length) {
      return { written: 0, length: cap.length as number };
    }

    // Tap the capture replica's verify: every message it accepts from the
    // live replication below is persisted, in acceptance order, atomically.
    const written: number[] = [];
    const origVerify = cap.core.verify.bind(cap.core);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cap.core.verify = async (proof: any, from: any) => {
      const result = await origVerify(proof, from);

      // Allocate the sequence number SYNCHRONOUSLY, before any await.
      //
      // Block-carrying data messages bypass the replicator's rx lock and run
      // many in flight, so this function genuinely runs concurrently. Reading
      // `seq` on either side of an await let two invocations pick the same
      // number, write the same temp file and rename onto each other —
      // destroying one proof and leaving a hole in the numbering that the
      // next flush would then overwrite from.
      const mySeq = seq++;
      const bytes = c.encode(wire.data, { ...proof, request: 0 });
      const tmp = join(dir, `.tmp-${mySeq}`);
      await writeFile(tmp, bytes);
      await rename(tmp, join(dir, seqName(mySeq)));
      written.push(mySeq);
      return result;
    };

    const s1 = main.replicate(true);
    const s2 = cap.replicate(false);
    s1.pipe(s2).pipe(s1);
    try {
      await cap.download({ start: 0, end: main.length }).done();
    } finally {
      cap.core.verify = origVerify;
      s1.destroy();
      s2.destroy();
    }

    return { written: written.length, length: cap.length as number };
  } finally {
    await cap.close();
    await main.close();
  }
}

/**
 * Hydrate a log from its transport directory.
 *
 * Replays the message files into `key`'s core in `store` — the operation a
 * copied folder needs on a device that has never met the writer. Per-file
 * tolerant: a torn tail or tampered file is skipped and the replay continues,
 * yielding a valid-but-stale log that ordinary replication heals.
 */
export async function hydrateLogFromDir(
  store: Corestore,
  key: Uint8Array,
  dir: string,
): Promise<HydrateResult> {
  const core: Core = store.get({ key: b4a.from(key) });
  await core.ready();
  try {
    if ((await listSeqFiles(dir)).length === 0) {
      return { applied: 0, skipped: 0, length: core.length as number };
    }
    return await replayInto(core, dir);
  } finally {
    await core.close();
  }
}
