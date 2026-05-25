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
workspace://v1/<workspace-pubkey>/document/<doc-id>/at/<locator>             ← sub-resource
workspace://v1/<workspace-pubkey>/document/<doc-id>/comment/<comment-id>     ← comment
workspace://v1/<workspace-pubkey>/document/<doc-id>/at/<loc>/comment/<id>    ← comment on sub-resource
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

All routing-critical information lives in the path. Query strings carry only optional hints. Fragments carry only client-local view state. This isolates routing from the parts of a URL that some chat apps mangle when generating previews.

---

## The version prefix — `v1`

Always present, always in the path. Mandatory.

Versioning rules:

- **Backward-compatible additions** (new optional query parameters, new optional path segments, new reserved path namespaces) → stay at `v1`. Older parsers ignore unknown fields gracefully.
- **Breaking changes** (different encoding, different field semantics) → bump to `v2`. `v1` parsers must reject `v2` URIs explicitly: "this URI version is not supported, please upgrade."

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

| Path namespace | Purpose | ID / locator shape | Status |
|---|---|---|---|
| `/document/<id>` | universal container for any primary content resource (markdown, canvas, table, folder, etc.) | UUIDv4 in base58btc | v1 |
| `/document/<id>/at/<locator>` | sub-resource within a document | format-defined per file type | v1 |
| `/document/<id>/comment/<id>` | comment attached to a document | UUIDv4 in base58btc | v1.x (reserved) |
| `/document/<id>/at/<loc>/comment/<id>` | comment on a sub-resource | composite | v1.x (reserved) |
| `/invite/<did>` | invite addressed to a specific recipient DID | full DID in multibase | v1 |
| `/user/<did>` | reference to a user within this workspace | full DID in multibase | v1 |
| `/team/<id>` | reference to a team / tier | UUIDv4 in base58btc | v1.x (reserved) |

Files-and-folders all share `/document/<id>`. The document's *type* (markdown vs canvas vs table vs folder) is determined by lookup, not by the URL. This means:

- Adding a new file type doesn't require a new URL namespace
- The URL doesn't leak the document type
- Tooling that constructs URLs doesn't need to know what kind of thing it's referencing — just its ID

---

## Sub-resource addressing — `/at/<locator>`

A single namespace for addressing inside a document. The locator after `/at/` is interpreted by the client according to the document's format.

```
workspace://v1/z6Mk…/document/<doc-id>/at/<locator>
```

The URI scheme doesn't specify what the locator looks like — that's defined by each file format's spec. Common patterns:

- **Structural** — addresses tied to the document's intrinsic structure (line numbers, pages, timestamps, coordinates). Non-leaky because the structure is exposed when the document is opened anyway.
- **Semantic** — addresses tied to user-meaningful labels (heading names, field names, anchor labels). If used directly, these leak the label into the URL. For sensitive formats, semantic locators are HMAC-keyed (see below).
- **Opaque native IDs** — formats that already carry IDs (JSON Canvas nodes, table rows) use those directly. Already opaque by format design.

---

## Locator alphabets for v1 formats

### Markdown — HMAC-keyed slug

Markdown headings don't have inherent stable identifiers. To address a heading without leaking its text:

```
locator = HMAC(K_url, doc_id + ":" + normalised_slug)[:8 bytes]
                                                    base58btc encoded
                                                    → ~12 chars
```

