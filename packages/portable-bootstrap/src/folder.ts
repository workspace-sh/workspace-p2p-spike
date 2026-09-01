// Filesystem pack/unpack for a portable bootstrap bundle.
//
// Writes a Bundle to the `.workspace/` subdirectory of a `.workspace/`
// folder per the layout in docs/workspace-format.md:
//
//   <workspaceDir>/
//   └── .workspace/
//       ├── manifest.json
//       ├── attestation.json
//       └── envelopes/
//           └── <encoded-did>.json
//
// This is the **light bundle** form — manifest + attestation + envelopes only.
// The encrypted store (.workspace/store/) and the working tree (user-facing
// files like policies/, data/, ideas/) are written elsewhere as separate
// concerns: see issue #9 (key delivery log) and the runtime layer for the
// store; the working tree is the application's responsibility.
//
// See docs/workspace-format.md for the full on-disk layout.

import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { join } from 'path';

import {
  serialiseBundle,
  deserialiseBundle,
  type Bundle,
  type SerialisedBundle,
} from './index.ts';

const META_DIR = '.workspace';
const MANIFEST_FILE = 'manifest.json';
const ATTESTATION_FILE = 'attestation.json';
const ENVELOPES_DIR = 'envelopes';

/**
 * Write a bundle to the `.workspace/` subdirectory of `workspaceDir`.
 * Creates directories as needed. Does not write the encrypted store or
 * the user-facing working tree — those are separate concerns.
 *
 * `workspaceDir` is the path to the `.workspace/` directory itself
 * (e.g. `/path/to/my-org.workspace`). The function does not enforce or
 * append the `.workspace` extension; callers pick the name.
 */
export async function writeBundleFolder(
  bundle: Bundle,
  workspaceDir: string,
): Promise<void> {
  const metaDir = join(workspaceDir, META_DIR);
  const envelopesDir = join(metaDir, ENVELOPES_DIR);
  await mkdir(envelopesDir, { recursive: true });

  // TODO(windows): dot-prefix is not honoured by Windows Explorer. When this
  // code runs on win32, set FILE_ATTRIBUTE_HIDDEN on metaDir via the Win32
  // API (or `attrib +h`) so the directory is hidden from non-technical users.
  // macOS / Linux honour the dot-prefix natively — no action needed there.

  const s = serialiseBundle(bundle);

  await writeFile(
    join(metaDir, MANIFEST_FILE),
    JSON.stringify(s.manifest, null, 2) + '\n',
    'utf8',
  );
  await writeFile(
    join(metaDir, ATTESTATION_FILE),
    JSON.stringify(s.attestation, null, 2) + '\n',
    'utf8',
  );

  // One file per envelope, named by an encoding of the recipient DID.
  // Sequential writes are fine: bundles rarely have more than a handful
  // of envelopes at first-contact time, and ordering keeps test output
  // deterministic.
  for (const envelope of s.envelopes) {
    const name = encodeDidForFilename(envelope.recipient) + '.json';
    await writeFile(
      join(envelopesDir, name),
      JSON.stringify(envelope, null, 2) + '\n',
      'utf8',
    );
  }
}

/**
 * Read a bundle previously written by `writeBundleFolder`.
 *
 * Returns the in-memory Bundle ready for `consumeBundle`. Does not validate
 * the attestation — that's `consumeBundle`'s job. This function only handles
 * the filesystem layer.
 */
export async function readBundleFolder(workspaceDir: string): Promise<Bundle> {
  const metaDir = join(workspaceDir, META_DIR);
  const envelopesDir = join(metaDir, ENVELOPES_DIR);

  const manifestText = await readFile(join(metaDir, MANIFEST_FILE), 'utf8');
  const attestationText = await readFile(join(metaDir, ATTESTATION_FILE), 'utf8');

  // Envelopes directory may be empty (light bundle with no pre-invited
  // recipients — workspace expects all members to join via the live key
  // delivery log).
  let envelopeFiles: string[] = [];
  try {
    envelopeFiles = (await readdir(envelopesDir))
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch (err) {
    if (!isNodeENOENT(err)) throw err;
  }

  const envelopes: SerialisedBundle['envelopes'] = [];
  for (const file of envelopeFiles) {
    const text = await readFile(join(envelopesDir, file), 'utf8');
    envelopes.push(JSON.parse(text) as SerialisedBundle['envelopes'][number]);
  }

  const serialised: SerialisedBundle = {
    manifest: JSON.parse(manifestText) as SerialisedBundle['manifest'],
    attestation: JSON.parse(attestationText) as SerialisedBundle['attestation'],
    envelopes,
  };

  return deserialiseBundle(serialised);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Encode a DID into a filesystem-safe filename stem.
 *
 *   did:key:z6MkpKpf2nFiC5h9qDPgJrkBbYBaThkAEcVCgGuBHkXqK4Vc
 *   → did_key_z6MkpKpf2nFiC5h9qDPgJrkBbYBaThkAEcVCgGuBHkXqK4Vc
 *
 * Colons are valid on POSIX filesystems but not on Windows. Replacing them
 * with underscores keeps filenames cross-platform without losing any DID
 * information (DIDs already restrict the legal character set in the
 * method-specific identifier per RFC 8141 / the DID Core spec, so a simple
 * one-to-one substitution is lossless).
 */
function encodeDidForFilename(did: string): string {
  return did.replace(/:/g, '_');
}

interface NodeFsError extends Error {
  code?: string;
}

function isNodeENOENT(err: unknown): err is NodeFsError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeFsError).code === 'ENOENT'
  );
}
