// Which paths in a workspace folder are content, and which are machinery.
//
// Split out of `watcher.ts` because that module imports `fs`, and the taxonomy
// is now needed somewhere `fs` does not exist: the desktop app lists a closed
// workspace's folder through a native module and filters the result in JS
// (#309). Importing the watcher there would drag Node's filesystem into a
// React Native bundle.
//
// One copy, deliberately. The exclusion taxonomy is exactly the kind of thing
// that drifts between the watcher, the tree walk, the seed script and the
// conformance suite if each keeps its own — and a scan and a watch disagreeing
// about what counts as a file means a document gets adopted and then never
// tracked, or tracked and never adopted.

/** The hidden container. Machine-facing; only the app writes it. */
export const META_DIR = '.workspace';

/** OS junk and VCS/tooling directories — never workspace content. */
const EXCLUDED_SEGMENTS = new Set([
  META_DIR,
  '.git',
  '.obsidian',
  'node_modules',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
]);

/** Editor sidecars: swap files, backups, lock files. */
function isSidecar(name: string): boolean {
  return (
    name.endsWith('.swp') ||
    name.endsWith('.swx') ||
    name.endsWith('~') ||
    name.startsWith('.~lock.') ||
    // Atomic-save temporaries. The debounce collapses the rename dance, but
    // the temp file itself must never be reported as a document.
    name.startsWith('.tmp-') ||
    name.endsWith('.tmp')
  );
}

/**
 * Whether a workspace-relative path should be reported at all.
 *
 * Exported because the exclusion taxonomy is the kind of thing that drifts
 * between the watcher, the seed script and the conformance suite if each
 * keeps its own copy.
 */
export function isWatchablePath(relPath: string): boolean {
  if (relPath.length === 0) return false;
  const segments = relPath.split('/');
  for (const segment of segments) {
    if (EXCLUDED_SEGMENTS.has(segment)) return false;
  }
  return !isSidecar(segments[segments.length - 1] ?? '');
}
