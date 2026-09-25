# ADR 0001 — UCAN library: ucanto, not iso-ucan

**Status:** Superseded (14 Sep 2026) by UCAN 1.0 through iso-ucan — see below · **Date:** 2026-06 · **Tracks:** [#19](https://github.com/workspace-sh/workspace-p2p-spike/issues/19)

## Superseded: UCAN 1.0 through iso-ucan

The monorepo's `@workspace.sh/ucan-boundary` issues and validates UCAN 1.0
delegations with `iso-ucan` (workspace-sh/workspace#462), behind the same
surface this ADR set up.

- **Why now.** UCAN 1.0 (spec, delegation, invocation) is final as of July
  2026; ucanto still targets 0.9.1 with no activity on its upgrade issue
  (storacha/ucanto#345); `iso-ucan` implements the 1.0 shape and is maintained.
  Evidence: [`../permissions-prior-art.md`](../permissions-prior-art.md) §4–5.
- **Mapping.** A capability `{ can, with }` is `sub`: the workspace root DID,
  `cmd: /<can>`, `pol: [["==", ".resource", with]]`. The `canIssue` override
  this ADR describes is not needed: a 1.0 root delegation is self-issued by its
  subject.
- **Checked before adopting:** forged-signature delegations and invocations
  refused, genuine ones accepted, another device's proof refused, expired proofs
  refused, and our ed25519 seeds give the same `did:key`. One gap: iso-ucan 0.5
  matches commands with a bare `startsWith`, so the boundary module checks the
  segment boundary itself.
- **Still open:** revocation (1.0.0-rc.1) is not in iso-ucan; Workspace
  implements it (workspace-sh/workspace#433). The mobile Bare worklet needs
  hashing and nonces from sodium (done in the boundary module) and may need a
  `TextEncoder` shim (unverified).

The ucanto decision below is kept as the record of why it was chosen then.

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
