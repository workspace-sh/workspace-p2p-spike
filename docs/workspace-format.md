# .workspace — file format (v0, early spec)

**Status:** early. Shape expected to change as
[`permissions-model.md`](./permissions-model.md) implementation work
proceeds. This document captures the current direction so format and
app decisions made today don't paint us into a corner.

---

## one-paragraph summary

A `.workspace` is a folder — or an archive of one — that contains a
collection of files plus the metadata needed to sync them and enforce
access control between peers. The contained files keep their own
format identity (`.md`, `.canvas`, `.table/`, anything else) and can
be opened by any tool that understands them. The container is what
adds the P2P sync layer and the permission model on top.

A `.table` outside a `.workspace` is just a `.table` — portable, open,
no encryption. The same `.table` inside a `.workspace` gains
field-level permission enforcement, because the workspace is the
primitive container for that enforcement. The file format stays
clean; the container does the work.

---

## what a workspace is

```
my-org.workspace/                    ← the workspace (folder or archive thereof)
├── policies/
│   ├── code-of-conduct.md           ← plaintext, anyone in the workspace can read
│   └── parental-leave.md
├── ideas/
│   └── q2-retro.canvas
├── data/
│   ├── customers.table/             ← public-within-workspace by default
│   └── employees.table/             ← field-tier permission enforcement via x-tier
│       ├── schema.json              ← always unencrypted; declares which fields exist
│       ├── rows.ndjson              ← per-field encryption applied by container
│       └── bodies/
└── _workspace/                      ← container metadata (see below)
    ├── manifest.json
    ├── attestation.json
    ├── envelopes/
    ├── keys/
    └── store/                       ← Hypercore corestore
```

The outer folder is the workspace. The `_workspace/` subdirectory at
the root is the container's bookkeeping. Everything else is content
the user arranged.

Archiving the folder (tar / zip / OS-native bundle) produces a
portable snapshot that can be delivered over AirDrop, USB, HTTP,
email, or any other transport — and reconstituted into a live
workspace on the other side.

---

## two layers, separated by responsibility

The workspace has two layers that coexist on disk:

### layer 1 — working tree (human-facing)

The files the user sees. Plaintext. Format-pure (a `.md` is a
real `.md`, openable in any markdown editor). The user can `cat`
them, edit them with any tool, copy them, ignore the workspace
entirely.

For tiered fields the user is not authorised to read, the working
tree shows the field as `<no access>` (decision pending — see open
questions). The field's existence is declared in `schema.json`
regardless; the value is what gets hidden.

### layer 2 — container metadata (machine-facing)

The `_workspace/` subdirectory. Holds:

- **`manifest.json`** — canonical workspace identity: workspace ID,
  format version, creation timestamp, root DID, references to the
  Hypercore log addresses used for sync and key delivery.
- **`attestation.json`** — root attestation signed over `(workspaceId,
  createdAt)` by the root DID. Defeats tampering of the manifest and
  replay of stale workspaces. (Does **not** defeat fraudulent identity
  claims — see [`threat-model.md`](./threat-model.md).)
- **`envelopes/`** — bootstrap envelopes for first-contact recipients
  (`{ucan, wrapped_key, resource}` triples sealed to recipient DIDs).
  Used when the workspace is delivered offline; consumed once and then
  ongoing key delivery rides the live Hypercore log.
- **`keys/`** — local key state: this peer's identity material,
  unwrapped symmetric keys the peer has rights to, key delivery cursor.
- **`store/`** — the Hypercore corestore: encrypted append-only blocks
  for the workspace's data and key-delivery logs.

The analogy that closest is git: working tree at the root is
plaintext; `.git/` is opaque. Both layers exist on disk simultaneously.

---

## permission semantics

A workspace can contain a mix of:

- **Public-within-workspace files** — readable by any peer holding the
  workspace's base key (`K0_org`). The default for `.md`, `.canvas`,
  most `.table/` files.
- **UCAN-gated files / fields** — encrypted with tier-specific keys
  (`K1`, `K2`, …) distributed via UCAN delegation. Required for
  sensitive content; opt-in via `x-tier` declarations in `.table`
  schemas, or via a folder-level convention for whole-file tiering
  (open question, see below).

A peer's effective access at any moment is the union of every key
they hold, which is the union of every UCAN delegation chain that
terminates at their DID. The audit trail is the chain itself
([`threat-model.md`](./threat-model.md)).

### file-format-specific semantics

- **`.md`, `.canvas`** — flat permission model. Three roles per file:
  `read`, `edit`, `admin`. One symmetric key per file (or
  public-within-workspace, no key required).
- **`.table/`** — gains field-level tiering when inside a workspace.
  Fields without `x-tier` are tier 0 (public-within-workspace). Fields
  with `x-tier: 1, 2, ...` are encrypted with the tier's key.
  Per-field encryption applies to `rows.ndjson` only; `schema.json`
  remains unencrypted so every peer knows the table's shape even when
  they cannot read every value.

