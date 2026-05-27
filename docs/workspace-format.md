# .workspace — File Format (v0, Early Spec)

A `.workspace` is a folder on disk — or an archive of one — that
holds everything a team needs to collaborate: documents, the rules
about who can read what, the keys that enforce those rules, and the
connection details for syncing with other members. From a user's
perspective, the folder *is* the workspace. You can drag it to a USB
stick, AirDrop it, drop it on a NAS, share it however you'd share any
folder.

This document describes what lives inside that folder, how it's
arranged, and how the on-disk shape supports both the in-app
collaboration experience and the portability that lets you take your
data anywhere.

The contained files keep their own format identity (`.md`, `.canvas`,
`.table/`, anything else) and can be opened by any tool that
understands them — when viewed outside a workspace they are just
files. Inside a workspace, they gain field-level permission
enforcement, because the workspace is the primitive container for
that enforcement. **The file format stays clean; the container does
the work.**

**Status:** early. Shape expected to change as implementation
proceeds. This document captures the current direction so format and
app decisions made today don't paint us into a corner.

---

## What a workspace looks like on disk

```
my-org.workspace/                      ← the workspace itself
├── policies/
│   ├── code-of-conduct.md             ← plaintext, anyone in the workspace can read
│   └── parental-leave.md
├── ideas/
│   └── q2-retro.canvas
├── data/
│   ├── customers.table/               ← public-within-workspace by default
│   └── employees.table/               ← per-field permission enforcement
│       ├── schema.json                ← public field declarations + hidden-field IDs
│       ├── rows.ndjson                ← rows; only public fields appear here
│       └── bodies/
└── .workspace/                        ← hidden container metadata + encrypted state
    ├── manifest.json                  ← workspace identity, root DID, topic
    ├── attestation.json               ← root signature over the manifest
    ├── policy.json                    ← workspace's cleanup/rotation policy
    ├── envelopes/                     ← bootstrap envelopes for invited peers
    ├── keys/                          ← this peer's local key state
    └── store/                         ← encrypted Hypercore blocks
```

Everything *above* `.workspace/` is the user-facing working tree:
plaintext files arranged however the user wants. Everything *inside*
`.workspace/` is machine-facing container state — the workspace's
identity, the encrypted log, the keys.

This split mirrors git's working-tree / `.git` separation. You can
edit `code-of-conduct.md` in any text editor; you cannot meaningfully
edit anything inside `.workspace/` by hand.

On macOS and Linux the dot-prefix is enough to hide `.workspace/`
from default file-browser views. On Windows, where the Unix
dot-prefix convention isn't honoured, the writer sets
`FILE_ATTRIBUTE_HIDDEN` on the directory at creation time so
Explorer hides it for non-technical users.

---

## On-disk reality: what's plaintext, what's encrypted

This is the most important design decision in the format. Two rules:

### Rule 1 — Workspace-public content lives in plaintext

