# workspace:// URI Scheme — v1

The URI scheme for addressing a workspace, a document within it, or a
sub-resource within a document. The URL form of a `.workspace`.

See [`workspace-format.md`](./workspace-format.md) for the on-disk
container format that these URIs address. The URI scheme and the
container format are designed together — the URI carries enough to
bootstrap a workspace from any peer; the container holds the bytes.

---

## Quick reference

```
workspace://v1/<workspace-pubkey>                                            ← workspace root
workspace://v1/<workspace-pubkey>?relays=<r1>,<r2>,…                         ← + relay hints
workspace://v1/<workspace-pubkey>/document/<doc-id>                          ← a document
workspace://v1/<workspace-pubkey>/document/<doc-id>/<locator>                ← sub-resource within
workspace://v1/<workspace-pubkey>/document/<doc-id>/comment/<comment-id>     ← comment on the document
workspace://v1/<workspace-pubkey>/document/<doc-id>/<locator>/comment/<id>   ← comment on a sub-resource
workspace://v1/<workspace-pubkey>/invite/<recipient-did>                     ← invite link
workspace://v1/<workspace-pubkey>/user/<user-did>                            ← user reference
workspace://v1/<workspace-pubkey>/team/<team-id>                             ← team (reserved, v1.x)
```

---

## URI shape

```
workspace://v1/<workspace-pubkey>[/<path>][?<query>][#<fragment>]
```

- `workspace://` — the scheme
- `v1` — the URI scheme version, in the path
- `<workspace-pubkey>` — the workspace's root identity, multibase-encoded
- `<path>` — optional path components for sub-addressing (documents, sub-resources, comments, etc.)
- `<query>` — optional non-routing metadata (relay hints, friendly hints, etc.)
- `<fragment>` — optional client-local view state (scroll position, expansion state, etc.); never used for routing

Routing breaks into two layers:

- **Routing-critical** — the workspace pubkey and the document ID. These resolve to a specific document and must succeed. If they fail, the URI is broken.
- **Best-effort refinement** — the sub-resource locator (the path segment after `document/<id>`). If a locator doesn't match anything in the current document (heading renamed, row deleted, node removed), the app **soft-fails to the document root**. The user lands in the correct document, just not scrolled to the anchor. Same behaviour as Notion / Google Docs section links.

Query strings carry only optional hints. Fragments carry only client-local view state. This isolates routing from the parts of a URL that some chat apps mangle when generating previews.

---

## The version prefix — `v1`

Always present, always in the path. Mandatory.

Versioning rules:

- **Backward-compatible additions** (new optional query parameters, new locator formats per file type) → stay at `v1`. Older parsers ignore unknown fields gracefully.
- **Breaking changes** (different encoding, different field semantics, new reserved keywords at existing path positions) → bump to `v2`. `v1` parsers must reject `v2` URIs explicitly: "this URI version is not supported, please upgrade."

The version is in the path (not the scheme, not a query string) so it survives URL-mangling intermediaries and is the first thing parsers see.

---

## The workspace identifier — multibase pubkey

The workspace's root DID, encoded in multibase form (the `z6Mk…` shape used by `did:key`):

```
z6MkpKpf2nFiC5h9qDPgJrkBbYBaThkAEcVCgGuBHkXqK4Vc
```

The decoded bytes are:

```
[multicodec varint for ed25519-pub (0xed 0x01)] [32-byte ed25519 public key]
```

The `z` prefix is the multibase code for base58btc. The leading bytes after decoding are the multicodec code for the key algorithm. This makes the encoding **algorithm-agile**: swapping ed25519 for a different curve later just changes the multicodec prefix; existing URIs still decode correctly under their declared algorithm.

This identity serves three purposes simultaneously:

1. The workspace's unique identifier (no separate `workspaceId` needed at the URI layer)
2. The Hyperswarm topic identifier (derived deterministically from the pubkey)
3. The signature verifier for the workspace's root attestation (the `attestation.json` file)

One key, three roles.

---

## Path namespaces

At the workspace level (immediately after `<workspace-pubkey>`):

