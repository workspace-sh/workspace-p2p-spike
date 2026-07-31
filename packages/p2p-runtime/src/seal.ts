// Symmetric AEAD primitive — sealing content under a workspace key.
//
// Wraps and unwraps arbitrary bytes under a 32-byte symmetric key (e.g.
// `K0_org`, a tier key). Distinct from `wrap.ts`: that one is asymmetric
// (delivering a key to a recipient's pubkey); this one is symmetric (using
// a key that's already been delivered to both sides).
//
// Construction: sodium's `crypto_secretbox_easy` — XSalsa20-Poly1305 AEAD.
// A fresh 24-byte random nonce is prepended to each ciphertext, so callers
// can reuse the same key across many `seal()` calls without bookkeeping.
//
//   sealed = nonce(24) || ciphertext(plaintext_len + 16)
//
// Used in the encrypted-store flow: Hypercore blocks for tier-gated content
// are sealed under the relevant tier key before being appended; peers that
// hold the key unseal on read. Without the key, blocks are opaque bytes.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sodium = require('sodium-universal') as any;

const NONCE_BYTES = sodium.crypto_secretbox_NONCEBYTES as number;
const KEY_BYTES = sodium.crypto_secretbox_KEYBYTES as number;
const MAC_BYTES = sodium.crypto_secretbox_MACBYTES as number;

/** Bytes added to plaintext by `seal`. ciphertext.length === plaintext.length + SEAL_OVERHEAD. */
export const SEAL_OVERHEAD: number = NONCE_BYTES + MAC_BYTES;

/** Required key length for `seal` / `open`. */
export const SEAL_KEY_BYTES: number = KEY_BYTES;

/**
 * Encrypt `plaintext` under a 32-byte symmetric `key`. Each call uses a fresh
 * random nonce; the same key can be reused safely across many `seal` calls.
 *
 * Returns a single Uint8Array: nonce(24) || ciphertext+mac(plaintext.length + 16).
 */
export function seal(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.length !== KEY_BYTES) {
    throw new Error(`key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }

  const nonce = Buffer.alloc(NONCE_BYTES);
  sodium.randombytes_buf(nonce);

  const cipher = Buffer.alloc(plaintext.length + MAC_BYTES);
  sodium.crypto_secretbox_easy(cipher, Buffer.from(plaintext), nonce, Buffer.from(key));

  const out = Buffer.alloc(NONCE_BYTES + cipher.length);
  nonce.copy(out, 0);
  cipher.copy(out, NONCE_BYTES);
  return new Uint8Array(out);
}

/**
 * Decrypt a payload produced by `seal`, using the same 32-byte key.
 *
 * Throws if the ciphertext was sealed under a different key, has been
 * tampered with, or is too short to be a valid seal.
 */
export function open(sealed: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.length !== KEY_BYTES) {
    throw new Error(`key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
  if (sealed.length < SEAL_OVERHEAD) {
    throw new Error(
      `sealed payload too short (got ${sealed.length} bytes, need ≥ ${SEAL_OVERHEAD})`,
    );
  }

  const nonce = sealed.subarray(0, NONCE_BYTES);
  const cipher = sealed.subarray(NONCE_BYTES);

  const plaintext = Buffer.alloc(cipher.length - MAC_BYTES);
  const ok = sodium.crypto_secretbox_open_easy(
    plaintext,
    Buffer.from(cipher),
    Buffer.from(nonce),
    Buffer.from(key),
  ) as boolean;
  if (!ok) {
    throw new Error('open failed — wrong key or tampered payload');
  }
  return new Uint8Array(plaintext);
}
