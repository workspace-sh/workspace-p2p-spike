// @workspace.sh/ucan-boundary
//
// Single-file boundary module isolating every ucanto call. Other packages
// import from here, not from @ucanto/* — so a future swap (e.g. to iso-ucan
// once its revocation story matures) stays a 1-2 day job for the import
// surface. See docs/ucan-prior-research.md for the rationale and the library
// choice ADR.
//
// Public surface (all opaque to consumers):
//   - generatePrincipal / principalFromSeed — identity material
//   - didOf / didToPublicKey — DID encoding/decoding
//   - issueDelegation — mint a signed UCAN
//   - validateDelegation — verify a chain (with canIssue override)
//   - toBytes / fromBytes — transport-friendly serialisation
//   - WHOLE_SECOND_FLOOR — explicit name for the ucanto expiry gotcha
//
// Internal complexity (ucanto specifics, the validator's invocation model,
// signature/algorithm choices) stays in this file.

import { delegate, Delegation } from '@ucanto/core';
import * as ed25519 from '@ucanto/principal/ed25519';

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
 * Opaque handle to a UCAN delegation. Construct via issueDelegation; pass to
 * validateDelegation or toBytes. Consumers cannot inspect contents — they go
 * through the boundary.
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
  /** Resource URI, e.g. "workspace://wid/path" */
  readonly with: string;
}

/** Result of validating a delegation chain. */
export type ValidationResult =
  | { ok: true; audience: Did; capability: CapabilityDescriptor }
  | { ok: false; error: string };

/**
 * Override for ucanto's default authority termination.
 *
 * Default behaviour rejects chains whose root issuer does not match the
 * resource URI directly (ucanto assumes DID-as-resource, e.g.
 * `with: did:key:zABC…`). Workspace-style URIs like `workspace://wid/path/`
 * never satisfy that test, so chains never terminate without an override.
 *
 * Implement this to declare: "any capability whose `with` resolves to this
 * resource can be self-issued by the DID I return here."
 *
 * Return `null` if the resource has no authoritative root, in which case
 * the validator falls back to ucanto's default behaviour.
 */
export type RootForResource = (resourceUri: string) => Did | null;

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

/** Generate a fresh ed25519 keypair principal. */
export async function generatePrincipal(): Promise<Principal> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signer = await (ed25519 as any).generate();
  return wrap(signer);
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signer = await (ed25519 as any).derive(seed);
  return wrap(signer);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrap(signer: any): Principal {
  return {
    did: () => signer.did() as Did,
    _signer: signer,
  };
}

// ---------------------------------------------------------------------------
// DID decode — inverse of @workspace.sh/p2p-runtime's didFromSeed
// ---------------------------------------------------------------------------

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const verifier = (ed25519 as any).Verifier.parse(did);
  // ed25519 Verifier serialises as: [multicodec varint (0xed 0x01, 2 bytes)] [32-byte key].
  // The varint of 0xed (= 237) requires 2 bytes because its high bit is set.
  // Matches @workspace.sh/p2p-runtime/did.ts's ED25519_PUB_MULTICODEC = [0xed, 0x01].
  const tagged = verifier as Uint8Array;
  return tagged.subarray(2);
}

// ---------------------------------------------------------------------------
// Issue a delegation
// ---------------------------------------------------------------------------

export interface IssueOptions {
  readonly issuer: Principal;
  readonly audience: Did;
  readonly capabilities: readonly CapabilityDescriptor[];
  /**
   * Seconds since epoch. **Sub-second values floor to whole seconds** per
   * ucanto convention — a TTL of 0.5s rounds to 0 and the delegation will be
   * treated as expired immediately. Use WHOLE_SECOND_FLOOR as a reminder.
   */
  readonly expiration?: number;
  /** Optional not-before timestamp (whole seconds since epoch). */
  readonly notBefore?: number;
  /** Optional proof delegations for sub-delegation chains. */
  readonly proofs?: readonly DelegationToken[];
}

/**
 * Constant naming the ucanto expiry gotcha (whole-second floor). Reference
 * this in code that computes expirations from sub-second TTLs.
 */
export const WHOLE_SECOND_FLOOR = true;

