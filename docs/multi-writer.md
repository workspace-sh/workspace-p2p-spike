# Two people writing into one workspace

**Status:** plan, 16 Sep 2026. Leslie decides the merge behaviour (§ The
decision) and whether to keep Autobase (§ Autobase, or a signed writer set).
Nothing here is implemented: today a workspace has one writer, the device that
created it.

Where this differs from [ADR 0002](./adr/0002-autobase-merge-strategy.md),
which is Accepted, it says so and why. An ADR is not a fact; it was written
before any of this was built, and two of its assumptions have since been
measured.

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

## The decision — what happens when two people edit one document

The unit each option merges is what changes; everything else in the plan is the
same.

| | **A. Newest edit wins** | **B. Merge inside a document** | **C. Live co-editing (CRDT)** |
|---|---|---|---|
| Unit | The whole document | A block, a table row, a canvas node | Every character |
| Two people edit different parts of one document | One version wins; the other is kept as a copy beside it | Both survive | Both survive |
| Two people edit the same paragraph | One wins, other kept as a copy | One wins, other kept as a copy | Both survive, interleaved |
| Editing the same document at the same time | Works, with copies afterwards | Works, with copies for the same block | Works, live, like Google Docs |
| What the log carries | What it carries today | Per-format operations, new for every format | CRDT updates, not documents |
| New dependency | None | None | A CRDT library, on every platform |
| The apps | Small change | Every editor must emit operations | Every editor is rewritten around it |
| Round-trip validation | As today | Grows with each format's operations | Different in kind |
| Size | Smallest | Large | Largest |

**Recommended: A now, B next, C only if live co-editing becomes a product
goal.** A is the smallest thing that lets two people share a workspace without
losing work invisibly, and it is honest about what it does. B is where ADR 0002
already points and is worth doing before real content accumulates — it is what
makes "two people editing one file" ordinary rather than survivable. C is a
different product: it is worth it when people expect to see each other's cursor,
not before.

**What A costs the person:** editing the same document while apart produces a
second file, and someone has to reconcile it by hand. Nothing is lost, but the
tidying is theirs.

**Why not skip to B:** B needs every format to emit operations — markdown
blocks, table rows, canvas nodes — which is the same work as
workspace-sh/workspace#222, spread across three renderers and the Rust core. A
is a week's shape; B is the shape of a month, and it can be built on top of A
without redoing it, because the merge layer is a dispatch table either way.

## Autobase, or a signed writer set

ADR 0002 assumes Autobase. That assumption is worth re-examining before it
costs anything, for three reasons found since:

1. **Autobase has one base-wide encryption key and no documented rotation**
   (`join-by-link.md` § Key rotation on removal, `permissions-prior-art.md` § 6).
   The permissions model wants per-tier keys and epochs, so either the view
   holds ciphertext the base cannot read, or per-scope bases multiply. Neither
   is designed.
2. **Nobody has decided who the indexers are** (`permissions-prior-art.md`,
   open question 3). Until then, "the signed order" has no signer, and
   `signedLength` — which the removal rules depend on — has no value.
3. **Our entries do not need a total order.** They carry whole documents and
   the merge is per-document last-write-wins. A winner per path, decided by
   (clock, writer key), converges from any interleaving with no ordering
   service at all.

**The alternative, for option A:** each writer keeps its own log; a
**root-signed writer record** on the DHT says which logs a workspace accepts,
exactly as grant records already say which devices may read
(workspace-sh/workspace#476); every device folds the logs it can verify. Each
entry carries a small **version vector** — how much of each writer's log the
author had already folded — so "one edit came after the other" and "the two are
concurrent" are distinguishable facts rather than guesses about clocks. That is
what makes a conflict copy appear only when there was a genuine conflict.

**Recommended: the signed writer set for A**, and revisit Autobase when B
arrives, because per-format merge and structural permissions (spike#58) both
want a single place where entries are applied under a signed order. Nothing in
A forecloses it: the writer record, the version vector and the per-path merge
all survive a later move to Autobase, which would replace how order is agreed,
not what an entry says.

---

## The slices

Sizes are relative: S is a day or so, M a few, L a week or more.

| # | Slice | Where | Size |
|---|---|---|---|
| 1 | **A workspace can say who may write.** A `workspace/write` capability, a root-signed writer record naming each writer's log key, and verification of that record before a log is folded | `portable-bootstrap`, `workspace` | M |
| 2 | **This device writes its own log.** Every device creates its own data log on first write; the creator's log stops being special | `workspace` | M |
| 3 | **Documents come from every writer's log.** `entries()` folds across logs; each entry carries a version vector; the per-path winner is (clock, writer key), and the apps' fold is untouched | `workspace`, `core` | L |
| 4 | **The loser is kept.** A concurrent loss becomes a conflict copy beside the document, named for the device that wrote it, and stays in history | `core`, both apps | M |
| 5 | **Writer logs replicate.** Peers fetch the logs the writer record names; the gate and encryption are unchanged | `p2p-runtime`, `workspace` | S |
| 6 | **Write access is granted like read access is.** Share… offers "can edit"; a device that gains it starts writing without reopening | `workspace` IPC, both apps | M |
| 7 | **Removal.** A removed writer's later entries are refused by every device; entries concurrent with the removal are held for an admin, as decided on 14 Sep | `workspace`, apps | M |
| 8 | **Proof.** Two devices editing one workspace, including while apart: a smoke, and app tests | scripts, apps | M |

Slices 1–3 are the spine; 4 is what makes it safe to use; 5–6 make it usable;
7–8 make it defensible. A stops here. B (merge inside a document) begins after
8 and is its own plan.

## What each app must do

The packages hand the apps a merged fold, so most of each app is unchanged.
What isn't:

- **Read-only is no longer "not the creator".** It is "no writer grant". Both
  apps decide it from a cached boolean that is set once when a workspace opens
  (`remote-base.ts`), which is wrong the moment write access can be granted to
  a device that is already running. It has to follow the status event.
- **The sync loops have a single-writer assumption each.** Linux's
  `sync.ts` and the desktop's `reconcile.ts` / `ingest.ts` skip their work when
  `writable === false`, and their echo-suppression maps are keyed by path with
  no notion of who wrote the bytes. Both need to treat a remote write that
  matches local bytes as harmless and a remote write that doesn't as an
  external edit.
- **Conflict copies need somewhere to appear.** A file arrives beside the
  document; the sidebar should say what it is, and opening it should not feel
  like a bug.
- **Granting write access needs a control.** Share… becomes "can read" or "can
  edit"; the Linux dialog and the macOS sheet each need the choice.
- **Seeding for tests conflates admin with writer** (`store.ts`'s
  `seedWorkspacesForTest` sets `isAdmin` and `writable` from one flag). That
  equation is exactly what this work breaks.

## What has to be decided before slice 1

- **The merge behaviour** (§ The decision) — Leslie.
- **Autobase or the signed writer set** (§ above) — Leslie, with the
  recommendation above.
- **Whether a writer record lives on the DHT, in the key-delivery log, or
  both.** Grants took the DHT; the key-delivery log is the offline carrier. The
  same answer probably serves both, and it is a small decision once the first
  two are made.

## What this plan does not cover

- **Structural permissions** (spike#58): who may create, move or delete, as
  distinct from who may edit a document's contents. It needs an explicit move
  operation, which today's log does not have.
- **Per-format merge** (option B) and its operation vocabulary, which is
  workspace-sh/workspace#222.
- **Key rotation on removal.** Removal stops a writer; it does not re-key what
  they already read. That limitation is recorded in `permissions-model.md` and
  is not made worse by anything here.