| Namespace | Purpose | ID shape | Status |
|---|---|---|---|
| `/document/<id>` | universal container for any primary content resource (markdown, canvas, table, folder, PDF, video, etc.) | UUIDv4 in base58btc | v1 |
| `/invite/<did>` | invite addressed to a specific recipient | full DID in multibase form | v1 |
| `/user/<did>` | reference to a user within this workspace | full DID in multibase form | v1 |
| `/team/<id>` | reference to a team / tier | UUIDv4 in base58btc | v1.x (reserved) |

Within a document (immediately after `/document/<id>`):

| Position | Form | Meaning |
|---|---|---|
| reserved keyword `comment` | `/document/<id>/comment/<commentId>` | comment on the document |
| anything else | `/document/<id>/<locator>` | format-defined sub-resource locator |
| both | `/document/<id>/<locator>/comment/<commentId>` | comment on a sub-resource |

### Parsing rule

For the path segment immediately after `/document/<id>`:

1. If the segment matches a **reserved keyword** defined by this version of the URI scheme spec, treat it as that namespace
2. Otherwise, treat it as a **format-defined locator**

v1 reserved keywords at this position: `comment`.

New reserved keywords require a URI version bump (`v2`). v1 parsers seeing a v2 URI fail explicitly rather than silently misroute.

### Why `document` and what's not a document

`document` is the namespace for **content resources** — files of any kind. Markdown, canvas, tables, folders, PDFs, videos, audio, code, slide decks, mind maps, whiteboards, images. The intuition: anything a user creates, edits, or addresses as a unit of content.

Non-content addressable things have their own top-level namespaces:

- People → `/user/<did>`
- Teams / tiers → `/team/<id>`
- Invites → `/invite/<did>`

If future versions need to address things that aren't documents and aren't people/teams (live data streams, automation tasks, etc.), they get their own top-level namespaces. The split is "things that are content (any file)" vs "things that are subjects (users, teams, processes)."

---

## Sub-resource locators

The path segment after `/document/<id>` (when not a reserved keyword) is a **format-defined locator**. The URI scheme doesn't specify what locators look like — that's defined by each file format's spec.

Three locator patterns are common:

- **Structural** — addresses tied to the document's intrinsic structure (line numbers, pages, timestamps, coordinates, spreadsheet cells). Non-leaky because the structure is exposed when the document is opened anyway.
- **Native opaque IDs** — formats that already carry IDs in their spec (JSON Canvas nodes, `.table/` rows, hidden columns) use those directly. Opaque by format design.
- **Opaque IDs in workspace state** — formats that have no native ID slots (markdown is the canonical case) get IDs assigned at creation; the mapping `(docId, sectionId) → heading text` lives in the workspace's Hyperbee index.

The URI scheme is **format-agnostic**. Each format spec defines:

