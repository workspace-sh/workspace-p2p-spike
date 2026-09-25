// Wrapped-key primitive: anonymous-sender public-key encryption.
//
// Used by the permissions model to deliver a symmetric key to a recipient whose
// identity we know only by their ed25519 public key (the same key the
// recipient's `did:key:z6Mk…` resolves to). The recipient unwraps with their
// matching ed25519 secret key.
//
// Construction: sodium's crypto_box_seal — X25519 ECDH with an ephemeral
// sender keypair, then XSalsa20-Poly1305 AEAD. The sender's identity is not
// recoverable from the ciphertext; for our use case the sender's identity is
// carried separately by the UCAN that travels alongside the wrapped key.
//
// Ed25519 ↔ curve25519 conversion is handled internally so callers pass
// ed25519 keys (the form Hypercore + did:key already produce).

import b4a from 'b4a';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import sodiumModule from 'sodium-universal';

const sodium = sodiumModule as any;

const CURVE_PK_BYTES = sodium.crypto_box_PUBLICKEYBYTES as number;
const CURVE_SK_BYTES = sodium.crypto_box_SECRETKEYBYTES as number;
const SEAL_OVERHEAD = sodium.crypto_box_SEALBYTES as number;
const ED_PK_BYTES = sodium.crypto_sign_PUBLICKEYBYTES as number;
const ED_SK_BYTES = sodium.crypto_sign_SECRETKEYBYTES as number;

/** Bytes added to plaintext by `wrap`. ciphertext.length === plaintext.length + WRAP_OVERHEAD. */
export const WRAP_OVERHEAD: number = SEAL_OVERHEAD;

/**
 * Wrap arbitrary bytes for a recipient identified by an ed25519 public key.
 *
 * Typical use: encrypt a 32-byte symmetric key (e.g. `K0_org`) so only the
 * holder of the matching ed25519 secret key can recover it. The sender is
 * anonymous in the ciphertext — pair this with a UCAN if the sender's
 * identity needs to be attestable.
 */
export function wrap(plaintext: Uint8Array, recipientEdPublicKey: Uint8Array): Uint8Array {
  if (recipientEdPublicKey.length !== ED_PK_BYTES) {
    throw new Error(
      `recipient ed25519 public key must be ${ED_PK_BYTES} bytes, got ${recipientEdPublicKey.length}`,
    );
  }

  const curvePk = b4a.alloc(CURVE_PK_BYTES);
  sodium.crypto_sign_ed25519_pk_to_curve25519(curvePk, b4a.from(recipientEdPublicKey));

  const sealed = b4a.alloc(plaintext.length + SEAL_OVERHEAD);
  sodium.crypto_box_seal(sealed, b4a.from(plaintext), curvePk);
  return new Uint8Array(sealed);
}

/**
 * Unwrap a payload produced by `wrap`, using the recipient's ed25519 secret key
 * (sodium's 64-byte form: 32-byte seed concatenated with the 32-byte public key,
 * exactly what `hypercore-crypto.keyPair()` returns).
 *
 * Throws if the ciphertext was not addressed to this recipient or has been
 * tampered with.
 */
export function unwrap(sealed: Uint8Array, recipientEdSecretKey: Uint8Array): Uint8Array {
  if (recipientEdSecretKey.length !== ED_SK_BYTES) {
    throw new Error(
      `recipient ed25519 secret key must be ${ED_SK_BYTES} bytes ` +
        `(sodium format: 32-byte seed + 32-byte pubkey), got ${recipientEdSecretKey.length}`,
    );
  }
  if (sealed.length < SEAL_OVERHEAD) {
    throw new Error(`sealed payload too short to be a wrap (got ${sealed.length} bytes, need ≥ ${SEAL_OVERHEAD})`);
  }

  // Sodium's ed25519 secret-key form is 32-byte seed || 32-byte pubkey.
  const edPk = recipientEdSecretKey.subarray(32, 64);

  const curvePk = b4a.alloc(CURVE_PK_BYTES);
  sodium.crypto_sign_ed25519_pk_to_curve25519(curvePk, b4a.from(edPk));

  const curveSk = b4a.alloc(CURVE_SK_BYTES);
  sodium.crypto_sign_ed25519_sk_to_curve25519(curveSk, b4a.from(recipientEdSecretKey));

  const plaintext = b4a.alloc(sealed.length - SEAL_OVERHEAD);
  const ok = sodium.crypto_box_seal_open(
    plaintext,
    b4a.from(sealed),
    curvePk,
    curveSk,
  ) as boolean;
  if (!ok) {
    throw new Error('unwrap failed — wrong recipient or tampered payload');
  }
  return new Uint8Array(plaintext);
}