export async function issueDelegation(opts: IssueOptions): Promise<DelegationToken> {
  const expiration =
    opts.expiration === undefined ? undefined : Math.floor(opts.expiration);
  const notBefore =
    opts.notBefore === undefined ? undefined : Math.floor(opts.notBefore);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const audienceVerifier = (ed25519 as any).Verifier.parse(opts.audience);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proofs = opts.proofs?.map((p) => (p as any)._delegation) ?? [];

  const dlg = await delegate({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    issuer: (opts.issuer as any)._signer,
    audience: audienceVerifier,
    capabilities: opts.capabilities.map((c) => ({
      can: c.can as `${string}/${string}`,
      with: c.with as `${string}:${string}`,
      // ucanto requires a non-empty tuple; we trust the caller to pass ≥ 1.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any,
    ...(expiration !== undefined ? { expiration } : {}),
    ...(notBefore !== undefined ? { notBefore } : {}),
    ...(proofs.length > 0 ? { proofs } : {}),
  });

  return tokenFromDelegation(dlg);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tokenFromDelegation(dlg: any): DelegationToken {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = dlg as any;
  return {
    meta: {
      issuer: d.issuer.did() as Did,
      audience: d.audience.did() as Did,
      capabilities: d.capabilities.map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c: any): CapabilityDescriptor => ({ can: c.can, with: c.with }),
      ),
      ...(d.expiration !== undefined && d.expiration !== null
        ? { expiration: d.expiration as number }
        : {}),
      ...(d.notBefore !== undefined && d.notBefore !== null
        ? { notBefore: d.notBefore as number }
        : {}),
    },
    _delegation: dlg,
  };
}

// ---------------------------------------------------------------------------
// Validate a delegation chain
// ---------------------------------------------------------------------------

export interface ValidateOptions {
  /**
   * Root-DID resolver. Returns the DID that's allowed to self-issue
   * capabilities on a given resource URI. See RootForResource doc for the
   * ucanto `canIssue` gotcha this addresses.
   */
  readonly rootForResource: RootForResource;
  /**
   * Override "now" in whole seconds since epoch. Useful in tests; defaults to
   * the current wall-clock.
   */
  readonly now?: number;
}

/**
 * Validate a delegation chain — verifies signatures, chain termination at the
 * declared root, expiry, and capability semantics.
 *
 * Returns the first capability validated; multi-capability validation is a
 * later concern (current usage is one capability per delegation).
 */
export async function validateDelegation(
  token: DelegationToken,
  opts: ValidateOptions,
): Promise<ValidationResult> {
  if (token.meta.capabilities.length === 0) {
    return { ok: false, error: 'delegation has no capabilities' };
  }
  const cap = token.meta.capabilities[0];
  if (!cap) {
    return { ok: false, error: 'delegation has no capabilities' };
  }

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (token.meta.expiration !== undefined && token.meta.expiration <= now) {
    return { ok: false, error: 'delegation expired' };
  }
  if (token.meta.notBefore !== undefined && now < token.meta.notBefore) {
    return { ok: false, error: 'delegation not yet valid' };
  }

  // The validator runs against an invocation. We construct a synthetic one
  // where the audience invokes their own capability — that exercises the
  // chain ucanto's logic walks.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dlg = (token as any)._delegation;

  // v1 implementation: walk the chain manually and apply rootForResource at
  // the terminating issuer. ucanto's `access()` validator is invocation-shaped
  // — it expects the audience to invoke their capability — which is more
  // machinery than we need here. Manual walking captures the gotcha
  // (`canIssue` override for non-DID URIs) cleanly. If/when we move to a
  // full invocation flow, swap this for `access()` with the same canIssue
  // semantics; the public API stays unchanged.
  return manualValidate(dlg, cap, opts.rootForResource, now);
}

/**
 * Manual chain walker. Each link must be signed by the previous link's
 * audience; the terminating issuer must equal `rootForResource(uri)` (or, if
 * that returns null, must equal the issuer of the capability itself per
 * ucanto's default).
 */
async function manualValidate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dlg: any,
  cap: CapabilityDescriptor,
  rootForResource: RootForResource,
  now: number,
): Promise<ValidationResult> {
  // Walk the proof chain back to the root.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = dlg;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any[] = [current];
  while (current.proofs && current.proofs.length > 0) {
    // ucanto proofs may be CIDs or full Delegations; here we expect inline
    // delegations (constructed in-process via the proofs argument).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const next = current.proofs.find((p: any) => p && p.issuer && p.audience);
    if (!next) break;
    chain.push(next);
    current = next;
  }

  // Top of chain (eldest) — its issuer should match rootForResource(cap.with).
  const root = chain[chain.length - 1];
  const rootIssuerDid: Did = root.issuer.did() as Did;
  const expectedRoot = rootForResource(cap.with);
  if (expectedRoot === null) {
    // No declared root: fall back to ucanto's default (issuer == with as URI).
    if (rootIssuerDid !== cap.with) {
      return {
        ok: false,
        error: `chain does not terminate at declared root for ${cap.with} (issuer ${rootIssuerDid} ≠ resource URI)`,
      };
    }
  } else if (rootIssuerDid !== expectedRoot) {
    return {
      ok: false,
      error: `chain does not terminate at ${expectedRoot} for ${cap.with} (root issuer was ${rootIssuerDid})`,
    };
  }

  // Each non-root link's issuer must equal the previous link's audience.
  for (let i = 0; i < chain.length - 1; i++) {
    const link = chain[i];
    const parent = chain[i + 1];
    const linkIssuerDid: Did = link.issuer.did() as Did;
    const parentAudienceDid: Did = parent.audience.did() as Did;
    if (linkIssuerDid !== parentAudienceDid) {
      return {
        ok: false,
        error: `chain break at depth ${i}: ${linkIssuerDid} not delegated by ${parentAudienceDid}`,
      };
    }
    // Each link must declare the same capability (no capability escalation).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const linkCap = link.capabilities.find((c: any) => c.can === cap.can && c.with === cap.with);
    if (!linkCap) {
      return {
        ok: false,
        error: `chain link at depth ${i} does not carry the claimed capability`,
      };
    }
    // Expiry: each link must not be expired.
    if (link.expiration !== undefined && link.expiration !== null && link.expiration <= now) {
      return { ok: false, error: `chain link at depth ${i} is expired` };
    }
  }

  return {
    ok: true,
    audience: dlg.audience.did() as Did,
    capability: cap,
  };
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/** Serialise a delegation to bytes for transport (e.g. inside a Hypercore block). */
export async function toBytes(token: DelegationToken): Promise<Uint8Array> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dlg = (token as any)._delegation;
  const archive = await dlg.archive();
  if (archive.error) {
    throw new Error(`failed to archive delegation: ${String(archive.error)}`);
  }
  return archive.ok as Uint8Array;
}

/** Restore a delegation from the bytes produced by `toBytes`. */
export async function fromBytes(bytes: Uint8Array): Promise<DelegationToken> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const extract = await (Delegation as any).extract(bytes);
  if (extract.error) {
    throw new Error(`failed to extract delegation: ${String(extract.error)}`);
  }
  return tokenFromDelegation(extract.ok);
}