- Its locator alphabet (what strings are valid locators)
- Whether locators are positional/structural (no storage needed) or opaque (stored where the format allows)
- For opaque locators: where the ID mapping lives — in-file (where the format has ID slots) or workspace Hyperbee (where it doesn't)

### One constraint: locators are a single path segment

A locator occupies one path segment (between `/` separators). If a format wants nested addressing, it encodes the nesting inside a single segment using its own conventions — e.g. `slide12-elementX`, `9MnPp-h_a3b9` (cell as row-column), `p5-200,400` (page+position).

The URI scheme never spans a locator across multiple path segments. Keeps parsing simple and the reserved-keyword check unambiguous.

---

## Locator alphabets for v1 formats

### Markdown

Markdown headings have no native ID slot in the format. Workspace assigns opaque section IDs at heading-creation time and stores them in the workspace Hyperbee:

```
section index for docId 4Hp8…:
  (4Hp8…, 8Lx2NpQrTy)    → {heading: "Purpose",            position: 12 }
  (4Hp8…, 9MnPpQrStUv)    → {heading: "Reporting Process",  position: 142}
  (4Hp8…, AbCdEfGhJk)    → {heading: "Enforcement",         position: 284}
```

URI:

```
workspace://v1/z6Mk…/document/4Hp8…/9MnPpQrStUv
```

The locator is the opaque section ID. Resolution: app queries the workspace Hyperbee for the section index, looks up the ID, gets the current heading text, finds it in the document, scrolls to it.

The markdown file itself stays standard — no annotations, no frontmatter section block, no inline anchors. Section IDs live entirely in workspace state.

External edits handled by **match-by-current-text**: when a markdown file is edited outside Workspace, the file watcher reads the new content, matches each heading text to the workspace's section index, preserves IDs where text matches, generates new IDs for new headings, marks stale entries for deleted/renamed headings. Stale IDs in URLs soft-fail to document root.

### JSON Canvas

Nodes carry `id` properties per the JSON Canvas spec — already opaque by format design. Positions are bare coordinates. Regions are coordinate pairs.

```
workspace://v1/z6Mk…/document/4Hp8…/node-9MnPpQrStUv     ← specific node
workspace://v1/z6Mk…/document/4Hp8…/420,720              ← position (x,y)
workspace://v1/z6Mk…/document/4Hp8…/100,200-400,300      ← region (top-left to bottom-right)
```

The `node-` prefix disambiguates from coordinates (which contain commas). Regions are two coordinate pairs joined by `-`, matching how other ranges work (`L42-L60`, `p5-p7`, `2:34-3:00`).

### Tables (.table/)

Rows have stable primary keys (their `id` field in `rows.ndjson`). Columns have stable opaque IDs in `schema.json` (workspace-public for tier-0; in `hiddenFields` for tier-gated). Cells are composites.

```
workspace://v1/z6Mk…/document/4Hp8…/9MnPpQrStUv           ← row
workspace://v1/z6Mk…/document/4Hp8…/column-h_a3b9         ← column
workspace://v1/z6Mk…/document/4Hp8…/9MnPpQrStUv-h_a3b9    ← cell (row × column)
```

The `column-` prefix disambiguates from rows (both use opaque base58btc IDs without the prefix). Cell is composite via `-` separator.

`.table/` uses stable IDs rather than positional addressing because the format is built around primary keys; row/column reordering is expected to preserve URLs.

### CSV — A1 notation

CSV is positional by nature (no schema, no row IDs, no column IDs). Use the universally-understood A1 convention from Excel/Lotus 1-2-3:

```
workspace://v1/z6Mk…/document/4Hp8…/B5         ← cell at column B, row 5
workspace://v1/z6Mk…/document/4Hp8…/A1-B10     ← cell range
workspace://v1/z6Mk…/document/4Hp8…/5          ← entire row 5
workspace://v1/z6Mk…/document/4Hp8…/B          ← entire column B
```

Column letters: A, B, C…Z, AA, AB…ZZ, AAA…AAZ, etc. Row numbers: 1-indexed.

Locators are positional — they shift if rows or columns are reordered. That's a CSV-format property, not a URI scheme issue. For formats that need stable cross-edit addressing (like `.table/`), use the ID-bearing format instead.

### PDF

PDFs are structural at the page level and section-addressable at the heading level. Pages are intrinsic; sections use the same Hyperbee-stored opaque IDs as markdown:

```
workspace://v1/z6Mk…/document/4Hp8…/p5                    ← page 5
workspace://v1/z6Mk…/document/4Hp8…/p5-200,400            ← page 5, position (x,y)
workspace://v1/z6Mk…/document/4Hp8…/p5-p7                 ← page range
workspace://v1/z6Mk…/document/4Hp8…/9MnPpQrStUv           ← section (Hyperbee-indexed)
```

The `p` prefix is the page namespace within the locator alphabet. Section IDs use the same opaque-ID-in-Hyperbee mechanism as markdown.

### Time-series media (video, audio)

Timestamps are structural — they're intrinsic to the media. `mm:ss` for shorter content, `hh:mm:ss` for longer. Ranges with `-`:

```
workspace://v1/z6Mk…/document/4Hp8…/2:34          ← timestamp
workspace://v1/z6Mk…/document/4Hp8…/2:34-3:00     ← time range
workspace://v1/z6Mk…/document/4Hp8…/1:23:45       ← long-form timestamp
```

These match the user-facing convention from YouTube, Vimeo, podcast players. Dash-separated ranges for internal consistency with other ranges in our scheme.

### Code files

Line-based addressing, matching the GitHub convention:

```
workspace://v1/z6Mk…/document/4Hp8…/L42           ← line 42
workspace://v1/z6Mk…/document/4Hp8…/L42-L60       ← line range
workspace://v1/z6Mk…/document/4Hp8…/L42:8         ← line 42, column 8
```

Structural — lines are intrinsic to the file.

---

## Query string conventions

Reserved query parameters (all optional, never required for routing):

| Parameter | Meaning | Format | Notes |
|---|---|---|---|
| `relays` | bootstrap relay hints | comma-separated hostnames or URLs | `?relays=public.workspace.sh,relay.acme.internal` |
| `hint` | friendly workspace-name hint for chat-app previews | a string | cosmetic only; app reconciles against the manifest at open time |
| `at` (reserved) | "open at this version/time" | timestamp | reserved for future time-travel UX |

All are optional. URIs with no query string work the same. Parsers that don't recognise a parameter ignore it.

Query strings can be mangled by some chat-app intermediaries when generating link previews — never rely on them for anything routing-critical. Path components are always preserved; query components sometimes aren't.

---

## Fragment conventions

The fragment (`#…`) is for **client-local view state only** — scroll position, view mode, expansion state, anchor highlighting. Apps degrade gracefully when fragments are stripped.

```
workspace://v1/z6Mk…/document/4Hp8…#scroll=500&view=outline
```

Fragments must never be used for routing. Some chat-app previewers strip fragments when generating preview cards; the URL still resolves correctly (the resource opens) but the client-local state may be lost.

### Canonical URIs are fragment-free

A conforming client **MUST NOT** auto-generate fragments in URIs produced by a "share this" / "copy link" action. Canonical URIs as emitted by the workspace app carry no fragment.

### Visible / human-readable slugs — fragment-only, never path or query

If a client (Workspace's or a third party's) ever offers a UX feature that adds a human-readable hint to a shared URI for at-a-glance preview — e.g. so a chat-app preview shows the reader "this points to the *Reporting Process* section" — that hint **MUST** ride in the fragment, never in the path or query.

```
workspace://v1/z6Mk…/document/4Hp8…/9MnPpQrStUv#hint=reporting-process
```

Reasoning:

- Path placement would leak the semantic content through every URL-bearing channel (history, logs, screenshots) — defeating the whole reason locators are opaque IDs in the first place.
- Query placement carries the same leak; query strings are sometimes mangled but they still travel in most contexts.
- Fragment placement keeps the hint client-local. Routing intermediaries strip or ignore fragments; preview generators that present the URL pre-strip the fragment; the URL's authoritative form (what gets indexed, what's stored in browser history at the server-visible level) doesn't carry it.

