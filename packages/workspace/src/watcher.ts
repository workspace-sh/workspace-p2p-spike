// Working-tree watcher.
//
// `workspace-format.md` § "External edits — watching the working tree": a
// workspace folder is meant to behave like Dropbox — open a file in whichever
// editor you like, save, and Workspace picks up the change. That promise is
// what makes "the folder IS the workspace" honest.
//
// Until now the reverse direction did not exist. An external edit was not
// merely ignored: `materialise.ts` writes the folded log back to disk, so the
// next change on any device overwrote it (#221).
//
// ## What this module does and does not decide
//
// It reports *that a path changed and what the bytes now are*. It does not
// encode document entries — the log is a byte log and the document model
// belongs to `@workspace.sh/core` (see `documents.ts`). Keeping the
// interpretation out of here is what lets the same watcher serve a future
// format whose entries look nothing like today's.
//
// ## Portability
//
// One implementation for both hosts. `fs.watch` is imported unprefixed and
// resolves through the package `imports` map to `bare-fs` under Bare, whose
// `watch` takes the same `(path, { recursive }, cb)` shape as Node's. No
// chokidar, no injected platform factory.

import { stat, readFile, readdir } from 'fs/promises';
import { watch } from 'fs';
import { join, relative, sep } from 'path';

import { sha256Hex } from '@workspace.sh/p2p-runtime';

// The path taxonomy lives in its own fs-free module so the desktop app can
// apply the SAME rules to a native directory listing (#309). One copy.
import { META_DIR, isWatchablePath } from './paths.ts';

export { isWatchablePath };

/** What the watcher saw, once a path stopped moving. */
export interface WorkingTreeChange {
  /** Workspace-relative path, `/`-separated regardless of host. */
  path: string;
  /** File contents, or null if the path no longer exists. */
  bytes: Uint8Array | null;
}

export interface WatchOptions {
  /**
   * How long a path must be quiet before it is reported. The spec calls for
   * 100–300 ms: long enough that one user-level save lands as one ingest even
   * when the editor writes a temp file and renames over the original (Vim,
   * Sublime and friends), short enough to feel immediate.
   */
  debounceMs?: number;
  /**
   * Consecutive identical-size reads required before a file is considered
   * settled. Guards the 500 MB-video-being-copied-in case: without it a large
   * write is ingested as several partial copies.
   */
  stableReads?: number;
}

const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_STABLE_READS = 2;

/**
 * Whether an error means the path is genuinely gone.
 *
 * Only ENOENT does. Everything else — EACCES, EIO, a cloud provider failing to
 * materialise an evicted file — means "could not read", which is emphatically
 * not the same thing: a `bytes: null` report is taken by the consumer as an
 * external delete, and appending that tombstone REPLICATES, removing the
 * document from every device. That is #231's warning, in the read direction.
 *
 * So a read that failed for any other reason drops the event entirely. The
 * watcher will fire again; nothing is lost by waiting, and a great deal is
 * lost by guessing.
 */
function meansGone(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'ENOENT';
}



/**
 * Watch a workspace's working tree.
 *
 * Calls `onChange` once per settled path. Returns a stop function; calling it
 * is required — an unstopped watcher keeps the process alive.
 */
export function watchWorkingTree(
  folder: string,
  onChange: (change: WorkingTreeChange) => void,
  options: WatchOptions = {},
): () => void {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const stableReads = options.stableReads ?? DEFAULT_STABLE_READS;

  // One timer per path: a flurry of events for the same file collapses into
  // a single report, which is the whole point of the debounce.
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Paths with a settle in flight. Stabilisation sleeps, and the host keeps
  // emitting events during that sleep — without this, one save produces two
  // concurrent settles and two reports.
  const settling = new Set<string>();
  // Last reported content digest per path. A change that leaves the bytes
  // identical is not a change: reporting it would append a redundant entry
  // to an append-only log, which is the echo problem in miniature.
  const lastDigest = new Map<string, string | null>();
  let stopped = false;

  const report = (change: WorkingTreeChange): void => {
    const digest = change.bytes === null ? null : sha256Hex(change.bytes);
    if (lastDigest.has(change.path) && lastDigest.get(change.path) === digest) return;
    lastDigest.set(change.path, digest);
    onChange(change);
  };

  const settle = async (relPath: string): Promise<void> => {
    timers.delete(relPath);
    if (stopped) return;
    // Coalesce: a settle already running for this path will re-read the file
    // when it finishes, so a second one would only duplicate the work.
    if (settling.has(relPath)) return;
    settling.add(relPath);
    try {
      await settleInner(relPath);
    } finally {
      settling.delete(relPath);
    }
  };

  const settleInner = async (relPath: string): Promise<void> => {

    const absPath = join(folder, ...relPath.split('/'));

    // Size stabilisation. A file still being written reports a different
    // size each time; only report once it has held steady.
    let lastSize = -1;
    let steady = 0;
    for (;;) {
      let size: number;
      try {
        const st = await stat(absPath);
        if (st.isDirectory()) return; // directories are not documents
        size = st.size;
      } catch (err) {
        // Gone: a delete, or the temp half of an atomic save. The caller
        // decides what that means — and because it decides "deleted", only a
        // genuine ENOENT may say it.
        if (meansGone(err)) report({ path: relPath, bytes: null });
        return;
      }
      if (size === lastSize) {
        if (++steady >= stableReads - 1) break;
      } else {
        steady = 0;
        lastSize = size;
      }
      await new Promise(resolve => setTimeout(resolve, debounceMs));
      if (stopped) return;
    }

    try {
      const bytes = await readFile(absPath);
      if (!stopped) report({ path: relPath, bytes: new Uint8Array(bytes) });
    } catch (err) {
      // A file that vanished between the stat loop and here is a real delete.
      // A file we merely could not read is not, and reporting it as one
      // deletes the document on every device.
      if (!stopped && meansGone(err)) report({ path: relPath, bytes: null });
    }
  };

  const schedule = (relPath: string): void => {
    const existing = timers.get(relPath);
    if (existing) clearTimeout(existing);
    timers.set(
      relPath,
      setTimeout(() => {
        void settle(relPath);
      }, debounceMs),
    );
  };

  const watcher = watch(folder, { recursive: true }, (_event, filename) => {
    if (stopped || !filename) return;
    // Normalise to `/` so a workspace-relative path means the same thing on
    // every host — it becomes a document key, and the same workspace on
    // another device must agree about it.
    const relPath = String(filename).split(sep).join('/');
    if (!isWatchablePath(relPath)) return;
    schedule(relPath);
  });

  return () => {
    stopped = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    try {
      watcher.close();
    } catch {
      /* already closed */
    }
  };
}

