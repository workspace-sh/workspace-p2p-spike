# Two people writing into one workspace

**Status:** plan, 17 Sep 2026. The merge behaviour was decided in
[ADR 0002](./adr/0002-autobase-merge-strategy.md) and still stands; the
foundation under it is decided here. Nothing is implemented yet: today a
workspace has one writer, the device that created it.

ADR 0002's merge decision is kept whole. What this plan changes is the layer
beneath it — the ADR said "over Autobase", and three of its assumptions have
since been measured (§ Autobase, or a signed writer set).

---

## What is true today

| | Today |
|---|---|
| Writers | One: the device that created the workspace holds the data log's secret key |
| What stops a member writing | Nothing but key custody. Its UCAN says `workspace/read`, checked when a connection is admitted and never again |
| An entry | The document's **whole contents**, with a path and the author's clock. Two ops: put and delete |
| How documents are derived | The entries in log order, last one per path wins |
| Encryption | One key for the whole workspace, and it already covers several logs |

So the one thing that decides who may write is the one thing that cannot be
shared: a Hypercore's secret key. Everything else — the gate, the UCAN, the
apps' read-only banners — is a friendlier restatement of that fact.

**Writability belongs to a store, not to a device.** Observed 17 Sep 2026: one
device, with one identity and holding the workspace's root key, opened a
workspace it had created minutes earlier and was correctly told "Read-only —
this workspace was shared with this device to read". Nothing was wrong. The
logs had been created in a different store on the same machine, and writability
follows the store that holds the log's secret key.

So "can this device write?" already has three different answers — it holds the
root key, it holds the log's secret key, it passed the gate — and only the
middle one decides. A person cannot be expected to hold that distinction, and
an app cannot explain it. Slice 2 below, where every device writes its own log,
is what collapses the three into one.

## Forks: what cannot happen, and what can

**A log cannot fork.** A Hypercore has exactly one writer by construction, and
`workspace-format.md` invariant 6 forbids copying a device's keys, so there is
no second appender to fork it. Multi-writer here means **each device writes its
own log** and a workspace's documents are derived from all of them. Nothing in
this plan puts two appenders on one log, and nothing should.

**Work can still be lost, in the merge.** That is where the risk moves, and it
is the thing to design against: two people edit the same document, both
entries are genuine and neither is a fork, and something has to decide what the
document now says. Whatever is chosen below:

- **The loser is never dropped silently.** It stays in the log and in the
  document's history, which already exists (`restoreRevision`).
- **A person sees it.** A concurrent loss writes a copy beside the document,
  named for the device that wrote it, the way Dropbox does. A file appearing is
  a thing people understand; a paragraph quietly reverting is not.
- **Convergence is a pure function of the entries.** Every device computes the
  same result from the same entries, in any order, with no coordinator. No wall
  clock is consulted at the moment of the decision — only the clocks recorded
  inside the entries, with a tie-break that is part of the data.

---

## The merge is already decided

[ADR 0002](./adr/0002-autobase-merge-strategy.md) settled it, and it was
reaffirmed on 16 Sep 2026. **Last-writer-wins per entity, where the entity is
what each format calls a thing:**

| Format | The unit that wins or loses | What that means for two people |
|---|---|---|
| Markdown | A block — a heading, a paragraph | Editing different paragraphs of one document both survive. Only the same paragraph collides |
| `.table` | A row, by its key, per column | Different rows never collide; different columns of one row both apply |
| JSON Canvas | A node, per property | Moving different nodes never collides. Moving the same node one way and renaming it another both apply |
| Anything else | The whole file | The loser is kept beside it as a copy |

Ties break on the author's clock, then the writer's public key, so every device
reaches the same answer with no coordination. A same-entity collision still
loses one side, and that side is kept: in history, and as a copy where a copy
makes sense.

**What this costs, said plainly.** Per-entity merge means the log stops carrying
whole documents and starts carrying operations on entities, so every format
needs a way to say what changed. That is
workspace-sh/workspace#222, and it is the bulk of the work below. It is also
the reason not to do a whole-document version first and convert later: the
entry format is the thing that would have to be migrated, and a workspace's
log is the one thing that cannot be rewritten after the fact.

**Where the per-format work belongs.** Markdown is parsed for every platform by
one Rust core, so the block diff belongs there rather than being written three
times in TypeScript, Objective-C++ and Kotlin. `.canvas` and `.table` have
their own shared parsers. Each produces operations; the merge itself is one
dispatch table over them, as ADR 0002 says.

## Autobase, or a signed writer set

ADR 0002 says "over Autobase". That part is worth re-deciding before it costs
anything, and the answer is **a signed writer set now, Autobase when something
needs an agreed order.**

**What Autobase would give us:** one linearisation every device agrees on, and
a place — `apply` — where an entry is accepted or refused under that order.

**What it costs today:**

1. **One base-wide encryption key, and no documented rotation**
   (`join-by-link.md` § Key rotation on removal, `permissions-prior-art.md` § 6).
   The permissions model wants per-tier keys and epochs. Either the view holds
   ciphertext the base itself cannot read, or scopes get their own bases.
   Neither is designed.
2. **No decision about who the indexers are** (`permissions-prior-art.md`, open
   question 3). `signedLength` is what the writer-removal rules rest on, and
   until there are indexers it has no signer.
3. **The merge does not need it.** Per-entity last-writer-wins converges from
   any interleaving: the winner for an entity is a pure function of the
   operations on it, not of the order they arrived in.

