// Binary content for a workspace.
//
// `workspace-format.md`: "Unknown file types are recorded as opaque blobs and
// sync to peers byte-for-byte." Until now the document log could carry only
// strings, so a canvas synced to a peer without its images and rendered the
// broken-image placeholder — which the renderer does faithfully (#234).
//
// ## Why blobs get their own log
//
// This was the open question in #234, and the code answers it. `entries()`
// fetches, decrypts and returns EVERY block in the data log, and the store
// calls it on every `change` event. Put a 10 MB image in that log and every
// refresh on every peer becomes 10 MB of fetch-and-decrypt, forever.
//
// So blob bytes go in a separate log named in `manifest.logs` — which is a
// map precisely so a workspace can name more than one — and the data log
// keeps only small references. Fetching a blob is then something the app
// chooses to do, rather than something every peer pays for on every change.
//
// ## Why not Hyperblobs
//
// It is the ecosystem's purpose-built answer and it was the first thing
// checked. It wants a raw Hypercore, whereas every log here is wrapped by
// `encryptedLog` — composition over the `Log` interface, which is what gives
// tier-gated content its encryption. Using Hyperblobs would mean handing it
// the unwrapped core and writing blob bytes in the clear, or reimplementing
// the sealing inside it. Chunking over the existing `Log` is both smaller
// than that and keeps encryption a property of the abstraction rather than
// something each caller remembers.
//
// ## Format
//
// A blob is split into fixed-size chunks, each appended as one block. The
// reference returned carries the chunk indices, so reading is direct — no
// scan, no index block, no lookup table. The reference is what the document
// log stores, and it is small regardless of blob size.

import { sha256Hex } from '@workspace.sh/p2p-runtime';
import type { Log } from '@workspace.sh/p2p-runtime';

/**
 * 64 KiB. Small enough that a partial fetch is cheap and a chunk fits
 * comfortably in a Hypercore block after seal overhead; large enough that a
 * typical image is a handful of blocks rather than hundreds.
 */
export const CHUNK_BYTES = 64 * 1024;

/**
 * 64 MiB. A cap exists because a Hypercore log is the wrong home for a video
 * — every byte replicates to every peer that fetches the blob, and there is
 * no partial-file streaming here. Chosen to comfortably clear the images and
 * PDFs a workspace actually contains while refusing the case that would make
 * sync unusable. Raise it when there is a reason, not by default.
 */
export const MAX_BLOB_BYTES = 64 * 1024 * 1024;

/**
 * A pointer to blob content, small enough to live in a document entry.
 *
 * `id` is the SHA-256 of the content, hex-encoded. Content addressing gives
 * integrity checking (verified on read) and makes deduplication possible
 * without a format change.
 */
export interface BlobRef {
  /** Format version for the reference itself. */
  v: 1;
  /** SHA-256 of the content, hex. */
  id: string;
  /** Byte length of the content. */
  size: number;
  /** Indices of this blob's chunks in the blob log, in order. */
  chunks: number[];
  /**
   * Media type, when the writer knows it. Advisory: it tells a viewer how to
   * render without sniffing, and is not trusted for anything security-bearing.
   */
  contentType?: string;
}

export class BlobSizeError extends Error {
  constructor(size: number) {
    super(
      `file is ${formatBytes(size)}, which is over the ${formatBytes(MAX_BLOB_BYTES)} limit ` +
        `for workspace content — every peer downloads it in full, so large media ` +
        `should be linked rather than embedded`,
    );
    this.name = 'BlobSizeError';
  }
}

export class BlobIntegrityError extends Error {
  constructor(expected: string, actual: string) {
    super(`blob content does not match its hash (expected ${expected}, got ${actual})`);
    this.name = 'BlobIntegrityError';
  }
}

/** Human-readable byte size, for messages a user will read. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;
}

/**
 * Append `content` to `log` as chunks and return a reference to it.
 *
 * `seen` is an optional content-hash → reference cache. Passing one
 * deduplicates repeat writes of identical content — the same image dropped
 * into three canvases costs one copy. It is per-instance and therefore
 * per-session; durable deduplication needs an index of what the log already
 * holds, which is a separate piece of work and needs no format change,
 * because the hash is already in the reference.
 */
export async function writeBlob(
  log: Log,
  content: Uint8Array,
  options: {contentType?: string; seen?: Map<string, BlobRef>} = {},
): Promise<BlobRef> {
  if (content.byteLength > MAX_BLOB_BYTES) throw new BlobSizeError(content.byteLength);

  const id = sha256Hex(content);
  const cached = options.seen?.get(id);
  if (cached) return cached;

  const chunks: number[] = [];
  // A zero-length blob writes no chunks; `chunks: []` round-trips correctly
  // and costs nothing, which beats special-casing empty files at every reader.
  for (let offset = 0; offset < content.byteLength; offset += CHUNK_BYTES) {
    const end = Math.min(offset + CHUNK_BYTES, content.byteLength);
    // `subarray` shares memory rather than copying; the log serialises the
    // bytes on append, so no copy is needed here.
    chunks.push(await log.append(content.subarray(offset, end)) - 1);
  }

  const ref: BlobRef = {
    v: 1,
    id,
    size: content.byteLength,
    chunks,
    ...(options.contentType === undefined ? {} : {contentType: options.contentType}),
  };
  options.seen?.set(id, ref);
  return ref;
}

/**
 * Read the content a reference points at.
 *
 * Verifies the content against the reference's hash and throws on a mismatch.
 * The bytes arrive from a peer, so "these are the bytes that were written" is
 * a claim worth checking rather than assuming — and content addressing makes
 * the check free.
 */
export async function readBlob(log: Log, ref: BlobRef): Promise<Uint8Array> {
  const out = new Uint8Array(ref.size);
  let offset = 0;
  for (const index of ref.chunks) {
    const chunk = await log.get(index);
    if (offset + chunk.byteLength > ref.size) {
      // A chunk longer than the reference claims means the reference and the
      // log disagree; truncating silently would hand back plausible garbage.
      throw new BlobIntegrityError(ref.id, 'content longer than declared size');
    }
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== ref.size) {
    throw new BlobIntegrityError(ref.id, `content shorter than declared size (${offset}/${ref.size})`);
  }

  const actual = sha256Hex(out);
  if (actual !== ref.id) throw new BlobIntegrityError(ref.id, actual);
  return out;
}

/** Whether `value` is a well-formed blob reference. */
export function isBlobRef(value: unknown): value is BlobRef {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    r.v === 1 &&
    typeof r.id === 'string' &&
    r.id.length > 0 &&
    typeof r.size === 'number' &&
    Number.isFinite(r.size) &&
    r.size >= 0 &&
    Array.isArray(r.chunks) &&
    r.chunks.every(c => typeof c === 'number' && Number.isInteger(c) && c >= 0)
  );
}