/** How much of the working tree to read. */
export interface ListOptions {
  /**
   * Only read files ending in one of these (case-insensitive). Omit to read
   * everything watchable.
   *
   * The caller owns this list because it is a document-codec question, not a
   * filesystem one — but it has to be applied HERE, before the read, or the
   * bytes are paid for and discarded.
   */
  extensions?: string[];
}

/** One file found in the working tree. */
export interface WorkingTreeEntry {
  /** Workspace-relative, `/`-separated — the same key the watcher reports. */
  path: string;
  bytes: Uint8Array;
}

/**
 * Read every watchable file in the working tree, once.
 *
 * The watcher deliberately has no initial scan: it reports *changes*, so a file
 * that merely exists is invisible to it forever. That is the gap this fills —
 * it is what lets a reconcile pass see divergence that happened while the
 * workspace was closed (#280), and files that were in the folder before it was
 * ever a workspace (#271).
 *
 * Shares `isWatchablePath` and the relative-path normalisation with the
 * watcher, deliberately: if a scan and a watch disagreed about what counts as
 * a working-tree file, a document could be adopted here and then never tracked,
 * or tracked and never adopted.
 *
 * Unreadable entries are skipped rather than throwing. A workspace folder is a
 * hostile place — permissions, races with a sync client, symlinks that have
 * gone nowhere — and one bad file must not deny the caller the other hundred.
 */
export async function listWorkingTree(
  folder: string,
  options: ListOptions = {},
): Promise<WorkingTreeEntry[]> {
  const out: WorkingTreeEntry[] = [];
  const extensions = options.extensions?.map(e => e.toLowerCase());
  const wanted = (relPath: string): boolean =>
    extensions === undefined ||
    extensions.some(ext => relPath.toLowerCase().endsWith(ext));

  const walk = async (dir: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return; // unreadable directory — skip the subtree, keep the rest
    }
    for (const name of names) {
      const abs = join(dir, name);
      const relPath = toWorkspaceRelative(folder, abs);
      if (relPath === null) continue;

      let st: Awaited<ReturnType<typeof stat>>;
      try {
        // Follows symlinks, matching `fs.watch` and the spec's "symlinks are
        // followed by default".
        st = await stat(abs);
      } catch {
        continue; // vanished mid-walk, or a dangling symlink
      }
      const isDir = st.isDirectory();

      if (isDir) {
        // Prune excluded directories rather than descending: `.workspace/`
        // holds the container, and `node_modules` is the difference between a
        // scan and a hang.
        //
        // Probed with a synthetic child because `isWatchablePath` answers "is
        // this a reportable FILE" — it tests every segment for exclusion and
        // the last one for sidecar-ness. Asking it about `<dir>/x` is
        // therefore exactly "could anything under this directory be reported",
        // and reuses the taxonomy instead of duplicating the segment set here.
        if (!isWatchablePath(`${relPath}/x`)) continue;
        await walk(abs);
        continue;
      }

      if (!isWatchablePath(relPath)) continue;
      // Filter BEFORE reading. The caller's allowlist used to be applied after
      // the whole tree had been read and sent across the IPC boundary, so
      // opening a workspace read every PDF and video in it into memory, hex-
      // encoded them at twice the size, and threw them away — and on a cloud
      // volume, forced every evicted file to download first.
      if (!wanted(relPath)) continue;

      // A file whose data is not present reports its full logical size with no
      // blocks allocated. Reading it would block on a download, or fail. Skip:
      // this walk exists to find divergence, and a file we cannot see is not
      // evidence of any. `st_flags`/SF_DATALESS is not exposed to JS, but
      // `blocks` is, in both Node and Bare. Inline-compressed tiny files trip
      // this too — a false positive costs one skipped file, which is the safe
      // direction.
      if (st.size > 0 && st.blocks === 0) continue;

      try {
        const bytes = new Uint8Array(await readFile(abs));
        // Short of what the kernel just said was there: the file is in motion
        // — a sync engine mid-write, a copy still running. Adopting a torn
        // read would append a truncated document to an append-only log.
        if (bytes.length !== st.size) continue;
        out.push({ path: relPath, bytes });
      } catch {
        continue;
      }
    }
  };

  await walk(folder);
  return out;
}

/** Resolve `abs` to a workspace-relative, `/`-separated path, or null if outside. */
export function toWorkspaceRelative(folder: string, abs: string): string | null {
  const rel = relative(folder, abs);
  if (rel.length === 0 || rel.startsWith('..')) return null;
  return rel.split(sep).join('/');
}
