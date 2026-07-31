// Tests for the symmetric AEAD primitive (`src/seal.ts`).
//
// Covers round-trip, length contract, nonce uniqueness (same plaintext +
// same key → different ciphertexts), wrong-key rejection, tamper detection,
// edge cases (empty + large plaintext), input validation.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { seal, open, SEAL_OVERHEAD, SEAL_KEY_BYTES } from '../src/seal.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

function freshKey(): Uint8Array {
  const k = new Uint8Array(SEAL_KEY_BYTES);
  crypto.getRandomValues(k);
  return k;
}

test('round-trip: open recovers the original plaintext', () => {
  const key = freshKey();
  const sealed = seal(enc.encode('workspace-public content'), key);
  const opened = open(sealed, key);
  assert.equal(dec.decode(opened), 'workspace-public content');
});

test('length contract: sealed.length === plaintext.length + SEAL_OVERHEAD', () => {
  const key = freshKey();
  const plaintext = enc.encode('hello');
  const sealed = seal(plaintext, key);
  assert.equal(sealed.length, plaintext.length + SEAL_OVERHEAD);
});

test('non-determinism: same plaintext + same key produces different ciphertexts', () => {
  // Fresh random nonce per call means two consecutive seals of the same
  // bytes must differ — otherwise the nonce was reused, which is a critical
  // flaw for XSalsa20-Poly1305.
  const key = freshKey();
  const a = seal(enc.encode('same input'), key);
  const b = seal(enc.encode('same input'), key);
  assert.notDeepEqual(a, b);
  // Both still open to the same plaintext.
  assert.equal(dec.decode(open(a, key)), 'same input');
  assert.equal(dec.decode(open(b, key)), 'same input');
});

test('wrong-key rejection: opening with a different key throws', () => {
  const k1 = freshKey();
  const k2 = freshKey();
  const sealed = seal(enc.encode('only K1 can read this'), k1);
  assert.throws(() => open(sealed, k2), /open failed/);
});

test('tamper detection: flipping a ciphertext byte causes open to throw', () => {
  const key = freshKey();
  const sealed = seal(enc.encode('integrity matters'), key);
  // Flip a byte in the ciphertext portion (after the nonce).
  const tampered = new Uint8Array(sealed);
  tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01;
  assert.throws(() => open(tampered, key), /open failed/);
});

test('tamper detection: flipping a nonce byte causes open to throw', () => {
  const key = freshKey();
  const sealed = seal(enc.encode('nonce is authenticated too'), key);
  const tampered = new Uint8Array(sealed);
  tampered[0] = tampered[0]! ^ 0x01;
  assert.throws(() => open(tampered, key), /open failed/);
});

test('empty plaintext round-trips', () => {
  const key = freshKey();
  const sealed = seal(new Uint8Array(0), key);
  assert.equal(sealed.length, SEAL_OVERHEAD);
  const opened = open(sealed, key);
  assert.equal(opened.length, 0);
});

test('large plaintext (1 MiB) round-trips', () => {
  const key = freshKey();
  const big = new Uint8Array(1024 * 1024);
  // Fill in 64KiB chunks — Web Crypto's getRandomValues caps at 65536 bytes/call.
  for (let off = 0; off < big.length; off += 65536) {
    crypto.getRandomValues(big.subarray(off, Math.min(off + 65536, big.length)));
  }
  const sealed = seal(big, key);
  const opened = open(sealed, key);
  assert.deepEqual(opened, big);
});

test('input validation: wrong key length is rejected on seal', () => {
  const short = new Uint8Array(16);
  assert.throws(() => seal(enc.encode('x'), short), /key must be 32 bytes/);
});

test('input validation: wrong key length is rejected on open', () => {
  const key = freshKey();
  const sealed = seal(enc.encode('x'), key);
  const short = new Uint8Array(16);
  assert.throws(() => open(sealed, short), /key must be 32 bytes/);
});

test('input validation: sealed payload shorter than SEAL_OVERHEAD is rejected', () => {
  const key = freshKey();
  const truncated = new Uint8Array(10);
  assert.throws(() => open(truncated, key), /too short/);
});
