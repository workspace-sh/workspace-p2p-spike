// Public surface of @workspace/p2p-runtime.

export { createRuntime } from './runtime.ts';
export type {
  P2PRuntime,
  Log,
  Did,
  TopicId,
  LogKey,
  CreateRuntimeOptions,
} from './types.ts';

// Crypto primitives — exposed because they're independently useful (e.g. to
// @workspace/portable-bootstrap which composes them into the bundle format).
export { didFromSeed, didFromPublicKey, publicKeyFromDid } from './did.ts';
export { wrap, unwrap, WRAP_OVERHEAD } from './wrap.ts';
export { seal, open, SEAL_OVERHEAD, SEAL_KEY_BYTES } from './seal.ts';
export { encryptedLog } from './encrypted-log.ts';
export {
  sign,
  verify,
  buildAttestationPayload,
  signWorkspaceAttestation,
  verifyWorkspaceAttestation,
} from './attestation.ts';
export type { AttestationPayload, SignedAttestation } from './attestation.ts';
