# ADR 0003 — The store has two forms: RocksDB working copy, serialised transport copy

**Status:** Accepted · **Date:** 2026-08 · **Tracks:** [#32](https://github.com/workspace-sh/workspace-p2p-spike/issues/32), [workspace#249](https://github.com/workspace-sh/workspace/issues/249)

## Context

`workspace-format.md` places the encrypted store inside the folder
(`.workspace/store/`) in five places, and invariant 4 asserts the
metadata layout is append-only and content-addressed, "so there are
none" of the mutable lock/state files that break under cloud sync.

Meanwhile `FINDINGS.md` carried, under *Open questions*: "production
storage path needs to be wired to the app's sandbox container" — the
opposite location. The app implementation followed FINDINGS; the
format doc was never reconciled. Neither document decided anything:
the question was parked, then hardened into behaviour by being
implemented.

Two facts surfaced when the contradiction was finally forced
(workspace#249):

1. **Corestore v7 is RocksDB-backed.** RocksDB was never chosen — it
   arrived transitively when Corestore v6's file-per-core storage
   became v7's RocksDB. An LSM store ships `LOCK`, `CURRENT`,
   `MANIFEST-*`, `OPTIONS-*`, and compaction that rewrites and
   deletes files: precisely what invariant 4 says does not exist.
   The invariant was true of Hypercore the *data structure* and
   false of its storage engine.
2. **With the store outside the folder, a created `.workspace` was an
   8 KB bootstrap stub.** A `cp -R` produced a manifest pointing at
   data the recipient does not have — breaking invariants 1 and 5 and
   every portability claim (USB stick, AirDrop, heavy bundle) the
   format leads with.

The app-side code justified the outside location by citing invariant
4 as a prohibition ("corestore must never live there"). It is not
one; it is a tolerance requirement on what *is* in the folder. The
conclusion happened to be right for the unnamed RocksDB reason.

## Options considered

1. **Store inside the folder as-is; soften invariant 4.** Accept
   RocksDB's files, demote "survives cloud sync" to best-effort.
   Cheapest; quietly retires the portability promise for any
   cloud-synced folder, which is where real users keep folders.
2. **Dual form.** Working store (RocksDB) in app-private storage;
   `.workspace/store/` carries an append-only, content-addressed
   serialisation of the signed blocks, flushed on close/share and
   hydrated on open. Every invariant holds as written.
3. **Replace the storage backend** with something genuinely
   append-only on disk. Largest change; argues with the Holepunch
   ecosystem instead of using it; re-runs the risk the spike existed
   to retire.

## Decision

**Option 2.** A Hypercore log is already a sequence of signed blocks,
so serialising it is the natural operation, not a workaround. The
"unpack on open, operate on the folder" model is one the format
already commits to for archives (invariant 3); this applies the same
shape to the store. The engine stays an implementation detail; the
folder stays the artefact.

The normative description — layout, atomic-write rule, lifecycle,
valid-but-stale copy semantics, per-platform working-store locations —
lives in [`../workspace-format.md`](../workspace-format.md) under
`store/`. This ADR is the why; that doc is the how.

## Consequences

- The portability promises become implementable: flush-then-copy
  yields a self-contained folder, including ciphertext for tiers the
  copier cannot read.
- An explicit flush step exists. Close and share must flush; a crash
  before flush loses nothing from the working store but leaves the
  folder stale until the next flush or sync.
- Hydration must verify blocks offline against the log's public key.
  The exact Hypercore proof API for block-plus-proof export/import is
  an implementation question — timeboxed task in the workspace#249
  plan, with the block-file format versioned (`store/v1/`) so a
  change of proof encoding is a new version, not a breakage.
- The working store is declared a rebuildable cache. Backup guidance
  points at the folder, never at Application Support.
- Append-only means the store only grows. GC/compaction of the
  transport form (and of Hypercore history generally) is explicitly
  out of scope here and joins the existing store-size questions.

## Revisit triggers

- Corestore moves off RocksDB, or gains a portable single-file
  export of its own.
- Autobase multi-writer (#11) multiplies per-peer logs enough that
  one-file-per-block stops being tenable on real filesystems.
- Partial/sparse workspace sync becomes a requirement (huge
  workspaces where hydrating everything on open is unacceptable).
