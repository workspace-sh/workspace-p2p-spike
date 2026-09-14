# Joining by link

**Status:** proposal, 14 Sep 2026. Needs Leslie's decisions on the questions
marked **Decide**. Nothing here is implemented except where it says so.

How a device that has been shared a workspace gets from "someone sent me
something" to "I am replicating it", and what a `workspace://` link has to
carry for that to work without sending a folder.

---

## The layers, and where each one stops

A join crosses three layers. Each does one job and hands over.

| Layer | Its job | Where it stops |
|---|---|---|
| **Holepunch transport**: HyperDHT, Hyperswarm, Protomux | Find peers by topic, hole-punch, open a Noise connection that proves each side holds its device key, multiplex channels over it | Two devices that know each other's device key, with an encrypted pipe and channels |
| **UCAN**, via ucanto | Say who may do what: the root, or someone the root delegated to, grants a device `workspace/read` on `workspace://v1/<id>` until a time | At the connection gate: the chain verifies to the root, names this workspace, and its audience is the key Noise just proved. After that UCAN is not consulted |
| **Hypercore**, Corestore | Append-only logs signed by their writer; replication sends blocks a reader verifies against the log key | "These are exactly the bytes the writer appended". It knows keys, not people, and does not encrypt |

What is ours, not Holepunch's or ucanto's:

- **The device key.** One ed25519 key is both the Noise static key and the
  UCAN audience (`did:key`). That binding is what makes a copied UCAN useless
  to anyone else.
- **The envelope.** A UCAN plus the workspace key K0 sealed to the recipient's
  key (X25519), plus the resource URI.
- **The attestation.** The root's signature over the manifest.
- **Content encryption.** Blocks are sealed under K0 before Hypercore stores
  them (`encryptedLog`).

A join in order, with the owner of each step:

| # | Step | Layer |
|---|---|---|
| 1 | B has a device key; its DID is its ID | ours |
| 2 | An admin issues root → B `workspace/read`, and seals K0 to B: the envelope | UCAN, ours |
| 3 | The envelope reaches B | this document |
| 4 | B verifies the attestation, validates its UCAN, unwraps K0 | ours, UCAN |
| 5 | B joins the topic, hole-punches to a member, Noise proves both keys | Holepunch |
| 6 | Both present UCANs on `workspace/auth@1`; each verifies the other | UCAN over Protomux |
| 7 | Replication of the workspace's cores | Hypercore |
| 8 | B decrypts blocks with K0 | ours |

## Entry points

A device can be handed a workspace three ways. All three end at the same place:
an envelope for this device, a verified attestation, and steps 4–8 above.

