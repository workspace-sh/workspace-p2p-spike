// @workspace.sh/ucan-boundary
//
// The one module that touches a UCAN library. Other packages import from here,
// never from `iso-ucan` or `iso-signatures`, so the library behind it can change
// without their import surface changing.
//
// Tokens are UCAN 1.0 delegations (https://github.com/ucan-wg/delegation),
// through `iso-ucan`. A capability this module is given as `{ can, with }`
// becomes, in the token:
//
//   cmd  `/${can}`                          e.g. `/workspace/read`
//   sub  the workspace root's DID           the authority the chain ends at
//   pol  [["==", ".resource", with]]        the resource, as the spec asks
//                                           external resources be expressed
//
// Public surface (all opaque to consumers):
//   - generatePrincipal / principalFromSeed — identity material
//   - didOf / didToPublicKey — DID encoding and decoding
//   - issueDelegation — sign a delegation, optionally on top of a parent chain
//   - validateDelegation — verify a chain back to the resource's root
//   - toBytes / fromBytes — transport-friendly serialisation
//   - WHOLE_SECOND_FLOOR — UCAN times are whole seconds

import * as dagCbor from '@ipld/dag-cbor';
import { hashes as ed25519Hashes } from '@noble/ed25519';
import b4a from 'b4a';
import { base64 } from 'iso-base/rfc4648';
import { DIDKey } from 'iso-did/key';
import { EdDSASigner } from 'iso-signatures/signers/eddsa.js';
import { verify as verifyEd25519 } from 'iso-signatures/verifiers/eddsa.js';
import { Resolver } from 'iso-signatures/verifiers/resolver.js';
import { Delegation } from 'iso-ucan/delegation';
import { validate as policyAllows } from 'iso-ucan/policy';
import sodiumModule from 'sodium-universal';

const sodium = sodiumModule;

// Hashing and randomness come from sodium, never from the `crypto` global. This
// module packs into the mobile Bare worklet, which has no `crypto`; left alone,
// `@noble/ed25519` hashes with WebCrypto and `iso-ucan` draws nonces from it.
// The hook is the one `@noble/ed25519` provides for exactly this, and the
// instance set here is the one `iso-signatures` signs and verifies with.
function sha512(message: Uint8Array): Uint8Array<ArrayBuffer> {
  const digest = b4a.alloc(64);
  sodium.crypto_hash_sha512(digest, message);
  return digest;
}
ed25519Hashes.sha512 = sha512;
ed25519Hashes.sha512Async = async (message) => sha512(message);

