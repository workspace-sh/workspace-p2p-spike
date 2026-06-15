# ADR 0002 — Multi-writer merge: per-format LWW over Autobase

**Status:** Accepted (design; implementation tracked in [#11](https://github.com/workspace-sh/workspace-p2p-spike/issues/11) / [#12](https://github.com/workspace-sh/workspace-p2p-spike/issues/12)) · **Date:** 2026-06

## Context

A workspace is edited by multiple peers, often offline, then synced.
We need deterministic convergence: every replica that has seen the same
ops must compute the same state, with no coordinator.

**Autobase already solves the harder half.** It gives a causal
linearisation of multi-writer operations — by the time the `apply`
function sees an op, ordering is settled. So the merge question is
narrower than "how do we merge": two writers editing *different*
entities never conflict, and two writers editing the *same* entity in
causal order never conflict. The only open case is **concurrent
conflicting ops on the same entity** after linearisation.

## Decision

1. **Per-entity Last-Writer-Wins, where "entity" is format-defined.**
   A single global strategy is wrong because "the same logical thing"
   differs per format:

   | Format | Entity (LWW unit) | Notes |
   |---|---|---|
   | Markdown | **block** (heading/paragraph) | Concurrent edits to *different* blocks both survive; only same-block collisions lose. Whole-file LWW would silently drop a writer's edits — unacceptable for the primary format. |
   | `.table` | **row** (by primary key), per-**column** | Matches how users think about rows; column-level merge (different columns of the same row both apply) is a cheap upgrade since column writes are discrete ops. |
   | JSON Canvas | **node, per-property** (`x`/`y`/`text`/…) | Concurrent moves of different nodes never conflict by construction; canvas ops are naturally property-granular. |
   | Binary asset | **file**, losers kept as conflict copies | Whole-file LWW, but keep the losing version (Dropbox `conflicted copy` convention) rather than discarding. |

2. **Deterministic tie-break: timestamp, then writer public key.**
   Identical timestamps resolve by writer pubkey. The tie-break must be
   a pure function of the ops so every replica converges with no
   coordination.

3. **Structure the merge layer as per-format hooks over Autobase's
   `apply`** — a dispatch table from format → merge function, not a
   monolith. *This is the load-bearing decision.* It makes the LWW
   choice reversible per format: a text CRDT can be slotted in for
   markdown later without touching `.table` or canvas merging.

4. **Defer the text CRDT.** A full CRDT (Yjs/Automerge) loses no edits
   but imports a second source-of-truth data structure and its
   machinery. Hold off until real concurrent-edit telemetry justifies
   it; per-block LWW plus conflict surfacing may be all that's ever
   needed for mostly-sequential, few-device editing.

## Consequences

- Same-block (markdown) / same-property (canvas) / same-column
  (`.table`) concurrent edits can lose one side's change — surfaced to
  the user, not silently dropped where feasible (binary keeps conflict
  copies).
- The per-format hook table is the extension point; adding a format =
  adding a merge function, not touching the others.
- The op vocabulary that the canvas/table layers emit becomes the
  granularity the merge hooks operate on — so those op designs and this
  ADR constrain each other (cf. jsoncanvas explicit-operation work).

## Lighthouses do not change merge semantics

An always-on peer (a Lighthouse) makes causal ordering observable
*sooner* — a device syncing through one sees others' ops earlier, so
fewer edits are concurrent in the first place. But it does not change
merge *semantics*, and the strategy must not assume any always-on peer
exists: two laptops that sync directly after a week offline must
converge to the same result as if a Lighthouse had been present
throughout.

## Revisit triggers

- Concurrent same-entity edits turn out common in telemetry → promote
  markdown from per-block LWW to a text CRDT (the hook makes this local).
- A format needs richer merge than LWW (e.g. ordered lists with move
  semantics) → add a bespoke hook for it.