The hint is also a **snapshot-at-share-time**: it reflects what the heading was called when the URL was generated. If the heading is later renamed, the hint goes stale. That's harmless — the URL still routes correctly via the opaque ID in the path; the stale hint is just a cosmetic mismatch.

Workspaces with strict privacy posture should use the `policy.json` workspace policy (see [`workspace-format.md`](./workspace-format.md)) to declare `stripFragmentsOnShare: true`, telling cooperating clients to strip any user-added fragments before producing a share link.

---

## Resolution flow

When an app opens a `workspace://` URI:

1. **Parse the URI** — extract the workspace pubkey from the path; parse the version; identify the resource type from the next path segment
2. **Derive the Hyperswarm topic** — SHA-256 of the pubkey bytes
3. **Discover peers** — join the Hyperswarm topic via DHT; in parallel, try any `relays` query hints for faster cold-start
4. **Fetch the workspace bootstrap** — `manifest.json` + `attestation.json` from any peer (~2 KB)
5. **Verify the attestation** — the signature verifies against the URI's pubkey; reject if not
6. **Cache the workspace's data Hypercore + Hyperbee** — local store grows as the user queries
7. **Resolve the path component**:
   - `/document/<id>` — Hyperbee lookup on document ID → returns metadata (type, path, tier requirements)
   - `/document/<id>/<locator>` — open the document; resolve the locator via the document's format-specific mechanism (Hyperbee for markdown sections, in-file for canvas nodes, etc.). On miss: soft-fail to document root.
   - `/document/<id>/comment/<id>` — Hyperbee lookup on comment ID
   - `/invite/<did>` — read the envelope file at `_workspace/envelopes/<encoded-did>.json`
   - `/user/<did>` — Hyperbee lookup on user DID
   - `/team/<id>` — Hyperbee lookup on team ID