Files anyone in the workspace can read (the "public" tier, protected
only by the workspace's `K0_org` key) sit as plaintext at rest in the
working tree. Any tool can open `code-of-conduct.md` in any editor.
This is what makes the folder feel like ordinary files.

### Rule 2 — Tier-gated content lives only in the encrypted store

Files and fields that require additional tier keys (`K1`, `K2`, `K_hr`,
etc.) are **never** written to the working tree as plaintext. They
exist only as encrypted bytes inside `.workspace/store/`. The
Workspace app, for an authorised viewer, decrypts them into memory
when the user opens them — and shows them in the UI — but does not
materialise them to disk.

For per-field encryption in a `.table/`, this means `rows.ndjson` on
disk contains only public fields:

```json
{"id": "r1", "name": "Alice", "team": "Eng"}
{"id": "r2", "name": "Bob",   "team": "Eng"}
```

An unauthorised reader cannot tell whether Alice has a salary or
whether Bob has medical-leave status. The information that *those
fields exist* is in `schema.json`; the information that *this row has
a value for them* is sealed in the store.

For whole-file tiering (e.g. an HR-only document), the file does not
appear in the working tree at all on a non-authorised peer's machine.
The Workspace app shows it in the UI for authorised users, decrypted
into memory only.

### Consequence: the folder is safe to copy by default

Because the on-disk state already only contains what's workspace-public,
copying the folder to a USB stick, AirDrop, NAS, or anywhere else
does not leak tier-gated content. Whatever ends up at the destination
is already the right thing to share. No "export" step needed for
safety.

The trade-off: viewing or editing your own tier-gated content
requires the Workspace app. You cannot `cat rows.ndjson` and see
your own salary; you open the table in Workspace and the app
decrypts the value for the UI. This is the cost of the
copy-paste-safe property, and it's the right trade for a consumer
product where avoiding leaks matters more than terminal convenience.

---

## External edits — watching the working tree

A Workspace folder is meant to behave like Dropbox: open a file in
whichever editor you like, save, and Workspace picks up the change.
The app watches the working tree (everything above `.workspace/`)
and reconciles edits into the workspace's logs as they happen. This
is what makes the "the folder *is* the workspace" promise honest —
your existing tools still work.

That said, Workspace ships its own editors for the formats it
handles natively — markdown, canvas, `.table`. Editing inside the
app gets you presence, comments, permission-aware field rendering,
locator-stable links, and conflict-free collaborative edits.
For the formats Workspace handles natively, the in-app editor is
where you'll want to be — external editing is the safety net that
keeps the folder from being held hostage by the app, not the
primary path.

### What's watched

- Everything above `.workspace/`: markdown, canvas files, table
  folders, plus any user-added files Workspace recognises.
- Excluded: `.workspace/` itself (machine-facing — only the app
  touches it), OS junk (`.DS_Store`, `Thumbs.db`, `desktop.ini`),
  editor sidecar files (`*.swp`, `*~`, `.~lock.*`).
- Unknown file types are recorded as opaque blobs and sync to peers
  byte-for-byte. They get no field-level treatment.

### How

The working tree is watched via the platform's native change-
notification API — FSEvents on macOS, inotify on Linux,
ReadDirectoryChangesW on Windows. Node implementations typically
use chokidar to wrap all three behind one interface; any equivalent
works. Workspace debounces incoming events within a short window
(100–300ms) so a single user-level save lands as a single ingest,
even when the underlying editor emits a flurry of filesystem
events (see "Atomic-save patterns" below).

### Atomic-save patterns

Many editors don't write in place. Vim, Sublime Text, and some
Office apps write to a temp file and rename over the original. To
the watcher this looks like:

```
add      foo.md.tmp
unlink   foo.md
rename   foo.md.tmp → foo.md
```

The debounce window collapses these into one "foo.md changed"
event with the new content. No special-casing per editor required;
the debounce handles it.

### What happens on detection

For each changed file, Workspace:

1. Reads the new content from disk
2. Reconciles against the in-log version using format-specific
   logic
3. Appends a write block to the workspace's data log
4. Broadcasts to connected peers via Hyperswarm

This is the same write path as in-app edits — the only difference
is where the new content comes from (disk vs the app's UI).

### Per-format reconciliation, not raw byte sync

External edits are not blind byte-for-byte writes to the log. Each
format has its own reconciliation logic so external editing doesn't
break locator stability or section IDs:

- **Markdown** — match-by-current-text on headings preserves
  section IDs across edits, even when headings are reordered or
  reworded slightly. See [`uri-scheme.md`](./uri-scheme.md).
- **`.table/`** — `rows.ndjson` is parsed; row-level adds /
  modifies / removes become individual log entries. Per-row
  permission tiers are preserved.
- **`.canvas`** — node-level diff against the in-log graph.
- **Unknown formats** — opaque blob replace.

Cost: editing a tier-gated `.table/` row externally is only
possible if the user is authorised to read it. Otherwise the row
doesn't appear in `rows.ndjson` on their disk and external tools
can't edit what they can't see. This is the design — tier-gated
content exists only as encrypted bytes outside the app.

### Conflict with in-app edits

If the same file is open in Workspace's editor AND edited
externally, the external edit wins by recency (timestamp + log
order). The in-app view reflects the on-disk state after the next
watcher event. If the user has unsaved in-app changes when an
external edit lands, the app prompts: keep in-app, accept external,
or merge — the same pattern VS Code and Obsidian use when a file
changes underneath them.

### Things that can go wrong

- **Case sensitivity** — macOS APFS default is case-insensitive;
  Linux ext4 is case-sensitive. A workspace created on one and
  copied to the other can hit name collisions. Workspace normalises
  to lowercase internally for ID purposes; the on-disk name is
  whatever the user picked.
- **iCloud / OneDrive / Dropbox over a workspace** — these
  services may rewrite files (compression, conflicted-copy
  duplicates, dot-prefix renames). Nesting a workspace inside
  another sync engine works but isn't recommended; the right move
  is to share via the workspace's own protocol.
- **Symlinks** — followed by default; circular symlinks abort the
  affected subtree.
- **Large-file writes mid-watch** — the watcher waits for size to
  stabilise (a couple of consecutive identical-size reads) before
  ingesting, so a 500MB video being copied in isn't ingested as
  four partial copies.

### Status

Designed; implementation pending. Tracked alongside the rest of
the working-tree work in
[#24](https://github.com/workspace-sh/workspace-p2p-spike/issues/24).

---

## Two ways to view a workspace — file or URL

A workspace can be addressed two ways: as a folder on disk, or as a
`workspace://` URL. Same identity, two distribution shapes.

### As a folder on disk

The default. Sits in `~/Documents/`, on a USB stick, in a Dropbox
folder, anywhere. Open in the Workspace app via double-click or drag.

### As a URL — `workspace://`

The URL form encodes everything needed for the Workspace app to find
and join the workspace's swarm. The shape:

```
workspace://v1/<workspace-pubkey>[/<path>][?<query>]
```

For the full URI scheme spec — including path namespaces, sub-resource
addressing, locator alphabets per file format (markdown sections,
canvas nodes, table rows/columns/cells, video timestamps, etc.), and
the parsing rules — see [`uri-scheme.md`](./uri-scheme.md).

This is the **magnet-link analogue**. Tiny URL, leaks no sensitive
metadata, embeddable in any text channel. The content lives in the
swarm; the URL is the entry ticket.

### Two distribution shapes

| Shape | What it carries | When to use |
|---|---|---|
| **Heavy bundle** | Full folder including `.workspace/store/` (encrypted bytes) | Self-contained, offline-capable. USB sticks, AirDrop to a colleague who may not be online, archival snapshots. |
| **Light bundle** (`workspace://` URL or a `.workspace` folder with only manifest + attestation + envelopes) | ~a few KB; recipient's app fetches encrypted content from peers via Hyperswarm | URL-shareable. Embed in chat, QR code, web link. |

Same recipient experience either way: app validates the attestation,
finds the envelope addressed to its DID, decrypts and projects the
working tree. The difference is just whether the encrypted bytes
arrive with the bootstrap or are pulled from the swarm afterwards.

### Where the analogy diverges from magnet links

- Magnet links assume "anyone with the link can read everything."
  Workspaces add an access-control layer: anyone with the bundle can
  *attempt* to join, but envelopes gate what they actually decrypt.
- BitTorrent has no concept of identity or revocation. Workspaces
  have both, via UCAN delegations and the topic-layer revocation
  lever.

---

## Container metadata in `.workspace/`

The hidden subdirectory holds machine-facing state. Each file has a
specific role.

### `manifest.json`

```json
{
  "formatVersion": 1,
  "workspaceId": "wid-abc123",
  "createdAt": 1717200000,
  "rootDid": "did:key:z6Mk…",
  "topicId": "ab83…",
  "logs": {
    "data": "hex-encoded-hypercore-key",
    "keyDelivery": "hex-encoded-hypercore-key"
  }
}
```

The workspace's stable identity. Workspace ID, creation time, root
DID, the Hyperswarm topic, and the Hypercore log addresses that
carry data and key delivery. Read at bootstrap by any peer.

### `attestation.json`

The root DID's signature over `(workspaceId, createdAt,
formatVersion)`. Defeats tampering of the manifest and replay of
stale workspaces. Does **not** defeat fraudulent identity claims —
verifying that a given `did:key:z…` belongs to a legitimate
authority still requires an out-of-band channel. See
[`threat-model.md`](./threat-model.md).

Format mirrors the `SignedAttestation` struct in
`@workspace/p2p-runtime/src/attestation.ts`:

```json
{
  "payload": { "workspaceId": "wid-abc123", "createdAt": 1717200000, "formatVersion": 1 },
  "payloadBytes": "<base64>",
  "signature": "<base64>",
  "rootDid": "did:key:z…"
}
```

### `policy.json`

Workspace-level behavioural policy. Declares what cooperating apps
*should* do on lifecycle events. Signed by root; cached locally;
honoured by well-behaved Workspace clients.

```json
{
  "version": 1,
  "onRevoked": {
    "notify": true,
    "deleteWorkingTree": true,
    "deleteEncryptedStore": true,
    "deleteLocalKeys": true,
    "confirmation": "ask-user"
  },
  "onTierKeyRotated": { "notify": false },
  "onWorkspaceDeleted": { "notify": true, "deleteEverything": true, "confirmation": "ask-user" },
  "audit": {
    "logReads":  false,
    "logWrites": false,
    "scope":     "tier-gated-only",
    "destination": "audit-log",
    "readCapability": "workspace/audit"
  }
}
```

### Action logging — opt-in for compliance use cases

The `audit` block declares whether cooperating clients should append
signed action events (decrypt and/or write) to a dedicated audit
Hypercore. When `logReads` or `logWrites` is true, the Workspace app
appends one signed block per action:

```json
{
  "actor":     "did:key:zBob…",
  "action":    "decrypt",
  "subject":   "employees.table/r1/salary",
  "timestamp": 1717200000,
  "client":    "Workspace/1.2.3",
  "signature": "<base64>"
}
```

`scope` can be `"tier-gated-only"` (log only sensitive content, the
typical compliance posture) or `"everything"` (log all reads, including
workspace-public content — heavyweight, rarely useful).

The audit log itself is gated by `readCapability`: only peers holding
the named capability can read it. This is a UCAN like any other
capability; admins and designated auditors hold it, regular members
do not.

**Honest framing of the audit option:** it is a cooperating-client
hint, not cryptographic enforcement. A modified client can refuse to
log or log false events. See
[`threat-model.md`](./threat-model.md) ("Action-level audit, when
needed") for the contract details and when this evidence is
sufficient.

When `audit.logReads` is enabled, workspaces should disclose this at
join time. Logging member activity is a privacy-relevant policy
choice; members deserve to know.

### Honest framing of the rest of the policy file

This is a **hint to cooperating apps**, not a cryptographic
enforcement mechanism. A modified client can ignore it. A user who
stays offline forever never receives the policy updates. The
encrypted store remains sealed against unauthorised viewers
regardless (cryptographic enforcement carries that load). The policy
file is what makes the 95% of cooperating clients clean up cleanly
on revocation. See [`threat-model.md`](./threat-model.md) for the
full contract.

Replicated state property: the policy file is part of the
workspace's replicated state. Deleting the local copy does not
escape it; the next sync restores it from peers.

### `envelopes/`

Bootstrap envelopes addressed to invited peers. One file per
recipient, named by an encoding of their DID (e.g.
`did_key_z6Mk_etc.json`):

```json
{
  "recipient": "did:key:z6Mk…",
  "resource": "workspace://wid-abc123",
  "ucan": "<base64-encoded delegation>",
  "wrappedKeys": {
    "K0_org": "<base64>",
    "K_employee_edit": "<base64>"
  }
}
```

The envelope is sealed to the recipient's ed25519 public key — only
they can unwrap. Carries: the UCAN that grants their capabilities,
the symmetric keys they need, the resource URI.

Bootstrap envelopes are the **offline first-contact** carrier. For
ongoing key delivery to peers already in the swarm, see "The two
carriers" in [`permissions-model.md`](./permissions-model.md).

### `keys/`

Local key state for this peer specifically. Holds:

- This peer's own ed25519 identity material (or a reference to where
  it lives — OS keystore on most platforms)
- Unwrapped symmetric keys this peer has been authorised for
- Cursor positions for the key delivery log (so we don't re-scan
  history on every restart)

Not part of the shared workspace state — this is per-peer machinery.
Not included in archive form unless the recipient is explicitly
exporting their own state.

### `store/`

The Hypercore corestore. Encrypted append-only blocks for the
workspace's data log and key-delivery log. Opaque to anyone
inspecting the directory by hand. The Workspace app projects
relevant blocks into the working tree (for public-tier content) or
into in-memory views (for tier-gated content).

---

## Permission semantics

A workspace can contain a mix of:

- **Workspace-public content** — readable by any peer holding the
  workspace's base key (`K0_org`). The default for `.md`, `.canvas`,
  and most `.table/` files.
- **Tier-gated content** — encrypted with tier-specific keys (`K1`,
  `K2`, `K_hr`, `K_admin`, etc.) distributed via UCAN delegation.
  Required for sensitive content; opt-in via `x-tier` annotations
  in schemas or via folder-level tiering conventions.

A peer's effective access at any moment is the union of every key
they hold, which is the union of every UCAN delegation chain that
terminates at their DID. The audit trail is the chain itself
([`threat-model.md`](./threat-model.md)).

### File-format-specific semantics

**`.md`, `.canvas`** — flat permission model. Three roles per file:
`read`, `edit`, `admin`. Either workspace-public (one key,
everyone can read) or tier-gated as a whole file (encrypted in the
store, only authorised viewers see it in the working tree).

**`.table/`** — gains field-level tiering when inside a workspace.
Fields without `x-tier` are tier 0 (workspace-public). Fields with
`x-tier: 1, 2, ...` are encrypted in the store. `rows.ndjson` on disk
contains only the tier-0 fields. `schema.json` declares both the
public and the hidden field IDs (see below).

Refer to
[`table-file-format/docs/PERMISSIONS.md`](https://github.com/workspace-sh/table-file-format/blob/develop/docs/PERMISSIONS.md)
(PR #26) for the consumer-side view of `.table`'s tiering.

---

## Hidden schema entries — protecting field names

For fields whose name itself is sensitive (e.g.
`redundancy_consideration_date`, where the existence of the field
reveals something even before any value is read), the format
supports gating the schema entry too.

### Mechanism

`schema.json` declares two arrays:

```json
{
  "fields": [
    { "name": "name",   "type": "string" },
    { "name": "team",   "type": "string" },
    { "name": "salary", "type": "number", "x-tier": 2 }
  ],
  "hiddenFields": [
    { "id": "h_a3b9", "tier": "redundancy" },
    { "id": "h_c4d2", "tier": "redundancy" }
  ]
}
```

The visible `fields` array lists fields whose names are
workspace-public. The `hiddenFields` array lists opaque IDs plus
their tier hints — enough for the Workspace app to know "two
additional fields exist at the `redundancy` tier" but nothing about
*what* those fields are.

For each `hiddenFields[i].id`, a sealed entry in the encrypted store
contains the full schema entry:

```json
{ "id": "h_a3b9", "name": "redundancy_consideration_date", "type": "date" }
```

Authorised viewers (those holding the relevant tier key) fetch these
entries, decrypt them, and merge into a complete in-memory schema.
Per-row values for hidden fields use the same opaque IDs as keys —
encrypted `(rowId, h_a3b9)` blocks in the store.

### What each viewer sees

| Viewer | `schema.json` | `rows.ndjson` |
|---|---|---|
| Non-Workspace tool | `name`, `team`, `salary` + 2 opaque hidden IDs | only public field values per row |
| Workspace member without the `redundancy` key | same as above | same as above |
| Workspace admin with the `redundancy` key | full schema with `redundancy_consideration_date` etc. | merged view with decrypted hidden-field values |

The unauthorised reader knows "two hidden fields exist at the
`redundancy` tier" but nothing else. Existence + count + tier hint
are workspace-public; semantics are sealed. If the *existence* of a
schema field being sensitive matters too (i.e. you don't want anyone
to know there are any hidden fields at all), the `hiddenFields`
array can be omitted entirely and the IDs distributed via the live
key delivery log — more aggressive but possible.

### Where the full schema lives

In two physical places that the app combines in memory:

- `<table>/schema.json` — public entries + hidden-field IDs (markers)
- `.workspace/store/` — encrypted hidden-schema-entry contents, keyed
  by the IDs

The "full schema" exists only as an in-memory object on an authorised
viewer's machine.

### Standalone-table portability

If a `.table/` is taken out of a workspace (moved, exported as a
standalone file for use in a non-Workspace tool), it carries only
its own `schema.json` and `rows.ndjson`. The encrypted blobs in
`.workspace/store/` don't travel — they were workspace-container
state.

On export, the format strips the `hiddenFields` array from the
exported `schema.json` (since the references would be dead anyway).
The standalone table is a clean, self-contained data file of the
tier-0 public content.

---

## Portability — the folder is the unit

There are three distinct operations a user might call "sharing." Each
has clear semantics.

### Default: copy the folder

The user opens Finder (or equivalent), drags the `.workspace/` folder
to a USB stick / AirDrop / NAS / email attachment / cloud storage.
No special export step, no Workspace app needed.

What gets sent:

- Workspace-public content in plaintext (intended — these are public
  anyway)
- `.workspace/manifest.json`, `attestation.json`, `policy.json`
- Tier-gated content as encrypted bytes in `.workspace/store/`
- Bootstrap envelopes addressed to whoever was already invited

What does **not** get sent:

- Tier-gated content in plaintext form (it never existed on disk)
- The recipient's own key state (unless they're moving their own
  copy)

The recipient picks up the folder. With the Workspace app and a
valid identity, the app validates the attestation, finds (or doesn't
find) an envelope for them, projects the working tree according to
their keys. Without the Workspace app, they can browse the public
content with any tool; the rest is opaque.

This is the **default sharing flow**. Safe by construction. The user
does not need to think about what's leaking.

### Share-with — invite-a-recipient

A guided UX flow inside the Workspace app: "share this workspace
with X." Before sending, the user adds a bootstrap envelope for X
sealed to their DID, carrying whichever keys they should hold.
After the envelope exists in `.workspace/envelopes/`, the folder is
shared via any of the default channels above. The recipient is
"pre-onboarded" and can use the workspace immediately.

This is convenience layered on top of the default. The single click
adds an envelope; everything else is regular file sharing.

### Export plaintext — explicit "leave the protection layer"

A separate UX flow: "export this `.table/` as a standalone file,"
or "export the entire workspace as a plain folder." Decrypts
everything the current user is authorised to read and writes it to a
new folder *outside* the `.workspace/` container. No `.workspace/`
metadata, no encrypted store, no envelopes — just the plaintext
content.

The result is a plain folder, suitable for use with non-Workspace
tools forever after. The user explicitly steps outside the
protection layer. Once exported, the content is no longer protected
by the permission model — it's just data on disk, subject to
whatever the user does with it.

### Summary

| Operation | What it produces | UX |
|---|---|---|
| Copy folder | The `.workspace/` folder as-is | File system (default) |
| Share-with | Same + an envelope pre-addressed to recipient | In-app, one click |
| Export plaintext | A plain folder, no permission model | In-app, explicit "leave the container" step |

The folder-as-unit default is the foot-gun-free path. The other two
exist when the user wants them.

---

## What the format is not

- **Not a redefinition of the file formats inside it.** `.md` is still
  `.md`. `.canvas` is still `.canvas`. `.table` is still `.table`.
  The workspace just contains them and adds an enforcement layer.
- **Not the protocol.** The cryptographic mechanics (UCAN, key
  wrapping, Hypercore, Hyperswarm, root attestation) live in
  [`permissions-model.md`](./permissions-model.md). This document
  describes the on-disk shape and the user-facing surface.
- **Not a lock-in.** The working tree is the user's data, always
  readable without a Workspace app. The container adds value when
  Workspace is present; it does not subtract value when Workspace is
  absent.

---

## Open design questions

Explicit so future contributors don't quietly pick defaults:

1. **Hidden-fields visibility.** Current sketch has `hiddenFields` as
   a public array (count + tier hint visible to all workspace
   members). Alternative: omit `hiddenFields` from `schema.json`
   entirely; distribute hidden-field IDs only via the encrypted
   store. More aggressive privacy; harder to reason about
   structurally.
2. **Hidden-field stripping on export.** When a `.table/` is exported
   from a workspace, do we strip `hiddenFields` from the exported
   `schema.json` (clean — current preference) or keep markers as
   "dead references" (honest historical record). Format choice;
   minor UX.
3. **Archive format on light bundles.** When packaging the magnet-
   equivalent (manifest + attestation + envelopes, no store), is it
   a tar, zip, plain folder, single binary file? Affects how it's
   recognised by default OS tooling.
4. **Folder-level whole-file tiering.** `.table` has `x-tier` for
   fields. Should there be an equivalent for whole files (a "tier
   this folder at `K1`" convention)? If so, where does the
   declaration live — in `manifest.json`, in a per-folder dotfile,
   both?
5. ~~**Workspace identity vs root identity.**~~ **Resolved**: 1 workspace = 1 root identity in v1. The workspace's root pubkey IS the workspaceId at the URI layer; no separate identifier. Orgs with multiple workspaces create multiple `.workspace` folders, each with its own root keypair. See [`uri-scheme.md`](./uri-scheme.md) for the URI-side framing of this decision.
6. **Workspace versioning.** `manifest.json` carries a
   `formatVersion`. What changes warrant a version bump? Forward
   compatibility expectations for older readers encountering newer
   workspaces?
7. **Manifest content boundary.** What belongs in `manifest.json` vs
   separate files in `.workspace/`? Tension between "single
   authoritative file" and "separation of concerns."
8. **Forks and copies.** If Alice forks a workspace and modifies it,
   what identifies the fork as related to the original? Trail in
   the manifest, separate `originWorkspaceId`, or no formal
   relationship?
9. **workspace:// URI scheme details.** Concrete encoding,
   authority component (workspaceId? friendly name?), how the
   manifest/attestation are embedded (inline base64, fetched
   separately).

These are not blockers for early implementation; they will be
answered as implementation forces choices.

---

## Relationship to the wider spike

This format is the **container** for everything the permissions model
delivers. The model defines the cryptographic protocol; the format
defines where the bytes sit on disk. Both serve the contract spelled
out in [`threat-model.md`](./threat-model.md).

Implementation work that materially affects this format:

- **`@workspace/p2p-runtime/src/wrap.ts`** — produces the sealed
  bytes that go into `envelopes/` and into per-field encryption.
- **`@workspace/p2p-runtime/src/attestation.ts`** — produces
  `attestation.json` and the `.workspace/policy.json` signature.
- **`@workspace/ucan-boundary`** — issues and validates the UCANs
  inside envelopes.
- **`@workspace/portable-bootstrap`** — creates and consumes
  bundles; handles the bootstrap envelope flow.
- **#9** (key delivery log) — the live-log carrier for ongoing
  envelope delivery between connected peers (vs. the in-bundle
  envelopes for offline first-contact).
- **#10** (topic-layer auth) — gates connection to the workspace's
  swarm; the topic identifier comes from `manifest.json`.

---

## Cross-references

- [`uri-scheme.md`](./uri-scheme.md) — the `workspace://` URI scheme
  in full (path namespaces, sub-resource addressing, locator alphabets,
  parsing rules)
- [`discovery.md`](./discovery.md) — DNS TXT and `.well-known/workspace`
  discovery for orgs with a domain
- [`threat-model.md`](./threat-model.md) — the contract this format
  serves
- [`permissions-model.md`](./permissions-model.md) — the
  cryptographic protocol
- [`risks.md`](./risks.md) — where this could fail and what we're
  doing about it
- [`ucan-prior-research.md`](./ucan-prior-research.md) — UCAN
  library notes
- [`table-file-format/docs/PERMISSIONS.md`](https://github.com/workspace-sh/table-file-format/blob/develop/docs/PERMISSIONS.md)
  (PR #26) — `.table`'s consumer-side permission view
