# ADR 0001 — UCAN library: ucanto, not iso-ucan

**Status:** Accepted · **Date:** 2026-06 · **Tracks:** [#19](https://github.com/workspace-sh/workspace-p2p-spike/issues/19)

## Context

Workspace's permissions model expresses access as UCAN delegation
chains rooted at a workspace's identity. We needed a JS UCAN library to
mint, validate, serialise, and revoke delegations. The decision is
recorded here *after* the fact: [#8](https://github.com/workspace-sh/workspace-p2p-spike/issues/8)
already shipped `@workspace.sh/ucan-boundary` on ucanto, and
[#10](https://github.com/workspace-sh/workspace-p2p-spike/issues/10)
(topic-layer auth) and [#15](https://github.com/workspace-sh/workspace-p2p-spike/issues/15)
(bootstrap envelopes) build on it. This ADR captures the choice and,
more importantly, the triggers for revisiting it.

Full library comparison and gotchas: [`../ucan-prior-research.md`](../ucan-prior-research.md).

## Decision

Use **ucanto** (`@ucanto/core`, `@ucanto/principal`, `@ucanto/validator`)
as the UCAN implementation, confined behind the single-file
**boundary module** `@workspace.sh/ucan-boundary`. Every ucanto call
lives in that one module; the rest of the codebase imports our own
`issueDelegation` / `validateDelegation` / `toBytes` / `fromBytes`
surface, never ucanto directly.

## Why ucanto

- **Maturity + production use.** Runs in production at Storacha /
  web3.storage; mature, maintained, real-world-exercised.
- **A real revocation hook.** Revocation is a first-class concern for
  us; ucanto exposes it. iso-ucan did not export a revocation module at
  evaluation time.
- **Capability *invocation*, not just minting.** ucanto models
  expressing and executing capabilities coherently, which is what the
  boundary module's `validateDelegation` + the `canIssue` override for
  `workspace://` URIs actually lean on.
- **Ran cleanly** on Node 22 with ed25519 `did:key` identities — the
  same keys Hypercore/Corestore already produce.

## Alternatives considered

- **iso-ucan** — tracks the newer UCAN 1.0 spec direction (ucan-wg
  `sub` + `cmd` + `pol` policy predicates). More spec-current, but at
  evaluation time less mature and **without an exported revocation
  module**. The trade is *maturity now* (ucanto) versus *spec alignment
  later* (iso-ucan).
- **`@ipld/dag-ucan`** — a codec, not a full solution; ucanto depends
  on it anyway.
- **The old JWT `ucans`/`ts-ucan` line** — effectively dead; not
  considered.

## Consequences

- **Wire-format interop is one-way.** ucanto's DAG-CBOR dialect
  predates ucan-wg v1.0.0-rc.1, so we cannot interoperate with
  rs-ucan/go-ucan services. Acceptable today (we control both ends);
  it becomes a real cost only if Workspace must integrate a non-ucanto
  UCAN service.
- **A future swap is contained, not free.** The boundary module
  ([#8](https://github.com/workspace-sh/workspace-p2p-spike/issues/8))
  means a library change is a small, single-file change *mechanically*
  — but the real cost is the capability-model rewrite (ucanto's
  `with` + `can` → ucan-wg's `sub` + `cmd` + `pol`). The containment is
  what makes this a one-way door avoided rather than a lock-in.

## Revisit triggers

Reopen this decision on evidence, not vibes, if any of:

1. **UCAN 1.0 spec divergence breaks interop we actually need** — e.g.
   Workspace must talk to an rs-ucan/go-ucan service.
2. **iso-ucan reaches maturity *with a migration story*** — production
   use, a revocation module, and a documented ucanto→iso path.
3. **ucanto's maintenance cadence drops** — unmaintained upstream is a
   single-dependency risk worth acting on.
