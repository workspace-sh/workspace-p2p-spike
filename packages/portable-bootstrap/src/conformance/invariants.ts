// Conformance checks for the `.workspace` format invariants.
//
// docs/workspace-format.md opens with six numbered invariants and says why
// they are written down:
//
//   "They exist so the metaphor is tested against, not re-litigated, each
//    time a decision comes up."
//
// "Tested against" was aspirational until now. Invariant 6 was violated by
// the very script it held up as the example — the mobile seed copied
// `.workspace/keys/`, a peer's own identity, onto every device it seeded
// (workspace-sh/workspace#233). The invariant was written, published, and
// pointed at the file that broke it. Prose cannot enforce anything; this
// module is the enforcement.
//
// Deliberately a LIBRARY rather than a test file. The value is in pointing it
// at any tree that claims to be a workspace — one the app just created, one
// that survived a `cp -R`, or the output of a seed or export path — rather
// than at one writer's happy path. Export paths are exactly where invariant 6
// failed, and a test that only covers `writeBundleFolder` would not have
// caught it.
//
// Scope is on-disk SHAPE. The cryptography has its own tests; this asks
// whether the bytes are arranged the way the format promises.

import { readdir, readFile, stat } from 'fs/promises';
import { join, relative, sep } from 'path';

/** A single invariant violation. */
export interface Violation {
  /** Which numbered invariant from workspace-format.md was broken. */
  invariant: number;
  /** Workspace-relative path of the offending entry, or '' for the tree. */
  path: string;
  /** What is wrong, in terms someone can act on. */
  message: string;
}

export interface CheckOptions {
  /**
   * Treat the tree as an export/transport artefact rather than a live
   * workspace — i.e. one that should carry no `.workspace/` at all.
   *
   * The default (`false`) checks a working workspace: `.workspace/` is
   * expected, but `keys/` still must not be present if the tree came from
   * anywhere other than this device.
   */
  export?: boolean;
}

const META_DIR = '.workspace';

/** Files inside `.workspace/` that the format defines. */
const KNOWN_META_ENTRIES = new Set([
  'manifest.json',
  'attestation.json',
  'policy.json',
  'envelopes',
  'keys',
  'store',
]);

/**
 * Mutable state files break invariant 4: append-only and content-addressed
 * layouts tolerate a cloud-sync race, lock files do not. Matched by suffix
 * because the names vary but the shapes do not.
 */
const LOCK_SUFFIXES = ['.lock', '.lck', '.pid', '.tmp'];

/**
 * Check a workspace tree against the format invariants.
 *
 * Returns every violation rather than throwing on the first, so a caller sees
 * the whole picture in one pass.
 */
export async function checkWorkspaceInvariants(
  workspaceDir: string,
  options: CheckOptions = {},
): Promise<Violation[]> {
  const violations: Violation[] = [];
  const metaDir = join(workspaceDir, META_DIR);

  const metaExists = await isDirectory(metaDir);

  if (options.export) {
    // An export has left the container behind: no metadata, no keys, no
    // encrypted store — "just data on disk", per the format doc.
    if (metaExists) {
      violations.push({
        invariant: 6,
        path: META_DIR,
        message:
          'an exported tree must not carry .workspace/ — export plaintext and ' +
          'copy-the-folder are different operations and must not be conflated',
      });
    }
  } else if (!metaExists) {
    violations.push({
      invariant: 1,
      path: '',
      message: 'no .workspace/ directory — not a workspace',
    });
  }

  // Invariant 1: all machinery lives in ONE hidden directory. A metadata file
  // scattered next to content is the failure this forbids.
  // Invariant 6: keys never travel.
  // Invariant 4: no mutable lock/state files anywhere in the container.
  await walk(workspaceDir, workspaceDir, violations, options);

  if (metaExists && !options.export) {
    await checkMetaDir(workspaceDir, metaDir, violations);
  }

  return violations;
}

