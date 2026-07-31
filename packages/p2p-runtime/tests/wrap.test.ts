// Tests for the wrapped-key primitive (`src/wrap.ts`).
//
// Covers round-trip, length contract, non-determinism (fresh ephemeral key per
// wrap), wrong-recipient rejection, tamper detection, edge cases (empty + large
// plaintext), and input validation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { wrap, unwrap, WRAP_OVERHEAD } from '../src/wrap.ts';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hypercoreCrypto = require('hypercore-crypto') as any;

function keypair(): { publicKey: Buffer; secretKey: Buffer } {
  return hypercoreCrypto.keyPair() as { publicKey: Buffer; secretKey: Buffer };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

test('round-trip: unwrap recovers the original plaintext', () => {
  const recipient = keypair();
  const wrapped = wrap(enc.encode('this is a secret'), recipient.publicKey);
  const unwrapped = unwrap(wrapped, recipient.secretKey);
  assert.equal(dec.decode(unwrapped), 'this is a secret');
});

test('output size: ciphertext is plaintext.length + WRAP_OVERHEAD', () => {
  const recipient = keypair();
  const plaintext = new Uint8Array(32);
  crypto.getRandomValues(plaintext);
  const wrapped = wrap(plaintext, recipient.publicKey);
  assert.equal(wrapped.length, plaintext.length + WRAP_OVERHEAD);
});

test('non-deterministic: wrapping the same plaintext twice produces different ciphertext', () => {
  const recipient = keypair();
  const plaintext = enc.encode('same input');
  const w1 = wrap(plaintext, recipient.publicKey);
  const w2 = wrap(plaintext, recipient.publicKey);
  assert.notDeepEqual(Array.from(w1), Array.from(w2));
});

test('wrong recipient: unwrap with a different secret key throws', () => {
  const intended = keypair();
  const attacker = keypair();
  const wrapped = wrap(enc.encode('not for you'), intended.publicKey);
  assert.throws(() => unwrap(wrapped, attacker.secretKey), /unwrap failed/);
});

test('tampered ciphertext: flipping one bit causes unwrap to throw', () => {
  const recipient = keypair();
  const wrapped = wrap(enc.encode('payload under test'), recipient.publicKey);
  // Flip a bit in the AEAD-protected body, past the ephemeral pubkey (bytes 0..31).
  const last = wrapped.length - 1;
  wrapped[last] = wrapped[last]! ^ 0x01;
  assert.throws(() => unwrap(wrapped, recipient.secretKey), /unwrap failed/);
});

test('empty plaintext round-trips and produces an OVERHEAD-only ciphertext', () => {
  const recipient = keypair();
  const wrapped = wrap(new Uint8Array(0), recipient.publicKey);
  assert.equal(wrapped.length, WRAP_OVERHEAD);
  const unwrapped = unwrap(wrapped, recipient.secretKey);
  assert.equal(unwrapped.length, 0);
});

test('256-byte plaintext round-trips byte-for-byte', () => {
  const recipient = keypair();
  const plaintext = new Uint8Array(256);
  crypto.getRandomValues(plaintext);
  const wrapped = wrap(plaintext, recipient.publicKey);
  const unwrapped = unwrap(wrapped, recipient.secretKey);
  assert.deepEqual(Array.from(unwrapped), Array.from(plaintext));
});

test('wrap rejects a public key of wrong length', () => {
  assert.throws(() => wrap(enc.encode('hi'), new Uint8Array(31)), /32 bytes/);
});

test('unwrap rejects a secret key of wrong length', () => {
  const recipient = keypair();
  const wrapped = wrap(enc.encode('hi'), recipient.publicKey);
  assert.throws(() => unwrap(wrapped, new Uint8Array(32)), /64 bytes/);
});

test('unwrap rejects a sealed payload shorter than WRAP_OVERHEAD', () => {
  const recipient = keypair();
  assert.throws(() => unwrap(new Uint8Array(10), recipient.secretKey), /too short/);
});