8. **Apply tier-key gating** — if the resolved resource is tier-gated and the user doesn't hold the required tier key, surface "you don't have access"
9. **Render** — open the resource in the appropriate UI

---

## Storage and lookup — how the IDs resolve

| Identifier in URI | Where it resolves | Lookup |
|---|---|---|
| Workspace pubkey | `_workspace/manifest.json` (verified by attestation) | O(1), read once at bootstrap |
| Document ID | Hyperbee index inside the workspace's data Hypercore store | O(log n), sparse-fetched |
| Sub-resource locator (markdown sections, PDF sections) | Hyperbee index keyed by `(docId, sectionId)` inside the workspace's data Hypercore store | O(log n), sparse-fetched |
| Sub-resource locator (canvas nodes, .table rows/columns) | inside the document file itself (format-native) | O(1) within the open document |
| Sub-resource locator (positional: CSV cells, PDF pages, video timestamps, code lines) | structural — no storage; resolved by the format's intrinsic addressing | O(1) within the open document |
| Comment ID | Hyperbee | O(log n) |
| Team ID | Hyperbee | O(log n) |
| User DID | Hyperbee | O(log n) |
| Envelope (invite recipient DID) | `_workspace/envelopes/<encoded-did>.json` — one file per recipient | O(1) file read |

No giant index files at the workspace level. The Hypercore data log itself is structurally an event stream; Hyperbee sits on top as a B-tree projection for fast keyed lookups. Sparse-loadable — peers fetch only blocks they actually query. Cold-start cost is bounded (~4 KB) regardless of workspace size.

Sub-resource IDs that need workspace-level tracking (markdown sections, PDF sections) live in Hyperbee just like documents and comments. Sub-resource IDs that the format already carries (canvas nodes, table rows/columns) stay in-file. Sub-resource addresses that are structural (CSV cells, pages, timestamps, lines) need no storage.

---

## Examples — end-to-end

### Bootstrap

```
workspace://v1/z6MkpKpf2nFiC5h9qDPgJrkBbYBaThkAEcVCgGuBHkXqK4Vc
```

Opens the workspace at its root view.

### Bootstrap with relays

```
workspace://v1/z6MkpKpf2nFiC5h9qDPgJrkBbYBaThkAEcVCgGuBHkXqK4Vc?relays=public.workspace.sh,relay.acme.internal
```

Same, with hints for two relays the receiving app may use to accelerate cold-start.

### Invite

```
workspace://v1/z6MkpKpf2nFiC5h9qDPgJrkBbYBaThkAEcVCgGuBHkXqK4Vc/invite/z6MkBobX5tYpQrStUvWxYzAaBbCcDdEeFfGgHhJjKkLm
```

Bob (the recipient) sees this URL. His Workspace app:
- Joins the workspace's swarm
- Finds the envelope sealed to his DID in `_workspace/envelopes/`
- Validates the UCAN inside, unwraps the symmetric keys, joins as a member

Forwarding the URL to someone else is harmless — the envelope is sealed to Bob's pubkey; nobody else can unwrap it.

### Document

```
workspace://v1/z6MkpKpf…/document/4Hp8KqRtFmYxNbCvDgHpKr
```

Opens whatever resource (markdown / canvas / table / folder / PDF / video / …) has ID `4Hp8…` in this workspace.

### Markdown section

```
workspace://v1/z6MkpKpf…/document/4Hp8KqRtFmYxNbCvDgHpKr/9MnPpQrStUv
```

Opens the markdown document. App queries Hyperbee for the section index, looks up `9MnPp…`, gets the current heading text, scrolls to it. If the section ID isn't found (heading was renamed or removed), soft-fails to document root.

### Canvas node

```
workspace://v1/z6MkpKpf…/document/4Hp8KqRtFmYxNbCvDgHpKr/node-9MnPpQrStUv
```