| Entry point | Carries | Works today | Private if intercepted |
|---|---|---|---|
| **The whole folder** (`Acme.workspace` over Dropbox, Drive, AirDrop, SD card, USB) | Everything: public-tier documents as plain files, `.workspace/` with the encrypted store and every envelope | Yes, once the recipient has been shared with *before* the copy is made. Opens offline; follows live edits when a member is online | Only for tier-gated content. Public-tier documents are plain files in the folder (`workspace-format.md` rule 1), and every document is public-tier today |
| **An invitation** (`.workspace/` holding manifest, attestation, the recipient's envelope) | No content | Yes (workspace#456). Content arrives from a member online | Yes: reveals the workspace key, its log keys and root DID, and nothing readable |
| **A `workspace://` link** (pasted, or a QR code) | See Decide 2 | No | See Decide 2 |

Two notes for the folder:

- Send a copy. A cloud folder that both devices' apps have open is a folder two
  apps write into, each receiving the other's writes through the sync engine;
  `workspace-format.md` § cloud sync says a sync engine gives you a copied folder,
  not a peer.
- For a folder that must stay private in transit, send `.workspace/` alone,
  including `store/`: the recipient reads it offline and nobody else can.

## What works today

- **Step 2** for any admin, and on Linux after reopening: the creating device
  keeps the root seed (workspace-sh/workspace#453).
- **Step 3 by folder.** The admin exports an *invitation*: a folder holding
  only `.workspace/manifest.json`, `attestation.json` and the recipient's
  envelope (workspace#456). B opens it with Open Workspace…, and steps 4–8 run.
  Proven through the apps' own child processes over a private DHT
  (`yarn p2p:smoke:two-device`) and with the Linux app as the recipient.
- **Step 6** verifies every link's signature, the chain to the root, and that
  the capability names this workspace (workspace#430, #448).

A link that replaces the folder is the gap.

## Why a link does not work yet

1. **The gate is first.** A member exchanges nothing with a connection until it
   presents a valid UCAN. A device holding only a link has no UCAN yet: its UCAN
   is inside the envelope it is trying to fetch. `uri-scheme.md` § Resolution
   flow says "fetch `manifest.json` + `attestation.json` from any peer" without
   saying how, before or around the gate.
2. **Identifiers disagree.** See Decide 1.
3. **Nothing handles `workspace://`** on any platform yet (workspace#236).

Whatever a link carries, **the admin still needs B's device key before B can
read**, because K0 is sealed to it. A link changes how the envelope travels,
not whether B's ID reaches the admin first — except in Option C, which moves
that exchange online.

---

## Decide 1 — the workspace id, the topic, and what the attestation signs

Today's implementation and the spec differ:

| | Spec | Implementation |
|---|---|---|
| `workspaceId` | multibase base58btc of the root key (`z6Mk…`) | hex of the root key |
| UCAN resource | `workspace://v1/<z…>` | `workspace://v1/<hex>` |
| Topic | SHA-256 of the root key bytes | SHA-256 of the string `workspace://<hex>` |
| `manifest.topicId` | present | absent |
| Attestation covers | `workspaceId`, `createdAt`, `formatVersion` | the same, not `logs` |

The key bytes are the same in both; only representation and derivation differ.

**Why it matters beyond tidiness.**

- A device following `uri-scheme.md` would derive a different topic from a link
  and find no one.
- `core/src/uri.ts` rejects hex identifiers.
- Log keys are not signed, so a tampered manifest can point a reader at other
  logs. A member holds K0 and could hand someone a folder whose manifest points
  at logs the member wrote; the reader would take them as the workspace's.
  Confidentiality holds; integrity does not.
- The spec's topic-layer revocation (`permissions-model.md` Lever 2) rotates the
  topic. A topic fixed by the root key cannot rotate; a topic named in a signed
  manifest can.

**Recommendation.**

1. Keep the id as the root key's bytes; write it as multibase `z…` everywhere
   it is serialised (manifest, UCAN resource, links), as the spec says. Readers
   accept hex for workspaces made before the change.
2. Put `topicId` in the manifest, initially SHA-256 of the root key bytes as the
   spec says, and join the manifest's topic rather than deriving one.
3. Sign `logs` and `topicId` in the attestation (`formatVersion: 1`). Readers
   verify version 0 attestations as today.
4. Pre-alpha, no migration of old workspaces: workspaces created before this
   keep working through the hex/version-0 read paths, and can be recreated.
   Workspaces the macOS app created have no stored root key, so they could not
   be re-signed anyway.

**Decide:** agree to 1–4, or keep hex and amend the spec instead.

---

## Decide 2 — how a link delivers the envelope

Three shapes. All reveal the workspace's public key to whoever holds the link.

### What any link reveals

A link names the root key, so anyone holding it can derive or learn the topic
and ask the DHT which addresses are announcing it: **the network addresses of
the members who are online.** `uri-scheme.md` § What can leak currently lists
"membership of the workspace" as not leaking; that is only true of *identities*,
not of addresses, and should say so. No content, K0, or UCAN leaks from the key
alone, and the gate refuses the connection.

### Option A — envelope in the link (spec § Reserved: targeted-envelope URIs)

```
workspace://v1/<z-root-key>/invite/<z-recipient>#<base64url envelope>
```

- The admin already has B's ID (as today) and puts B's envelope in the link, in
  the fragment so it is not sent anywhere a URL is logged.
- B's app verifies the envelope is addressed to B, validates the UCAN against
  the root key in the link, unwraps K0, joins the topic, and presents its UCAN at
  the gate like any member.
- **After** admission, the member it connected to sends the manifest and
  attestation on the authenticated channel (a `bootstrap` message on
  `workspace/auth@1`, or a second channel opened only after the gate). B checks
  the attestation against the root key from the link.
- **Nothing is served before the gate.** Forwarding the link gives others
  nothing: the envelope is sealed to B and the UCAN's audience is B.
- Cost: a long link. Measured: the UCAN is 473 bytes and the whole envelope
  base64url-encoded is about 1,240 characters, so a link is about 1.3 KB. Fine to
  paste; it fits a QR code, but a dense one.

### Option B — envelope fetched before the gate (`uri-scheme.md` as written)

```
workspace://v1/<z-root-key>/invite/<z-recipient>
```

- A new `workspace/bootstrap@1` channel that members answer **before** the gate,
  serving the manifest, the attestation, and the envelope whose recipient is the
  connection's Noise-proven key.
- Short links, but members answer unauthenticated connections, which widens what
  an attacker who has the key can do: probe whether an address holds an
  envelope, and exercise parsing code before the gate. Needs rate limits and a
  careful review of what the pre-gate manifest includes (log keys could be held
  back until admission).

### Option C — bearer invite, no device ID first (not in the spec)

- The link carries a one-time invite secret. B proves it holds the secret and
  sends its device ID; a member online at that moment seals and returns B's
  envelope. Holepunch's `blind-pairing` implements this pattern over HyperDHT
  (`createInvite`, `addMember`/`onadd`, `addCandidate`) for Autobase keys.
- Removes pasting a device ID, which is the friendliest shape.
- Requires a member, or a Lighthouse (`lighthouse.md`), online when B claims it;
  the invite must be single-use and expire, since whoever claims a forwarded link
  first gets in; and the admin-side "who may confirm" rule needs defining.

**QR codes:** Option A's link makes a dense QR code; Options B and C are short. If scanning a code is the main way people share, that favours C.

**Recommendation:** Option A for alpha. It keeps the gate the first thing a
connection meets, needs no new pre-authentication surface, and uses the envelope
and gate that already work. Record Option C as the next step for sharing without
exchanging IDs, and Option B as not planned unless short links become necessary.

**Decide:** A for alpha, and C after?

---

## Decide 3 — joining without being invited first

A device holding only the workspace's key cannot pass the gate. It could instead
*ask*: send its device ID and a message, have an admin's app show the request,
and have the admin accept (Share… for that ID) or ignore it. Asking grants
nothing, so it is not a confidentiality hole. What it changes:

- **Members answer strangers.** A request is received before the gate, which is
  the unauthenticated surface Option B also opens: rate limits, size limits, and
  `threat-model.md`'s "cannot join the swarm" would need restating.
- **A published key becomes a flood.** Anyone who finds the key can reach online
  members and fill the inbox.
- **A request says nothing about who sent it.** A device ID is a random key and a
  typed name is a claim anyone can make.

Ways to tell a wanted request from an unwanted one, strongest first:

1. **A code the admin sent.** A request carrying a valid single-use, expiring
   invite code is one the admin made possible. This is Option C: claiming the
   link *is* the request. Requests without a code are not accepted, so a bare
   key reaches no inbox.
2. **A spoken check.** Show words derived from the requesting device's key on
   both screens, confirmed over a call (as Signal's safety numbers do). Defeats a
   lookalike request.
3. **Devices already known** from other shared workspaces, shown by name.
4. **A self-described name**, only ever as a hint.

If a key leaks anyway, rotating the topic (possible once `topicId` is in the
signed manifest, Decide 1) moves current members to a topic the flood does not
know.

**Recommendation:** no requests from a bare key. "Without inviting first" is
Option C, single-use and expiring, optionally with the spoken check, approved by
an admin or a Lighthouse. An open "request access" mode for workspaces meant to
be public comes later, opt-in per workspace in `policy.json`, with rate limits
and topic rotation as its escape hatch.

**Decide:** agree, or open requests sooner?

## Decide 4 — one permission model for private and public

Private and public are not two kinds of workspace. They are the same workspace
model with different grants: public means a read grant to anyone.

This builds on what is already specified, not on a blank page:

- `workspace-format.md` § Permission semantics: per-file `read`/`edit`/`admin`
  for `.md` and `.canvas`; tier-gated content encrypted with tier keys
  delivered by UCAN; folder-level tiering conventions; a peer's access is the
  union of the keys its delegation chains grant; hidden schema entries for
  `.table/`.
- `table-file-format` `docs/PERMISSIONS.md`: two layers of keys (a Hypercore
  writer keypair decides who writes; symmetric tier keys decide who reads); one
  key and one set of roles per document; field-level tiers; Autobase for
  several writers; the key delivery log; the two revocation levers; MLS as the
  upgrade path for large groups; what metadata stays observable, and a
  separate restricted topic for documents whose existence is sensitive.

What follows adds public grants and publishing to that model, and says how
each action is enforced.

### What a grant does

A UCAN capability names an action on a scope: `document/read`,
`document/edit` or `document/publish`, on the whole workspace, a folder or a
file. The grant is the single statement of who may do what. Three mechanisms
make it true, because each action is enforced in a different place:

| Action | Enforced by | How |
|---|---|---|
| **Write** (edit, create, delete) | Every peer applying entries | With multiple writers, an entry is applied only if its author holds `document/edit` on its path (Autobase's apply step, ADR 0002). UCAN alone decides |
| **Publish** (make a scope public) | Every peer applying entries | Publishing is a write that requires `document/publish`, held by admins, so admins control what may become public; the chain records who published what |
| **Read** | Keys, and replication | Once ciphertext reaches a peer, only the keys it holds decide what it can decrypt. So each scope is encrypted with its own key, delivered only to devices whose UCAN grants read on it; and peers replicate a scope's blocks only to connections whose UCAN grants it, so a device without the grant never receives the ciphertext |

UCAN is the policy for all three. For reading, keys and replication are how the
policy holds on a device that has already received data.

### Public, in this model

- A **public scope** is a read grant to an "anyone" audience, whose key is
  published (in a link, or with a listing via `discovery.md`), and whose blocks
  peers replicate to any connection.
- A **public workspace** is a workspace whose root scope is public. A private
  workspace can contain public files, and a public workspace private folders.
- **Read-only versus editable** is which capability a device holds, in either.
- Every reader of a public scope can serve it to others, like a torrent peer; a
  Lighthouse keeps it available.
- Readers need nothing granted to them individually, so a public scope has no
  access-request inbox.
- Withdrawal is forward-only (rotate the scope's key and topic), as with any
  published file; the product answers this with messaging: confirm with the
  file's creator before publishing, and let admins restrict who may publish.
- Readers of a public scope can see each other's network addresses, since all
  announce the same topic. Worth saying in the UI.

### What is not yet specified, and not built

Specified above but not built: per-document keys and roles, tier keys, field
tiers, Autobase writers, key delivery scanning. Not yet specified anywhere:

1. **A public grant**: an "anyone" audience (or its equivalent outside UCAN),
   and a published key for a public scope.
2. **`publish`** as a capability admins hold, checked when entries are applied.
3. **A folder key hierarchy**: "folder-level tiering conventions" is named, not
   designed; holding a folder's key should yield the keys beneath it.
4. **Replication by scope**: the table permissions doc replicates all
   ciphertext to members and lets keys decide, with a separate restricted topic
   for documents whose existence is sensitive. Whether scopes should also
   restrict which cores a connection receives (#47) is open.

Built today: one key, one writer and one gate per workspace, so a member reads
everything and writes nothing.

**Prior art to study before designing 1 and 2:** Fission's WNFS (Webnative File
System) — public and private file trees in one filesystem, UCAN for write
authorisation, per-node keys for private reading. Not yet read closely here;
its key hierarchy is the part most likely to carry over.

**Recommendation:** adopt this single model as the direction. For alpha, ship
link invites (Option A) on today's one-scope workspace; specify items 1–4 next,
informed by WNFS, UCAN 1.0 and Ink & Switch's Keyhive and BeeKEM (research
under way); land capability-checked writes with multi-writer.

**Decide:** this model as the direction?

## Findings that settle three questions (14 Sep 2026)

Sources and detail: [`permissions-prior-art.md`](./permissions-prior-art.md), plus the Holepunch
sources cited here.

### Removing a writer while they write

Removal wins, and a write that landed during the removal is reverted: devices
recompute the view when Autobase's order settles. Two guardrails:

- **The cutoff is Autobase's signed order, not the writer's claim.** A removed
  writer's device can author entries that claim to predate the removal. An entry
  not in the indexer-signed order (`signedLength`) when the removal is signed is
  not applied.
- **No wall-clock checks inside `apply`.** UCAN expiry is checked when an entry is
  ingested, or by causal position, so every device computes the same view.

### Key rotation on removal

- The Holepunch stack has no group key agreement. Autobase encrypts with one base
  `encryptionKey`; blocks carry an encryption id and an internal encryption core
  holds key material per id, but there is no documented rotation call
  ([autobase `lib/encryption.js`](https://github.com/holepunchto/autobase/blob/main/lib/encryption.js),
  [README](https://github.com/holepunchto/autobase)). `hypercore-encryption` looks
  keys up by id ([README](https://github.com/holepunchto/hypercore-encryption)).
- Autopass, Holepunch's open-source app on Autobase and `blind-pairing`, hands
  invitees the shared encryption key and removes a member by removing their writer
  only; the key is not rotated
  ([index.js](https://github.com/holepunchto/autopass/blob/main/index.js)). Keet is
  closed source and was not checked.
- So the proven practice is "removal stops writing". Workspace goes one step
  further with the two levers `permissions-model.md` already describes, built from
  Hypercore primitives: a new key epoch (tagged by id) sealed to the remaining
  members, and topic rotation. MLS needs a commit sequencer (RFC 9420 §14) and
  BeeKEM is pre-alpha; neither is planned.

### UCAN version

- UCAN 1.0 is final (spec, delegation, invocation, 8 Jul 2026); revocation is
  1.0.0-rc.1. It is not tied to IPFS: tokens are DAG-CBOR with a Varsig header,
  verified offline.
- `iso-ucan` implements the 1.0 shape (`sub`, `cmd`, policies, delegations,
  invocations), latest 0.5.0 (Apr 2026), without a revocation module. `ucanto`
  still targets 0.9.1; its "Upgrade to UCAN 1.0" issue has been open since Mar 2024
  ([storacha/ucanto#345](https://github.com/storacha/ucanto/issues/345)).
- **Direction:** move `@workspace.sh/ucan-boundary` to `iso-ucan`, with capabilities
  as 1.0 commands (`/document/read`, `/document/edit`, `/document/publish`),
  subject the workspace root, scope in the policy; implement revocation to rc.1,
  stored inside the workspace.

## Implementation order (after the decisions)

1. Identifiers and attestation (Decide 1), with dual-read for existing folders.
2. Post-gate bootstrap message: a member sends the manifest and attestation to
   an admitted peer that lacks them.
3. Link encode/decode in `@workspace.sh/core` (`uri.ts` already parses the
   shape; add the envelope fragment).
4. Linux: Copy Invite Link next to Export Invitation…; a `workspace://` handler
   (`.desktop` `x-scheme-handler/workspace`) that opens the link.
5. A two-device smoke that joins from the link alone.

## Open questions

- After a topic rotation, how does a link holder find the new topic? A link made
  before rotation belongs to a member who is, by then, either still a member
  (and should learn the new topic through the key delivery log) or revoked (and
  should not).
- Per-workspace admission when one connection carries several workspaces (#47).
- Revocation: `isRevoked` is not wired yet (workspace-sh/workspace#433), so a
  link's UCAN is valid until it expires.

## Cross-references

- [`uri-scheme.md`](./uri-scheme.md) — link shape, resolution flow, what leaks
- [`workspace-format.md`](./workspace-format.md) — manifest, attestation, envelopes, distribution shapes
- [`permissions-model.md`](./permissions-model.md) — the gate, the two carriers, revocation levers
- [`identity-recovery.md`](./identity-recovery.md) — device linking uses the same envelope
- [`lighthouse.md`](./lighthouse.md) — an always-on member, for Option C
- [`many-workspaces.md`](./many-workspaces.md) — one runtime, many workspaces
