# ADR 0004 — UCAN 1.0 through iso-ucan (supersedes 0001)

**Status:** Accepted · **Date:** 2026-09 · **Supersedes:** [0001](./0001-ucan-library.md) ·
**Implemented:** [workspace#462](https://github.com/workspace-sh/workspace/pull/462)

## Context

[0001](./0001-ucan-library.md) chose ucanto (UCAN 0.9.1) for maturity and
its revocation hook, and named the triggers for revisiting. By September
2026 UCAN 1.0 was final (spec, delegation and invocation, 8 Jul 2026), ucanto
still targeted 0.9.1 with its 1.0 upgrade issue open since March 2024
([storacha/ucanto#345](https://github.com/storacha/ucanto/issues/345)), and the
capability model this project wants — commands and policies over a
workspace's own resources — is 1.0's, not 0.9's
([`permissions-prior-art.md`](../permissions-prior-art.md)). Waiting only
made the capability-model rewrite, the real cost of a swap, more expensive.

## Decision

`@workspace.sh/ucan-boundary` issues and validates **UCAN 1.0 delegations
through `iso-ucan`**, behind the same boundary module and the same surface
(`issueDelegation`, `validateDelegation`, `toBytes`, `fromBytes`). No other
package imports a UCAN library.

A capability given to the boundary as `{ can, with }` becomes:

| Field | Value |
|---|---|
| `cmd` | `/${can}`, e.g. `/workspace/read` |
| `sub` | the workspace root's DID, the authority every chain ends at |
| `pol` | `[["==", ".resource", with]]`, the resource as 1.0 asks external resources be expressed |

Validation, per link including the root's: a signature from the issuer's key;
delegated by the link above; the root's subject; a command covering the
leaf's **at a segment boundary** (ours: iso-ucan 0.5 matches with a bare
`startsWith`, so `/workspace` would prove `/workspacefoo`); a policy admitting
the resource; a current validity window. The root link is self-issued by
the DID the resource names, which 1.0 makes native (`iss == sub`) where
ucanto needed a `canIssue` override.

On the wire a chain is a DAG-CBOR array of envelopes, leaf first. A
delegation issued without an expiration has none; iso-ucan would otherwise
default to five minutes. Hashing and randomness go through sodium, since the
mobile Bare worklet has no `crypto` global.

## Consequences

- **Revocation is ours.** iso-ucan still exports no revocation module. A
  revocation is a root-signed `workspace/revocation@1` block on the key
  delivery log, naming a device, enforced at every member's connection gate
  once it has replicated there. It is not yet the 1.0 revocation shape
  (the revoked delegation's CID plus a path witness), and needs to become
  that before revoking a delegation can cascade down the chains built on it.
- **What is granted is still one thing.** Every grant today is
  `/workspace/read` on the workspace, issued directly by the root: chains
  work in the boundary and are tested through bytes, but nothing issues a
  sub-delegation, and no finer command (`/document/edit`, per-folder
  policy) is issued or checked yet.
- **Tokens from 0.9 no longer decode.** Workspaces created before #462 were
  recreated. Pre-alpha, so this cost nothing.
- **This repository's own `packages/ucan-boundary` is the earlier ucanto
  prototype.** The SDK of record is the monorepo's `packages/`; describe it,
  not the prototype.

## Revisit triggers

1. iso-ucan's maintenance stops, or a 1.0 library with revocation becomes
   the clear default.
2. Interop with a non-JS UCAN 1.0 implementation is needed and the wire
   format disagrees.
