// A `crypto` stand-in for the Bare worklet.
//
// Bare has no `crypto` builtin, and one dependency in the UCAN graph reaches
// for Node's: `multiformats` hashes with `crypto.createHash(...)` in
// `hashes/sha2.js` and `hashes/sha1.js`. Those files live in node_modules,
// so the host-conditional `imports` map that fixes our own sources (#229)
// cannot reach them — bare-pack's `--imports` global override can, and this
// is what it points at. See scripts/bare-imports.cjs.
//
// "Global" overstates the blast radius: those two multiformats files are the
// only importers of `crypto` anywhere in the packed graph. Worth re-checking
// if the dependency set changes:
//
//   grep -rlE "from '(node:)?crypto'|require\('(node:)?crypto'\)" node_modules/…
//
// Backed by sodium-universal, which is already a dependency, is already
// Bare-native, and produces byte-identical digests to Node's createHash —
// the same equivalence relied on for topic derivation in
// @workspace.sh/workspace.

import b4a from 'b4a';
import sodiumModule from 'sodium-universal';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sodium = sodiumModule as any;

interface Algorithm {
  bytes: number;
  hash(out: Uint8Array, input: Uint8Array): void;
}

const ALGORITHMS: Record<string, Algorithm> = {
  sha256: {
    bytes: sodium.crypto_hash_sha256_BYTES,
    hash: (out, input) => sodium.crypto_hash_sha256(out, input),
  },
  sha512: {
    bytes: sodium.crypto_hash_sha512_BYTES,
    hash: (out, input) => sodium.crypto_hash_sha512(out, input),
  },
};

/**
 * The subset of Node's Hash that callers in this graph actually use:
 * `createHash(alg).update(data).digest()`.
 *
 * sodium's hashes are one-shot, so chunks are buffered and hashed on digest.
 * That differs from Node's streaming implementation in memory profile, not in
 * output — and the inputs here are UCAN payloads, not large files.
 */
class Hash {
  private readonly algorithm: Algorithm;
  private readonly chunks: Uint8Array[] = [];

  constructor(algorithm: Algorithm) {
    this.algorithm = algorithm;
  }

  update(data: Uint8Array | string): this {
    this.chunks.push(typeof data === 'string' ? b4a.from(data) : data);
    return this;
  }

  digest(encoding?: string): Uint8Array | string {
    const input = this.chunks.length === 1 ? this.chunks[0]! : b4a.concat(this.chunks);
    const out = b4a.alloc(this.algorithm.bytes);
    this.algorithm.hash(out, input);
    return encoding ? b4a.toString(out, encoding) : out;
  }
}

export function createHash(algorithm: string): Hash {
  const alg = ALGORITHMS[algorithm];
  if (!alg) {
    // Deliberately loud. sodium omits SHA-1 because it is broken, so a caller
    // asking for it needs a decision, not a silent fallback to wrong bytes.
    throw new Error(
      `crypto shim: unsupported algorithm '${algorithm}' (have: ${Object.keys(ALGORITHMS).join(', ')})`,
    );
  }
  return new Hash(alg);
}

// multiformats does `import crypto from 'crypto'`, so the default export is
// the one that matters; the named export is for parity with Node.
export default { createHash };
