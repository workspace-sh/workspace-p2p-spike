# What a block is, and how it keeps its identity

**Status:** proposal, 17 Sep 2026. The crux of per-entity merge
([ADR 0002](./adr/0002-autobase-merge-strategy.md), [multi-writer.md](./multi-writer.md)):
two people editing different paragraphs of one document both keep their work
only if every device agrees which paragraph is which. Nothing here is built.

Shaped by the design of the TypeScript prose model, which supplies the diff
passes, the granularity table and the normalisation trap in § The trap.

---

## The rule

**A block's identity lives in the log, never in the file.** A block gets an id
when it is created — the writer's public key and a counter, so no two writers
can collide and no coordination is needed — and the log holds what that id
says and where it sits. The file on disk is a projection of those blocks.

Identity cannot live in the file. An id written into the markdown (`{#id}`, an
HTML comment) would show up in every other editor, survive no copy-paste, and
break the promise that a workspace is a folder of ordinary files. And matching
"by current heading text", which `workspace-format.md` § Per-format
reconciliation suggests today, is a **matching heuristic, not an identity**: it
says nothing about two paragraphs under one heading, a heading that was
renamed, or a block that moved.

So: the file is what a person edits, the log is what the devices agree on, and
one job — below — turns the first into the second.

## Turning a saved file into operations

The device that saved the file does this work, by diffing what was saved
against the projection it last had. Only the writer diffs; every other device
just applies the operations. So this does not have to produce identical
operations on every platform — it has to produce *honest* ones.

In passes, cheapest and surest first:

| # | Pass | What it settles |
|---|---|---|
| 1 | Exact content hash, in order (patience/LCS over block hashes) | Everything untouched. These become anchors |
| 2 | Between anchors, same position and kind | An edit. This is what makes a renamed heading, or one of two paragraphs under a heading, an update rather than a delete and an insert |
| 3 | Exact hash outside the LCS | A move: the content is unchanged, the position is not |
| 4 | Same kind, token overlap above a threshold | A move and an edit. Below the threshold: a delete and an insert |

The operations are `insert(id, position, content)`, `update(id, content)`,
`move(id, position)` and `delete(id)`.

## What counts as a block

| Kind | Block? |
|---|---|
| Paragraph, heading, code block, HTML block, thematic break | One block each |
| **Top-level list item** | **One block each.** Two people adding items to one list is the commonest concurrent edit there is; a whole list as one block would collide on every one of them |
| Quote or alert containing other blocks | One block, for v1 |
| A table | Its own format's entity (`.table`), not a markdown block |
| Frontmatter, footnote definitions, link reference definitions | **Natural ids** from their label — matching them by position would be wrong |

## Position is its own register

A block carries a **fractional index**, and position merges separately from
content. So a person moving a block while another edits it keeps both changes,
and two people inserting at the same place both survive, ordered by writer key.
Content last-writer-wins and position last-writer-wins are two registers on one
block, not one decision about the block.

## The trap: an editor that normalises

The Apple and Android editors deliberately normalise some markdown when they
round-trip it — setext headings become ATX, reference images become inline,
`<br>` becomes a backslash break. It is recorded per element in
`docs/element-spec.json`.

**If a save diffs raw text, a device that merely opened a document and saved it
emits updates for blocks nobody touched — and under last-writer-wins those
updates overwrite a concurrent real edit somewhere else.** Someone loses a
paragraph they were editing because a colleague opened the file on a phone.

Two defences, and the spec requires both:

1. **Editors rewrite only what was edited.** Apple's renderer already splices
   per dirty segment, so untouched blocks keep their exact bytes. Every
   platform is held to that.
2. **The core decides "changed" by canonical form.** Both sides are parsed and
   compared as normalised syntax trees; whitespace-only differences and the
   known normalisations are not changes. Separators between blocks are
   normalised too, so a blank line is never content.

Neither defence is sufficient alone: the first can be broken by a new editor,
the second by a normalisation nobody recorded. Together, a block changes only
when its meaning changed.

## Deleting something someone else is editing

Pure last-writer-wins lets a delete that happened to be later silently drop a
concurrent edit. **An update concurrent with a delete resurrects the block**,
and the deletion stays in history.

The reasoning: the two people disagree, and the safe direction is the one that
can be undone by a person in a second — deleting it again — rather than the one
that needs someone to notice something is missing. Dropbox restores a file
edited concurrently with its deletion for the same reason. "Concurrent" here is
a fact from the version vector, not a guess about clocks: an update that had
already seen the delete is an edit to a deleted block and does not resurrect it.

**This is not settled**, because it is behaviour a person feels: a paragraph
they deleted can come back.

## A save is one entry, not one per block

The unit appended to a writer's log is a **change set**: every operation from
one save, in order, with one clock, one author and one version vector. A
document with forty blocks edited in one sitting is one entry, not forty.

Three reasons, and the third is the one that matters:

- **Cost.** A version vector on every block operation would often be larger
  than the operation.
- **Atomicity.** Half a save is never visible: a peer either has the change set
  or does not.
- **Meaning.** "What did this person change?" is a question about a save. The
  history a person reads is a list of change sets; the merge underneath is per
  block.

## Rebuilding the file

The projection — merged blocks back to a file on disk — must be **byte-stable
when nothing changed**. Rebuilding a document nobody edited must produce
exactly the bytes already there.

This is not tidiness. Both apps watch the working tree and feed changes back
into the log; a projection that rewrote a file gratuitously would look like an
external edit, produce a change set, and travel to every peer. An unstable
projection is a loop.

The test for it exists already: the 104 elements in `docs/element-spec.json`
must each survive diff → operations → merge → projection unchanged, byte for
byte, along with the documents the apps' own sweeps use.

## Where it lives

In the Rust core of the markdown library, beside `html.rs`, because every
platform already parses markdown there. Written once, not three times in
TypeScript, Objective-C++ and Kotlin.

## Tombstones do not go away

A deleted block's id must stay known, or a late-arriving edit from a device
that was offline resurrects it by accident instead of by the rule above. So the
log keeps tombstones, and they accumulate. `adr/0003-store-dual-form.md`
already records that compaction is unsolved; this makes it slightly more
pressing, not differently so.

## Open questions

1. **The similarity threshold** in pass 4 — how different two paragraphs can be
   before "edited" becomes "replaced".
2. **A block moved and edited in one save** — one change in the history a
   person reads, or two.
3. **List items nested under other items** — their own blocks in v1, or part of
   the parent's?
4. **Resurrection** (§ Deleting something someone else is editing) — is a
   deleted paragraph coming back the right behaviour?