- `K_url` — a workspace-stable secret key, separate from `K0_org` (see [K_url section](#k_url--the-url-locator-key))
- `doc_id` — the document's ID from the workspace's Hyperbee index
- `normalised_slug` — the standard markdown slug (e.g. "Getting Started" → `getting-started`), with collision-resolving suffix for duplicates (`getting-started-1`, `getting-started-2`)
- Truncated to 8 bytes (64 bits, enough collision resistance for per-document scope)

Example:
```
workspace://v1/z6Mk…/document/4Hp8KqRtFmYxNbCvDgHpKr/at/2vJxKp9rEqYq
```

**Resolution** (member with K_url):
1. Open the document
2. For each heading in the document, compute its HMAC
3. Match the URL's locator → navigate
4. No match → "section not found, document may have been edited"

**Resolution** (non-member): cannot compute HMAC, cannot enumerate. Locator is opaque.

**Stability**: HMAC changes if the heading is renamed (the slug changes). Same stability behaviour as plain slugs — renames break URLs. No format on Earth can give us stability without embedding IDs in the file, which we've ruled out.

### JSON Canvas — native node IDs and coordinates

JSON Canvas spec already gives each node an `id` field. Use directly:

```
workspace://v1/z6Mk…/document/4Hp8…/at/node-9MnPpQrStUv
```

For position-based addressing (the "look at this point on the infinite canvas"):

```
workspace://v1/z6Mk…/document/4Hp8…/at/420,720
```

The `node-` prefix disambiguates from positional `x,y` coordinates within the canvas format's locator alphabet.

### Tables (`.table/`) — row + column

Row by primary key:
```
workspace://v1/z6Mk…/document/4Hp8…/at/9MnPpQrStUv
```

Column. For tier-0 (workspace-public) columns, the field name is fine — there's nothing to hide:
```
workspace://v1/z6Mk…/document/4Hp8…/at/column-name
```

For tier-gated columns (declared in `hiddenFields`), the opaque ID from `schema.json` is used:
```
workspace://v1/z6Mk…/document/4Hp8…/at/column-h_a3b9
```

Cell — composite of row and column:
```
workspace://v1/z6Mk…/document/4Hp8…/at/9MnPpQrStUv-h_a3b9
```

The table's locator alphabet handles both public and tier-gated cases uniformly — opaque IDs come from `hiddenFields` when needed.

---

## K_url — the URL-locator key

A workspace-stable secret key used for HMAC computation in URL locators. Distinct from the encryption tier keys.

| Property | Value |
|---|---|
| Size | 32 bytes |
| Generated | at workspace creation, once |
| Distributed | via the same envelope/key-delivery mechanism as other workspace keys |
| Held by | all workspace members |
| Rotates? | **no** — stable for the lifetime of the workspace |
| Used for | HMAC of URL locators (markdown slugs, and any future format with semantic locators that need opacity) |
| Used for what else? | nothing — never used to encrypt content, never used for authentication |

### Why it doesn't rotate

If `K_url` rotated with membership changes (like `K0_org`), every URL ever shared would break at every rotation event. URLs need to survive the workspace's lifetime, even as members come and go.

The trade-off: a revoked member still holds `K_url` and can reverse-engineer URL locators back to heading names. But they already knew those headings while they were members — no new information is leaked by retaining `K_url`. Same forward-only contract as the rest of the system.

### Why it's separate from K0_org

`K0_org` is for encryption; rotating it on membership change is essential for forward-only revocation of content access. `K_url` is for opacity to non-members; its job is unaffected by membership churn. Conflating them would force one of: URLs breaking on rotation, or revocation being incomplete. Separating them keeps both honest.

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
   - `/at/<locator>` — open the document; resolve the locator via the document's format-specific mechanism
   - `/comment/<id>` — Hyperbee lookup on comment ID
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
| Sub-resource locator | inside the document itself (format-defined: HMAC scan for markdown, native IDs for canvas, row primary key + column ID for tables) | O(n) for HMAC scan within a doc (~30 headings = microseconds); O(1) for native IDs |
| Comment ID | Hyperbee | O(log n) |
| Team ID | Hyperbee | O(log n) |
| User DID | Hyperbee | O(log n) |
| Envelope (invite recipient DID) | `_workspace/envelopes/<encoded-did>.json` — one file per recipient | O(1) file read |

No giant index files. The Hypercore data log itself is structurally an event stream; Hyperbee sits on top as a B-tree projection for fast keyed lookups. Sparse-loadable — peers fetch only blocks they actually query. Cold-start cost is bounded (~4 KB) regardless of workspace size.

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

Opens whatever resource (markdown / canvas / table / folder) has ID `4Hp8…` in this workspace.

### Markdown section

```
workspace://v1/z6MkpKpf…/document/4Hp8KqRtFmYxNbCvDgHpKr/at/2vJxKp9rEqYq
```

Opens the markdown document, navigates to the heading whose HMAC-keyed slug matches the locator.

### Canvas node

```
workspace://v1/z6MkpKpf…/document/4Hp8KqRtFmYxNbCvDgHpKr/at/node-9MnPpQrStUv
```

Opens the canvas, navigates to the node with ID `9MnPp…`.

### Canvas position

```
workspace://v1/z6MkpKpf…/document/4Hp8KqRtFmYxNbCvDgHpKr/at/420,720
```

Opens the canvas, scrolls to coordinate (420, 720).

### Table row

```
workspace://v1/z6MkpKpf…/document/4Hp8KqRtFmYxNbCvDgHpKr/at/9MnPpQrStUv
```

Opens the table, navigates to the row with primary key `9MnPp…`.

### Table cell (tier-gated column)

```
workspace://v1/z6MkpKpf…/document/4Hp8KqRtFmYxNbCvDgHpKr/at/9MnPpQrStUv-h_a3b9
```

Row `9MnPp`, column `h_a3b9` (an opaque ID from `hiddenFields` — the column's name is sealed at the schema layer).

### Comment on a section

```
workspace://v1/z6MkpKpf…/document/4Hp8KqRtFmYxNbCvDgHpKr/at/2vJxKp9rEqYq/comment/Ab12CdEfGhJk
```

A specific comment attached to a specific markdown section.

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
- For sub-resources via `/at/<locator>`: the locator form (structural address, opaque ID, or HMAC) — which narrows the format type. Not the locator's *meaning*.

What does NOT leak:

- Contents
- Resource names or titles (no slugs in v1; HMAC for markdown sections)
- Membership of the workspace
- Who created or owns the resource
- When it was created
- The workspace's friendly name

The HMAC-keyed slug for markdown specifically closes the heading-name leak that a plain-slug URL would expose. Other formats are either already opaque by design (canvas, hidden-field columns) or structural-by-nature (timestamps, lines, coordinates).

For sensitivity beyond what this provides — e.g. a workspace whose *existence* must remain unknown to non-members — the answer is don't share its URI in any context that reaches non-members. The URI scheme can't defend against URLs being copied into public places by their holders; only against information being readable in URLs that legitimately reach the wrong audience.

---

## Reserved for future versions

- **Targeted-envelope URIs** — a variant where the URI carries an envelope inline, sealed to a specific recipient. Decision deferred; v1 uses separate `/invite/<did>` URI with envelope on the side
- **Time-travel addressing** — `?at=<timestamp>` for opening a resource at a specific past version
- **Cross-workspace references** — URIs that reference resources in *another* workspace from within a `workspace://` URL (currently: just use a fully-qualified `workspace://` URL anywhere)
- **Workspace-of-workspaces** — nested workspaces. Currently a workspace is the top-level identity; nested constructs would require new path syntax

---

## Cross-references

- [`workspace-format.md`](./workspace-format.md) — the `.workspace` container these URIs address
- [`permissions-model.md`](./permissions-model.md) — the cryptographic protocol, including `K_url`'s place in the workspace's key hierarchy
- [`threat-model.md`](./threat-model.md) — what the URI scheme protects and what it doesn't (leakage rules)
- [`risks.md`](./risks.md) — failure modes and mitigations
