// Transparent encryption over a Log.
//
// Wraps any `Log` so blocks are sealed under a symmetric key automatically:
// `append()` seals plaintext before writing; `get()` opens ciphertext after
// reading. Callers work in plaintext and never see the sealing. The
// underlying log holds only ciphertext — a peer without the key, or any tool
// inspecting the raw blocks, sees opaque bytes.
//
// This is how tier-gated content (sealed under K0_org or a tier key) rides
// the same Hypercore replication path as everything else: the bytes on the
// wire and at rest are ciphertext; only a holder of the key projects them
// back to plaintext. The key is delivered out-of-band via the bundle
// envelope flow (see @workspace.sh/portable-bootstrap) or the live key delivery
// log.
//
// Composition, not modification: this wraps the platform Log rather than
// changing the runtime, so it works identically over a Node log, a spawned
// log, or a direct-pipe replica.

import { seal, open, SEAL_KEY_BYTES } from './seal.ts';
import type { Log, LogKey } from './types.ts';

/**
 * Return a `Log` that transparently seals on append and opens on get, using
 * a 32-byte symmetric key.
 *
 * The wrapper preserves the `Log` interface exactly — `key`, `writable`,
 * `length`, `on`, and `close` pass straight through to the underlying log.
 * Only `append` and `get` transform the bytes.
 *
 * Every peer that needs to read must wrap its replica of the same log with
 * the same key (e.g. `K0_org`, recovered from a bundle envelope).
 */
export function encryptedLog(log: Log, key: Uint8Array): Log {
  if (key.length !== SEAL_KEY_BYTES) {
    throw new Error(
      `encryption key must be ${SEAL_KEY_BYTES} bytes, got ${key.length}`,
    );
  }

  // Copy the key so a later mutation of the caller's buffer can't change
  // what this wrapper encrypts with.
  const k = new Uint8Array(key);

  return {
    get key(): LogKey {
      return log.key;
    },
    get writable(): boolean {
      return log.writable;
    },
    get length(): number {
      return log.length;
    },
    append(block: Uint8Array): Promise<number> {
      return log.append(seal(block, k));
    },
    async get(index: number): Promise<Uint8Array> {
      return open(await log.get(index), k);
    },
    on(event: 'append', cb: () => void): () => void {
      return log.on(event, cb);
    },
    close(): Promise<void> {
      return log.close();
    },
  };
}
