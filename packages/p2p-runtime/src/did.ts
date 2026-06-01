// Derives a standards-compliant did:key from a Corestore primaryKey (ed25519 seed).
//
// did:key spec for ed25519:
//   1. Derive public key from seed via ed25519 (using hypercore-crypto, which
//      uses sodium-universal internally — already a transitive dep).
//   2. Prepend multicodec varint for ed25519-pub: 0xed 0x01
//   3. Encode with base58btc
//   4. Prepend multibase prefix 'z' (base58btc)
//   5. Prepend 'did:key:'
//
// Result: did:key:z6Mk... (the standard form used by ucanto / UCAN tooling)
//
// This replaces the spike placeholder (did:key:z<hex>) with a value that
// ucanto will accept as a valid DID when building delegation chains.

import { createRequire } from 'node:module';
import type { Did } from './types.ts';

const require = createRequire(import.meta.url);

// hypercore-crypto is a transitive dep of corestore — always present.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hypercoreCrypto = require('hypercore-crypto') as any;

// ---------------------------------------------------------------------------
// base58btc — minimal implementation (no external dep needed)
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58btcEncode(bytes: Uint8Array): string {
  // Count leading zero bytes (map to '1' in base58).
  let leadingZeros = 0;
  for (const b of bytes) {
    if (b !== 0) break;
    leadingZeros++;
  }

  // Convert bytes to a big integer via repeated division.
  const digits = [0];
  for (let i = leadingZeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  // Map to alphabet, add leading '1's, reverse.
  return (
    '1'.repeat(leadingZeros) +
    digits
      .reverse()
      .map((d) => BASE58_ALPHABET[d])
      .join('')
  );
}

function base58btcDecode(str: string): Uint8Array {
  // Count leading '1's (each maps to a leading zero byte).
  let leadingOnes = 0;
  for (const ch of str) {
    if (ch !== '1') break;
    leadingOnes++;
  }

  // Convert the base58 digits to bytes via repeated multiplication.
  const bytes: number[] = [];
  for (let i = leadingOnes; i < str.length; i++) {
    const ch = str[i]!;
    const digit = BASE58_ALPHABET.indexOf(ch);
    if (digit < 0) throw new Error(`invalid base58btc character: ${ch}`);
    let carry = digit;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Add leading zero bytes for each leading '1'.
  const out = new Uint8Array(leadingOnes + bytes.length);
  out.set(bytes.reverse(), leadingOnes);
  return out;
}

// ---------------------------------------------------------------------------
// ed25519 multicodec prefix (varint): 0xed 0x01
// ---------------------------------------------------------------------------

const ED25519_PUB_MULTICODEC = new Uint8Array([0xed, 0x01]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derive a standards-compliant `did:key` from a Corestore primaryKey.
 *
 * @param seed  The 32-byte primaryKey from `corestore.primaryKey`.
 * @returns     A `did:key:z6Mk…` string compatible with ucanto / UCAN tooling.
 */
export function didFromSeed(seed: Uint8Array): Did {
  return didFromPublicKey(keyPairFromSeed(seed).publicKey);
}

/**
 * Expand a 32-byte ed25519 seed to its full keypair (sodium form: 32-byte
 * public key, 64-byte secret key = seed‖public). Centralised here so callers
 * needing the signing key (e.g. attestation, membership) don't each reach for
 * hypercore-crypto.
 */
export function keyPairFromSeed(seed: Uint8Array): {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
} {
  if (seed.length !== 32) {
    throw new Error(`seed must be 32 bytes, got ${seed.length}`);
  }
  const kp = hypercoreCrypto.keyPair(Buffer.from(seed)) as {
    publicKey: Buffer;
    secretKey: Buffer;
  };
  return { publicKey: new Uint8Array(kp.publicKey), secretKey: new Uint8Array(kp.secretKey) };
}

/**
 * Encode a 32-byte ed25519 public key as a `did:key:z6Mk…` string.
 *
 * Used when you already have the public key (e.g. from a signer's keypair)
 * and don't need to re-derive it from a seed.
 */
export function didFromPublicKey(publicKey: Uint8Array): Did {
  if (publicKey.length !== 32) {
    throw new Error(`ed25519 public key must be 32 bytes, got ${publicKey.length}`);
  }
  const prefixed = new Uint8Array(ED25519_PUB_MULTICODEC.length + publicKey.length);
  prefixed.set(ED25519_PUB_MULTICODEC, 0);
  prefixed.set(publicKey, ED25519_PUB_MULTICODEC.length);
  return `did:key:z${base58btcEncode(prefixed)}` as Did;
}

/**
 * Inverse of `didFromPublicKey`: decode a `did:key:z6Mk…` to its 32-byte
 * ed25519 public key.
 *
 * Throws if the input is not a `did:key:z…` ed25519 DID.
 */
export function publicKeyFromDid(did: Did): Uint8Array {
  if (!did.startsWith('did:key:z')) {
    throw new Error(`not a did:key:z… DID: ${did}`);
  }
  const decoded = base58btcDecode(did.slice('did:key:z'.length));
  if (decoded.length < ED25519_PUB_MULTICODEC.length) {
    throw new Error('decoded DID is too short to carry an ed25519 multicodec prefix');
  }
  if (
    decoded[0] !== ED25519_PUB_MULTICODEC[0] ||
    decoded[1] !== ED25519_PUB_MULTICODEC[1]
  ) {
    throw new Error('DID multicodec prefix does not match ed25519-pub (0xed 0x01)');
  }
  return decoded.subarray(ED25519_PUB_MULTICODEC.length);
}
