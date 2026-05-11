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
  const kp = hypercoreCrypto.keyPair(Buffer.from(seed)) as {
    publicKey: Buffer;
    secretKey: Buffer;
  };

  // Prepend multicodec prefix to the 32-byte public key.
  const prefixed = new Uint8Array(ED25519_PUB_MULTICODEC.length + kp.publicKey.length);
  prefixed.set(ED25519_PUB_MULTICODEC, 0);
  prefixed.set(kp.publicKey, ED25519_PUB_MULTICODEC.length);

  return `did:key:z${base58btcEncode(prefixed)}` as Did;
}