Opens the canvas, navigates to the node with ID `9MnPp…` (from the JSON's `id` property).

### Canvas position / region

```
workspace://v1/z6MkpKpf…/document/4Hp8KqRtFmYxNbCvDgHpKr/420,720             ← position
workspace://v1/z6MkpKpf…/document/4Hp8KqRtFmYxNbCvDgHpKr/100,200-400,300     ← region
```

### Table cell

```
workspace://v1/z6MkpKpf…/document/4Hp8KqRtFmYxNbCvDgHpKr/9MnPp-h_a3b9
```

Row `9MnPp`, column `h_a3b9` (an opaque ID from `schema.json` — could be a public-tier column with its name visible in the schema, or a tier-gated column whose name is in `hiddenFields`; the URI is identical in both cases).

### CSV cell

```
workspace://v1/z6MkpKpf…/document/4Hp8KqRtFmYxNbCvDgHpKr/B5
```

Column B, row 5. Structural — works for any CSV.

### PDF page

```
workspace://v1/z6MkpKpf…/document/4Hp8KqRtFmYxNbCvDgHpKr/p5
```

Opens the PDF at page 5.

### Video timestamp

```
workspace://v1/z6MkpKpf…/document/4Hp8KqRtFmYxNbCvDgHpKr/2:34
```

Opens the video at 2 minutes 34 seconds.

### Code line range

```
workspace://v1/z6MkpKpf…/document/4Hp8KqRtFmYxNbCvDgHpKr/L42-L60
```

Opens the source file with lines 42 to 60 highlighted.

### Comment on a section

```
workspace://v1/z6MkpKpf…/document/4Hp8KqRtFmYxNbCvDgHpKr/9MnPpQrStUv/comment/CmAa11BbCc22DdEe
```

A specific comment attached to the markdown section `9MnPp…`. App parses: `document/4Hp8…` → document context; `9MnPp…` → not a reserved keyword, treat as locator; `comment/CmAa…` → reserved keyword `comment` + the comment ID.

### User reference

```
workspace://v1/z6MkpKpf…/user/z6MkBobX5tYpQrStUvWxYzAaBbCcDdEeFfGgHhJjKkLm
```

Reference to Bob's profile within this workspace.

---

## What can leak from a URL

Honest accounting of what an outsider (no workspace access) learns from a `workspace://` URL:

- That a workspace exists at this `<workspace-pubkey>`
- That a resource exists at the addressed ID
- The resource's *type category* (document / invite / user / team), via the path namespace
- For sub-resources via the locator: the locator form (structural address, opaque ID, or positional) — which narrows the format type. Not the locator's *meaning*.

What does NOT leak:

- Contents
- Resource names or titles (no slugs in canonical URIs; opaque IDs for semantic locators)
- Membership of the workspace
- Who created or owns the resource
- When it was created
- The workspace's friendly name

For sensitivity beyond what this provides — e.g. a workspace whose *existence* must remain unknown to non-members — the answer is don't share its URI in any context that reaches non-members. The URI scheme can't defend against URLs being copied into public places by their holders; only against information being readable in URLs that legitimately reach the wrong audience.

For high-privacy workspaces (sensitive investigations, regulated content), the workspace policy file (`policy.json`) supports `stripFragmentsOnShare` and related strict-URL options.

---

## Reserved for future versions

- **Targeted-envelope URIs** — a variant where the URI carries an envelope inline, sealed to a specific recipient. Decision deferred; v1 uses separate `/invite/<did>` URI with envelope on the side
- **Time-travel addressing** — `?at=<timestamp>` for opening a resource at a specific past version
- **Cross-workspace references** — URIs that reference resources in *another* workspace from within a `workspace://` URL (currently: just use a fully-qualified `workspace://` URL anywhere)
- **Workspace-of-workspaces** — nested workspaces. Currently a workspace is the top-level identity; nested constructs would require new path syntax
- **Live data streams / automation tasks** — would get their own top-level namespaces (`/stream/`, `/task/`) parallel to `/document/`, `/user/`, `/team/`

---

## Cross-references

- [`workspace-format.md`](./workspace-format.md) — the `.workspace` container these URIs address
- [`discovery.md`](./discovery.md) — DNS TXT and `.well-known/workspace` mechanisms for resolving a domain to a `workspace://` URI
- [`permissions-model.md`](./permissions-model.md) — the cryptographic protocol
- [`threat-model.md`](./threat-model.md) — what the URI scheme protects and what it doesn't (leakage rules)
- [`risks.md`](./risks.md) — failure modes and mitigations