Refer to
[`table-file-format/docs/PERMISSIONS.md`](https://github.com/workspace-sh/table-file-format/blob/develop/docs/PERMISSIONS.md)
(PR #26) for the consumer-side view of `.table`'s tiering.

---

## portability

Three portability stories the format must serve:

### file out of workspace

Move a `.md` or `.table/` out of a workspace and it's just a file.
Plain markdown, plain table. Any tool that handles the format handles
the file. No encryption, no permission model, no Workspace dependency.

This is the default for `.table`'s portability story: the file format
is clean and self-contained outside the container.

### workspace as snapshot

Tar / zip the entire `my-org.workspace/` directory. The archive
contains everything: the working tree, the manifest, the attestation,
the envelopes, the Hypercore store. Hand it to anyone:

- **With a Workspace app and a valid identity**: unpack, app verifies
  attestation, peer consumes any bootstrap envelope addressed to
  their DID, joins the swarm, picks up ongoing sync.
- **Without a Workspace app**: unpack, browse the working tree, read
  the plaintext files. Lose sync and permission enforcement, keep the
  data they had at the snapshot moment.

The archive form is the unit of distribution. Offline delivery
(AirDrop, USB) is a first-class case, not an afterthought.

### workspace as live state

The unarchived folder, sitting on disk, is the live state. Workspace
watches the working tree, commits user edits into the Hypercore store,
replicates over Hyperswarm, applies remote edits back into the working
tree. The two layers stay in sync.

---

## what the format is not

- **Not a redefinition of the file formats inside it.** `.md` is still
  `.md`. `.canvas` is still `.canvas`. `.table` is still `.table`. The
  workspace just contains them and adds an enforcement layer.
- **Not the protocol.** The cryptographic mechanics (UCAN, wrapping,
  Hypercore, Hyperswarm, root attestation) live in
  [`permissions-model.md`](./permissions-model.md). This document
  describes the on-disk shape; the protocol is what makes it work.
- **Not a lock-in.** The working tree is the user's data, always
  readable without a Workspace app. The container adds value when
  Workspace is present; it does not subtract value when Workspace is
  absent.

---

## open design questions

Explicit so future contributors don't quietly pick defaults:

1. **Bundle layout — visible vs hidden metadata directory.** Current
   sketch uses `_workspace/` (visible-but-prefixed). Alternatives:
   `.workspace-meta/` (hidden, dot-prefixed), `meta/` (visible,
   unprefixed), no subdirectory (metadata files at root). Each has
   trade-offs around discoverability, accidental edit, and
   cross-platform behaviour (Windows hides dot-prefixed inconsistently).
2. **Archive format.** Plain tar? Zip? OS-native bundle (macOS-style
   `.workspace` package)? Plain directory only (let the OS handle
   archiving)? The choice affects how the format is recognised by
   default OS tooling.
3. **Hidden-field representation in the working tree.** For tiered
   fields a user cannot decrypt: show as `<no access>`, omit entirely,
   or surface as a typed null with a sentinel value? Affects what
   third-party tools see when they read `rows.ndjson` directly.
4. **Folder-level whole-file tiering.** `.table` has `x-tier` for
   fields. Should there be an equivalent for whole files (a "tier
   this folder at `K1`" convention)? If so, where does the declaration
   live — in `manifest.json`, in a per-folder dotfile, both?
5. **Export semantics.** When a user exports a single file from a
   workspace: "decrypt and bundle" (file becomes plaintext, leaves the
   permission layer) vs "stays sealed" (file is unusable outside a
   workspace). UX decision; needs to be documented clearly wherever
   it lands.
6. **Workspace identity vs root identity.** Is `workspaceId` always
   equal to the root DID, or a separate identifier issued at workspace
   creation? Implications for multi-workspace orgs, forking, and root
   key rotation.
7. **Workspace versioning.** `manifest.json` must carry a
   `formatVersion`. What changes warrant a version bump? Forward
   compatibility expectations for older readers encountering newer
   workspaces?
8. **Manifest content boundary.** What belongs in `manifest.json` vs
   separate files in `_workspace/`? Tension between "single
   authoritative file" and "separation of concerns."
9. **Forks and copies.** If Alice forks a workspace and modifies it,
   what identifies the fork as related to the original? Trail in the
   manifest, separate `originWorkspaceId`, or no formal relationship?

These are not blockers for early implementation; the wrap primitive
and the bootstrap envelope work can proceed using a sketch shape and
inform the answers.

---

## relationship to the wider spike

This format is the **container** for everything the permissions model
delivers. The model defines the cryptographic protocol; the format
defines where the bytes sit on disk. Both serve the contract spelled
out in [`threat-model.md`](./threat-model.md).

Implementation work that materially affects this format:

- **PR #13** (wrap primitive) — produces the sealed bytes that go into
  `envelopes/`.
- **#8** (ucanto integration) — produces the UCAN tokens that ride
  alongside.
- **#9** (key delivery log) — narrows to the live-log carrier; the
  in-bundle `envelopes/` directory is the offline-bootstrap carrier of
  the same payloads.
- **New issue (to file)** — portable bootstrap manifest + envelope
  bundling logic. Distinct from #9.
- **#10** (topic-layer auth) — gates connection to the workspace's
  swarm; the topic identifier is derived from values declared in
  `manifest.json`.

---

## cross-references

- [`threat-model.md`](./threat-model.md) — the contract this format
  serves
- [`permissions-model.md`](./permissions-model.md) — the cryptographic
  protocol
- [`ucan-prior-research.md`](./ucan-prior-research.md) — UCAN library
  notes
- [`table-file-format/docs/PERMISSIONS.md`](https://github.com/workspace-sh/table-file-format/blob/develop/docs/PERMISSIONS.md)
  (PR #26) — `.table`'s consumer-side permission view