async function checkMetaDir(
  root: string,
  metaDir: string,
  violations: Violation[],
): Promise<void> {
  const entries = await readdir(metaDir);

  // The two files that make a workspace identifiable at all.
  for (const required of ['manifest.json', 'attestation.json']) {
    if (!entries.includes(required)) {
      violations.push({
        invariant: 1,
        path: join(META_DIR, required),
        message: `missing ${required} — a workspace cannot be identified without it`,
      });
    }
  }

  for (const entry of entries) {
    if (KNOWN_META_ENTRIES.has(entry)) continue;
    violations.push({
      invariant: 1,
      path: join(META_DIR, entry),
      message:
        `unrecognised entry in .workspace/ — as the metadata surface grows it ` +
        `grows inside this directory, but every entry should be one the format defines`,
    });
  }

  // Invariant 5: a plain `cp -R` must produce a valid workspace, so nothing
  // in here may be unreadable without the app present.
  const manifestPath = join(metaDir, 'manifest.json');
  if (entries.includes('manifest.json')) {
    try {
      const text = await readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(text) as Record<string, unknown>;
      for (const field of ['formatVersion', 'workspaceId', 'rootDid']) {
        if (manifest[field] === undefined) {
          violations.push({
            invariant: 1,
            path: join(META_DIR, 'manifest.json'),
            message: `manifest is missing '${field}'`,
          });
        }
      }
      // Every log the manifest names must have its transport directory. A
      // manifest pointing at logs with no store behind it is the 8 KB-stub
      // failure this suite originally waved through (#249): the folder
      // claims to be a workspace while its data lives on another machine.
      const logs = manifest.logs as Record<string, string> | undefined;
      if (logs && typeof logs === 'object') {
        for (const [name, key] of Object.entries(logs)) {
          if (typeof key !== 'string' || key.length === 0) continue;
          if (!(await isDirectory(join(metaDir, 'store', 'v1', key)))) {
            violations.push({
              invariant: 5,
              path: join(META_DIR, 'store', 'v1', key),
              message:
                `manifest names a '${name}' log but its transport directory is ` +
                `absent — a copy of this folder cannot carry the workspace's data`,
            });
          }
        }
      }
    } catch (err) {
      violations.push({
        invariant: 5,
        path: relative(root, manifestPath),
        message: `manifest.json is not readable JSON: ${(err as Error).message}`,
      });
    }
  }
}

async function walk(
  root: string,
  dir: string,
  violations: Violation[],
  options: CheckOptions,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = join(dir, entry);
    const rel = relative(root, full);
    const segments = rel.split(sep);
    const metaIndex = segments.indexOf(META_DIR);
    const insideMeta = metaIndex !== -1;

    // Invariant 6. Checked by path segment, not basename: a working tree may
    // legitimately hold a folder called `keys/`, and only
    // `.workspace/keys` is private key state.
    if (insideMeta && segments[metaIndex + 1] === 'keys') {
      violations.push({
        invariant: 6,
        path: rel,
        message:
          'this peer\'s private key state must never travel to another device — ' +
          'in any mode, behind any flag',
      });
      continue; // No point descending; the whole subtree is the violation.
    }

    // Invariant 4. A mutable lock or pid file cannot survive a cloud-sync
    // race, and the format has none by design.
    if (LOCK_SUFFIXES.some(suffix => entry.endsWith(suffix))) {
      violations.push({
        invariant: 4,
        path: rel,
        message:
          `mutable state file — append-only and content-addressed layouts ` +
          `tolerate Dropbox/iCloud sync races, lock files do not`,
      });
    }

    // Invariant 1. A stray dotfile beside content is metadata that escaped
    // the one directory it is allowed to live in.
    if (!insideMeta && entry.startsWith('.workspace') && entry !== META_DIR) {
      violations.push({
        invariant: 1,
        path: rel,
        message:
          'workspace metadata outside .workspace/ — all machinery lives in ' +
          'one hidden directory, never scattered beside content',
      });
    }

    if (await isDirectory(full)) {
      await walk(root, full, violations, options);
    }
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Throw if `workspaceDir` violates any invariant. For use in test suites. */
export async function assertWorkspaceInvariants(
  workspaceDir: string,
  options: CheckOptions = {},
): Promise<void> {
  const violations = await checkWorkspaceInvariants(workspaceDir, options);
  if (violations.length === 0) return;
  const lines = violations.map(
    v => `  invariant ${v.invariant}: ${v.path || '<tree>'} — ${v.message}`,
  );
  throw new Error(
    `${violations.length} .workspace format violation(s):\n${lines.join('\n')}`,
  );
}