**What replaces it:** each writer keeps its own log; a **root-signed writer
record** says which logs a workspace accepts — the machinery the grant records
already use (workspace-sh/workspace#476); every device folds the logs it can
verify. Each entry carries a **version vector**: how much of each writer's log
its author had already folded. That makes "this edit came after that one" and
"these two are concurrent" facts rather than guesses about clocks, which is
what decides when a collision is real and a copy is warranted.

**Where Autobase comes back.** Two things genuinely want an agreed order rather
than a convergent rule: structural permissions (spike#58 — who may create, move
or delete), and the decided rule for an entry written concurrently with a
writer's removal being held for an admin. A version vector answers "concurrent
or not" for both, so neither is blocked; but if either grows to need a single
signed sequence, Autobase is the thing to adopt, and adopting it changes how
order is agreed, not what an entry says. Nothing below forecloses it.

## The slices

Sizes are relative: S is a day or so, M a few, L a week or more.

| # | Slice | Where | Size |
|---|---|---|---|
| 1 | **A workspace says who may write.** A write capability, a root-signed writer record naming each writer's log, and verification of that record before a log is folded | `portable-bootstrap`, `workspace` | M |
| 2 | **Every device writes its own log.** The creating device's log stops being special; a device makes its own on first write | `workspace` | M |
| 3 | **An entry names an entity, not a document.** The entry format carries an operation on (path, entity), its author, its clock and its version vector; the fold becomes a merge across logs, per-entity, tie-broken by clock then writer key | `core`, `workspace` | L |
| 4 | **Markdown blocks.** How a block is identified across edits, and the operations a save produces — in the Rust core, which every platform already parses markdown with | markdown library | L |
| 5 | **A document is rebuilt from its merged entities.** The inverse of 4: merged blocks become the file on disk, byte-for-byte stable when nothing changed | markdown library, `core` | L |
| 6 | **Canvas nodes and table rows.** The other two formats' operations. Everything else stays whole-file, loser kept as a copy | `canvas-core`, `.table` layer | L |
| 7 | **A collision is visible.** Same-entity losers stay in history and appear as a copy where a copy makes sense, with the device that wrote them named | `core`, apps | M |
| 8 | **Writer logs replicate.** Peers fetch the logs the writer record names; the gate and encryption are unchanged | `p2p-runtime`, `workspace` | S |
| 9 | **Write access is granted like read access.** Share… offers "can edit", and a device that gains it starts writing without reopening (#512–#515) | `workspace` IPC, apps | M |
| 10 | **Removal.** A removed writer's later entries are refused everywhere; entries concurrent with the removal are held for an admin, as decided on 14 Sep | `workspace`, apps | M |
| 11 | **Proof.** Two devices editing one workspace, including while apart; the 104-element round trip through the new entry format; app tests | scripts, apps | M |

1–3 are the spine, and nothing is usable until 4–5 land, because markdown is
the primary format. 6 finishes the formats, 7 is what makes it safe to use,
8–9 make it usable, 10–11 make it defensible.

**The order matters for one reason:** slice 3 changes what a log holds. A
workspace's log cannot be rewritten afterwards, so the entry format wants to be
right before real content accumulates — which is also
workspace-sh/workspace#222's argument, made a year earlier.

## What each app must do

The packages hand the apps a merged fold, so most of each app is unchanged.
What isn't:

- **Read-only is no longer "not the creator".** It is "no writer grant". Both
  apps decide it from a cached boolean set once when a workspace opens
  (`remote-base.ts`), which is wrong the moment write access can be granted to
  a device that is already running. Filed as workspace-sh/workspace#512 with
  one follow-up per app (#513 Linux, #514 macOS, #515 iOS); worth doing now,
  since it is a latent bug either way.
- **The sync loops have a single-writer assumption each.** Linux's
  `sync.ts` and the desktop's `reconcile.ts` / `ingest.ts` skip their work when
  `writable === false`, and their echo-suppression maps are keyed by path with
  no notion of who wrote the bytes. Both need to treat a remote write that
  matches local bytes as harmless and a remote write that doesn't as an
  external edit.
- **An editor must be able to save a change as operations.** This is the new
  one, and it is not small: a save currently hands over the whole document.
  Under per-entity merge the app asks the format's parser what changed and
  appends that. The prose editor already holds a model of the document, so the
  work is plumbing it to the diff rather than inventing it.
- **Conflict copies need somewhere to appear.** A file arrives beside the
  document; the sidebar should say what it is, and opening it should not feel
  like a bug.
- **Granting write access needs a control.** Share… becomes "can read" or "can
  edit"; the Linux dialog and the macOS sheet each need the choice.
- **Seeding for tests conflates admin with writer** (`store.ts`'s
  `seedWorkspacesForTest` sets `isAdmin` and `writable` from one flag). That
  equation is exactly what this work breaks.

## What still needs deciding, and when

- **How a markdown block is identified across edits** — proposed in
  [`block-identity.md`](./block-identity.md), written with the prose model's
  author. Identity lives in the log, never in the file; a save becomes one
  change set of block operations; position merges separately from content; and
  an editor that normalises markdown is the trap that would otherwise
  overwrite a colleague's work. Four questions in it are still open.
- **Where the writer record lives** — the DHT, like grant records; the
  key-delivery log, which is the offline carrier; or both. Small, once slice 1
  starts.
- **What a version vector costs on the wire** — every entry carries one, so its
  encoding matters for a log of many small block edits. Measure in slice 3.

## What this plan does not cover

- **Structural permissions** (spike#58): who may create, move or delete, as
  distinct from who may edit a document's contents. It needs an explicit move
  operation, which today's log does not have.
- **Live co-editing.** ADR 0002 defers a text CRDT, and this plan keeps that
  deferral: two people typing in the same paragraph at the same time still
  means one of them wins and the other is kept. Seeing each other's cursor is
  a different product decision, not a missing piece of this one.
- **Key rotation on removal.** Removal stops a writer; it does not re-key what
  they already read. That limitation is recorded in `permissions-model.md` and
  is not made worse by anything here.
