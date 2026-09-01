// Content hashing.
//
// Lives beside the other crypto primitives in this package for the reason
// stated in index.ts — they are independently useful, and consumers should
// not each reach for their own implementation and drift.
//
// sodium rather than `node:crypto`: this package runs under Bare on iOS and
// Android, where there is no `crypto` builtin. Digests are byte-identical to
// `createHash('sha256')`.

import b4a from 'b4a';
import sodiumModule from 'sodium-universal';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sodium = sodiumModule as any;

/** SHA-256 of `input`. */
export function sha256(input: Uint8Array): Uint8Array {
  const out = b4a.alloc(sodium.crypto_hash_sha256_BYTES);
  sodium.crypto_hash_sha256(out, input);
  return out;
}

/** SHA-256 of `input`, hex-encoded. */
export function sha256Hex(input: Uint8Array): string {
  return b4a.toString(sha256(input), 'hex');
}