function randomNonce(): Uint8Array {
  const nonce = b4a.alloc(12);
  sodium.randombytes_buf(nonce);
  return nonce;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Stable peer identity. did:key:z6Mk… (ed25519). */
export type Did = `did:key:${string}`;

/**
 * Opaque handle to a signing principal. Consumers pass it to issueDelegation
 * but cannot inspect its internals.
 */
export interface Principal {
  did(): Did;
  /** Internal — do not access. */
  // eslint-disable-next-line @typescript-eslint/naming-convention
  readonly _signer: unknown;
}

/**
 * Opaque handle to a UCAN delegation and the chain beneath it. Construct via
 * issueDelegation or fromBytes; pass to validateDelegation or toBytes.
 */
export interface DelegationToken {
  /** Public-only metadata safe to inspect without breaking the boundary. */
  readonly meta: {
    readonly issuer: Did;
    readonly audience: Did;
    readonly capabilities: readonly CapabilityDescriptor[];
    readonly expiration?: number;
    readonly notBefore?: number;
  };
  /** Internal — do not access. */
  // eslint-disable-next-line @typescript-eslint/naming-convention
  readonly _delegation: unknown;
}

/** A capability the issuer is granting the audience. */
export interface CapabilityDescriptor {
  /** e.g. "workspace/read", "table/edit" */
  readonly can: string;
  /** Resource URI, e.g. "workspace://v1/<id>" */
  readonly with: string;
}

/** Result of validating a delegation chain. */
export type ValidationResult =
  | { ok: true; audience: Did; capability: CapabilityDescriptor }
  | { ok: false; error: string };

/**
 * The DID that is the root authority over a resource: the only principal whose
 * self-issued delegation can start a chain granting it. Return `null` when the
 * resource has no root this caller recognises, and every chain is refused.
 */
export type RootForResource = (resourceUri: string) => Did | null;

/** UCAN times are whole seconds; fractional values are floored. */
export const WHOLE_SECOND_FLOOR = true;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Leaf first: the token's own delegation, then each parent up to the root. */
type Chain = readonly Delegation[];

const verifierResolver = new Resolver({ Ed25519: verifyEd25519 });

function wrap(signer: EdDSASigner): Principal {
  return {
    did: () => signer.toString() as Did,
    _signer: signer,
  };
}

function signerOf(principal: Principal): EdDSASigner {
  return principal._signer as EdDSASigner;
}

function chainOf(token: DelegationToken): Chain {
  return token._delegation as Chain;
}

function commandFor(can: string): string {
  return `/${can}`;
}

/** The resource a delegation's policy names, or undefined if it names none. */
function resourceOf(policy: unknown): string | undefined {
  if (!Array.isArray(policy)) return undefined;
  for (const statement of policy) {
    if (Array.isArray(statement) && statement[0] === '==' && statement[1] === '.resource' && typeof statement[2] === 'string') {
      return statement[2];
    }
  }
  return undefined;
}

/**
 * Whether a delegation for `parent` also grants `child`. Commands are
 * `/`-separated: `/workspace` grants `/workspace/read`, never `/workspacefoo`,
 * and `/` grants everything.
 */
function commandCovers(parent: string, child: string): boolean {
  return parent === '/' || child === parent || child.startsWith(`${parent}/`);
}

function tokenFromChain(chain: Chain): DelegationToken {
  const leaf = chain[0]!;
  const resource = resourceOf(leaf.pol) ?? '';
  return {
    meta: {
      issuer: leaf.iss.toString() as Did,
      audience: leaf.aud.toString() as Did,
      capabilities: [{ can: leaf.cmd.slice(1), with: resource }],
      ...(leaf.exp !== null && leaf.exp !== undefined ? { expiration: leaf.exp } : {}),
      ...(leaf.nbf !== undefined ? { notBefore: leaf.nbf } : {}),
    },
    _delegation: chain,
  };
}

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

/** Generate a fresh ed25519 keypair principal. */
export async function generatePrincipal(): Promise<Principal> {
  return wrap(await EdDSASigner.generate());
}

/**
 * Derive a principal from a 32-byte ed25519 seed.
 *
 * Same seed as @workspace.sh/p2p-runtime's `didFromSeed` produces the same DID,
 * so a Hypercore peer and its UCAN identity coincide.
 */
export async function principalFromSeed(seed: Uint8Array): Promise<Principal> {
  if (seed.length !== 32) {
    throw new Error(`seed must be 32 bytes, got ${seed.length}`);
  }
  return wrap(await EdDSASigner.generate(seed));
}

/** Convenience: extract the DID from a principal. */
export function didOf(p: Principal): Did {
  return p.did();
}

/**
 * Decode a `did:key:z6Mk…` to its underlying 32-byte ed25519 public key.
 *
 * Inverse of @workspace.sh/p2p-runtime/did.ts's `didFromSeed`. Used by callers
 * who need the recipient's raw public key (e.g. to wrap a symmetric key with
 * the wrap.ts primitive).
 */
export function didToPublicKey(did: Did): Uint8Array {
  return DIDKey.fromString(did).publicKey;
}

// ---------------------------------------------------------------------------
// Issue a delegation
// ---------------------------------------------------------------------------

export interface IssueOptions {
  readonly issuer: Principal;
  readonly audience: Did;
  /** Exactly one: a UCAN 1.0 delegation carries one command. */
  readonly capabilities: readonly CapabilityDescriptor[];
  /** Seconds since epoch, floored. Omit for no expiry. */
  readonly expiration?: number;
  /** Optional not-before time, whole seconds since epoch. */
  readonly notBefore?: number;
  /**
   * The chain this delegation extends, for sub-delegation. The first token's
   * chain is used; its root's subject becomes this delegation's subject.
   */
  readonly proofs?: readonly DelegationToken[];
}

export async function issueDelegation(opts: IssueOptions): Promise<DelegationToken> {
  if (opts.capabilities.length !== 1) {
    throw new Error(`a delegation carries exactly one capability, got ${opts.capabilities.length}`);
  }
  const capability = opts.capabilities[0]!;
  const parent = opts.proofs?.[0] ? chainOf(opts.proofs[0]) : [];
  const root = parent.at(-1);

  const delegation = await Delegation.create({
    iss: signerOf(opts.issuer),
    aud: opts.audience,
    sub: root ? root.sub : opts.issuer.did(),
    cmd: commandFor(capability.can),
    pol: [['==', '.resource', capability.with]],
    nonce: randomNonce(),
    // Null is "no expiry"; left undefined, the library would apply its own.
    exp: opts.expiration === undefined ? null : Math.floor(opts.expiration),
    ...(opts.notBefore === undefined ? {} : { nbf: Math.floor(opts.notBefore) }),
    // Issuing is not validating: a delegation that is already expired can be
    // made, and validateDelegation is what refuses it.
    now: 0,
    // iso-ucan types DIDs and policy selectors as template literals; these
    // values are those shapes at runtime.
  } as unknown as Parameters<typeof Delegation.create>[0]);

  return tokenFromChain([delegation, ...parent]);
}

// ---------------------------------------------------------------------------
// Validate a delegation chain
// ---------------------------------------------------------------------------

export interface ValidateOptions {
  /** The root authority over the capability's resource. */
  readonly rootForResource: RootForResource;
  /** Override "now" in whole seconds since epoch. Defaults to the clock. */
  readonly now?: number;
}

/**
 * Validate a delegation chain for the capability its leaf grants.
 *
 * Every link, the root's included, must:
 *   - carry a valid signature from the key its issuer DID encodes;
 *   - be delegated by the link above it (its issuer is that link's audience);
 *   - share the root's subject;
 *   - have a command that covers the leaf's, at a segment boundary;
 *   - have a policy that admits the leaf's resource;
 *   - be inside its expiry and not-before window.
 * And the root link must be self-issued (issuer is the subject) by the DID
 * `rootForResource` names for the resource.
 */
export async function validateDelegation(
  token: DelegationToken,
  opts: ValidateOptions,
): Promise<ValidationResult> {
  const capability = token.meta.capabilities[0];
  if (!capability) {
    return { ok: false, error: 'delegation has no capabilities' };
  }

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (token.meta.expiration !== undefined && token.meta.expiration <= now) {
    return { ok: false, error: 'delegation expired' };
  }
  if (token.meta.notBefore !== undefined && now < token.meta.notBefore) {
    return { ok: false, error: 'delegation not yet valid' };
  }

  const chain = chainOf(token);
  const root = chain.at(-1)!;
  const subject = root.sub as string | null;
  const rootIssuer = root.iss.toString();

  const expectedRoot = opts.rootForResource(capability.with);
  if (expectedRoot === null) {
    return { ok: false, error: `no root authority is known for ${capability.with}` };
  }
  if (rootIssuer !== expectedRoot || subject !== rootIssuer) {
    return {
      ok: false,
      error: `chain does not terminate at ${expectedRoot} for ${capability.with} (root issuer was ${rootIssuer})`,
    };
  }

  const leafCommand = chain[0]!.cmd;
  for (let i = 0; i < chain.length; i++) {
    const link = chain[i]!;
    const issuer = link.iss.toString();

    try {
      // Re-decoded from its own bytes with the signature checked; `now: 0`
      // leaves expiry to the checks below, which report it by depth.
      await Delegation.from({ bytes: link.bytes, verifierResolver, now: 0 });
    } catch {
      return { ok: false, error: `chain link at depth ${i} is not signed by its issuer ${issuer}` };
    }

    const parent = chain[i + 1];
    if (parent !== undefined && issuer !== parent.aud.toString()) {
      return {
        ok: false,
        error: `chain break at depth ${i}: ${issuer} not delegated by ${parent.aud.toString()}`,
      };
    }
    if ((link.sub as string | null) !== subject) {
      return { ok: false, error: `chain link at depth ${i} names a different subject` };
    }
    if (!commandCovers(link.cmd, leafCommand) || !policyAllows({ resource: capability.with }, link.pol)) {
      return { ok: false, error: `chain link at depth ${i} does not carry the claimed capability` };
    }
    if (link.exp !== null && link.exp !== undefined && link.exp <= now) {
      return { ok: false, error: `chain link at depth ${i} is expired` };
    }
    if (link.nbf !== undefined && now < link.nbf) {
      return { ok: false, error: `chain link at depth ${i} is not yet valid` };
    }
  }

  return {
    ok: true,
    audience: token.meta.audience,
    capability,
  };
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/**
 * Serialise a delegation for transport (e.g. inside a Hypercore block): a
 * DAG-CBOR array of its chain's envelopes, leaf first.
 */
export async function toBytes(token: DelegationToken): Promise<Uint8Array> {
  return dagCbor.encode(chainOf(token).map((d) => d.bytes));
}

/**
 * Restore a delegation from the bytes produced by `toBytes`. Decoding checks
 * shape only; validateDelegation is what checks signatures and times.
 */
export async function fromBytes(bytes: Uint8Array): Promise<DelegationToken> {
  let envelopes: unknown;
  try {
    envelopes = dagCbor.decode(bytes);
  } catch (error) {
    throw new Error(`failed to decode delegation: ${(error as Error).message}`);
  }
  if (!Array.isArray(envelopes) || envelopes.length === 0 || !envelopes.every((e) => e instanceof Uint8Array)) {
    throw new Error('failed to decode delegation: expected a non-empty array of envelopes');
  }
  const chain: Delegation[] = [];
  for (const envelope of envelopes as Uint8Array[]) {
    try {
      chain.push(await Delegation.fromString(base64.encode(envelope), { now: 0 }));
    } catch (error) {
      throw new Error(`failed to decode delegation: ${(error as Error).message}`);
    }
  }
  return tokenFromChain(chain);
}
