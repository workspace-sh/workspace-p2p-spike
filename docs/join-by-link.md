# Joining by link

**Status:** the join flow was decided on 15 Sep 2026. Anything marked
**default, pending a decision** is built that way until it is settled; anything
under [Proposals](#proposals-not-decided) is not built. Nothing here is
implemented except where it says so.

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
- **Step 3 by link.** A device holding only `workspace://v1/<id>` finds its own
  grant as a record on the DHT, presents it, and is welcomed — the folder is no
  longer needed to carry an envelope (Decide 2, workspace#507).
  `yarn p2p:smoke:two-device` proves both routes through the apps' own child
  processes over a private DHT.
- **Step 6** verifies every link's signature, the chain to the root, and that
  the capability names this workspace (workspace#430, #448). It also refuses a
  revoked device (workspace#433).
- **Asking to join.** A device with no grant opens a request, both screens show
  the same six digits, and an admin's Accept seals the envelope on the same
  channel (workspace#507, #510, #535). `yarn p2p:smoke:request-to-join`.
- **One identifier everywhere.** The manifest, the UCAN resource and a link all
  name the workspace by its root DID's multibase key, and the attestation signs
  the topic and the log keys (Decide 1, workspace#466).

- **Joining from an invite link.** A device holding
  `workspace://v1/<id>#invite=<code>` presents the secret on the request
  channel and is admitted with no code compared and nobody answering; a second
  claim of a single-use invite, a revoked one, and one nobody minted are each
  refused with their own reason (workspace#492).
  `yarn p2p:smoke:invite-link`.
- **Revoking a member**, and the gate refusing them at their next connection
  (workspace#433) — on every member, not only the admin: members keep the key
  delivery log downloading, so a connected member holds a revocation within
  moments (workspace#599). A revoked device that was connected reads its own
  revocation, and the apps say "Access revoked" (workspace#600, #602).
  `yarn p2p:smoke:revocation`.
- **Who is in, and how each got in.** The admin's device records each
  admission — by invite (which one), by request (the name typed, as the
  asker's claim) or by device ID — and lists members with it (workspace#577).
- **Asking to join into a sent folder.** A folder holding only this
  workspace's identity — what Export Folder… writes — can be asked into, so
  whoever receives it gets in without a new folder (workspace#594, #596).
- **All of it over IPC**, so the apps can reach it rather than only the SDK.
- **In both apps** (Linux and macOS): Copy Invite Link, Copy Workspace Link,
  Export Folder…, Share with Device ID… under Advanced, Requests to Join,
  Manage Invites with New Invite… for a reusable one, Members with Revoke
  Access…, and Ask to Join from a link or a folder (workspace#576–#602).

**Not built yet:** the requests flag in the grant index, and `workspace://`
handling by any platform (workspace#236).

## How a person joins (decided 15 Sep 2026)

Decided 15 Sep 2026. It replaces copying a device ID to the admin as the
normal way in. The Device ID dialog stays as an advanced
option. One link for everyone, and grants on the DHT (Decide 2), remain the
mechanism underneath: an invite or a request ends in exactly the grant, gate
and welcome that already work.

| Step | Admin | Joiner |
|---|---|---|
| 1 | Creates the workspace | — |
| 2 | Shares an **invite link** (default), the **workspace link**, or the folder | — |
| 3 | — | Opens what they were sent. An invite link is claimed automatically. A workspace link or folder without access shows "You don't have access" and **Ask to join** |
| 4 | An invite is admitted automatically, within its limits. A request shows "'<name>' wants to join, code 482 913"; the admin checks the code with the joiner over a channel they already share (email, SMS, IM) and taps **Accept** | Shows the same code |
| 5 | — | Access arrives; the workspace opens and syncs |

### Links

An invite is an optional fragment on the unchanged workspace link:

```
workspace://v1/<id>                  names the workspace, grants nothing
workspace://v1/<id>#invite=<code>    the same link, plus a bearer invite
```

- **Stripping the fragment** leaves the plain link.
- **Out of transit:** a fragment isn't sent to any server a URL passes through.
- **One parser:** links are parsed in one place, so the pairing survives a change to the part before the fragment (spike #59, z-base-32 ids in the host position).
- **The code** (decided 19 Sep 2026): a random 32-byte secret in z-base-32, the
  alphabet Holepunch writes keys in — it drops the characters an eye slips on
  (`0`/`O`, `1`/`l`/`I`), which matters for something a person may read aloud or
  retype.
  - 32 bytes is 52 characters, and a whole invite link about 120.
  - The encoding is strict about canonical spelling: a trailing group whose
    padding bits are not zero is refused, so one invite cannot be written
    several ways when only one of them was ever hashed.

### Share options

- **Copy Invite Link** (default)
- **Copy Workspace Link**
- **Export Folder…**: no invite inside; a folder grants nothing by itself
- **Share with Device ID…** (advanced): today's flow, sealing to a pasted ID
- **Allow requests to join:** a per-workspace switch

### Decided defaults

| Question | Decision (15 Sep 2026) |
|---|---|
| Invites | Single-use, expiring after 7 days ("yes!"). A reusable invite when the admin asks for one: 1, 5 or 25 uses, lasting 1, 7 or 30 days, and nothing past that — a bearer link's limits are its blast radius (built, workspace#587, #590) |
| Requests | Off until the admin turns them on, per workspace ("sure!") |
| Who admits | Admins only, for now ("okay!"). Delegating to members or a Lighthouse comes later |

Parked: a folder carrying an invite ("park this thinking").

### Claiming an invite

An invite is carried on the **same request channel an access request uses**,
not on a pairing library of its own (decided 19 Sep 2026; the earlier draft of
this section specified Holepunch's `blind-pairing`).

The reasoning, because the earlier choice was not a bad one. `blind-pairing`
would have brought a tested implementation and one real property this does not
have: the two devices meet at an address derived from the invite secret, so an
observer cannot tell which workspace is being joined. But that privacy win
covers only invite links — an access request still meets on a topic derived
from the workspace's own root key, so adopting it here would have fixed one of
two doors while adding a second way to be admitted and a dependency to carry.
Blinded discovery is worth having; it is worth having for *both* entry points,
as its own decision, and the rendezvous below is deliberately the only layer it
would replace.

1. **The admin's device mints the invite.** A random 32-byte secret. The device
   stores SHA-256(secret) with `{ expires, usesLeft, revoked }` in its own data
   directory, never in the folder — the folder is the thing people copy.
   - It never stores the secret, so a store that leaks cannot mint a working
     link, and Copy Invite Link always makes a new invite.
   - The link carries the secret as z-base-32, 52 characters.
2. **The admin's device answers claims** while it holds any invite that is
   unexpired, unspent and unrevoked — independently of whether *access
   requests* are on. They are two doors, and a person who has handed out a link
   has not thereby invited strangers to ask.
3. **The joiner claims.** On `workspace/request@1`, it sends
   `{ name, secret }` — a `claim` message beside `ask`. The Noise connection
   has already proved the joiner's device key, which is what the envelope is
   sealed to.
4. **The admin's device** looks the secret's hash up in its store, checks the
   invite is unrevoked, unexpired and has uses left, spends a use, runs
   `invite(deviceDid)`, and sends the sealed envelope as the same `grant`
   message an accepted request uses.
5. **The joiner** validates the envelope's UCAN against the link's root and
   unwraps K0, then joins as a device with a grant: topic, gate, welcome —
   the identical tail.

No code is compared, and that is the difference between being invited and
asking: possession of the secret is the whole claim. Without it nothing
happens, because nothing in the store matches. A leaked invite admits whoever
claims it first, once, within 7 days.

**Single use earns its default.** A bearer link has no human checkpoint the way
an access request does, so the limits *are* the blast radius. Single use also
means a link claimed by the wrong person makes the intended recipient's claim
fail — the mistake announces itself instead of passing unnoticed.

**Refusals.** Unlike a declined access request — which is told nothing at all,
deliberately — a refused claim says which kind of no it is. The holder is
usually the person who was meant to have it, and the difference between asking
for another link and deciding the app is broken is worth more than what it
concedes: that a secret they already hold was once real.

| Invite | Joiner sees |
|---|---|
| Not in the store | "This invite has expired." — an invite forgotten after lapsing and one that never existed are indistinguishable, and read the same |
| Expired | "This invite has expired." |
| Used | "This invite has already been used." |
| Revoked | "This invite was revoked." |

Each message ends "Ask for a new one."

**Revoked beats expired beats spent**, so an admin who took an invite back is
told that, whatever else has since become true of it.

**Why an invite nobody ever minted reads "expired".** It looks like a bug —
someone who mistyped a link is told it lapsed — and it is deliberate, for two
reasons of different weight:

- The main one is correctness. A spent or revoked invite is kept only until it
  expires, then forgotten. After that, an invite that was real and lapsed is
  indistinguishable from one that never existed, and the true thing to tell
  its holder is that it expired. A separate "no such invite" message would be
  shown to exactly the people it is wrong for.
- The lesser one is that an invented string gets no confirmation it was never
  real. That is worth little on its own — a secret is 32 random bytes, and
  nobody finds a live one by guessing — but it costs nothing, where the
  opposite would make every refusal a small oracle.

What a refusal *does* concede is stated plainly elsewhere and is the point:
"used" and "revoked" confirm that a secret the holder already has was once
real. That is the price of telling the intended recipient something useful,
and it is only ever paid to someone who holds the secret.

Every row of that table is covered by `yarn p2p:smoke:invite-link`, against a
live DHT rather than a fake channel — a refusal that is computed correctly and
never reaches the wire looks exactly like one that works.

A spent or revoked record is **kept until it expires**, so the device can still
say which no it is; dropping it the moment it was spent would answer "expired"
to the person who just used it. Only expiry makes a record worthless.

**Only the creating device admits.** The invite store is on the device that made the invite, so that device has to be online for the claim to complete, even if the workspace has other admin devices.

### What the joiner sees

| Opens | Sees |
|---|---|
| An invite link | "Joining…", then the workspace opens and syncs |
| An invite link, admin's device offline | "Waiting for an admin to come online". This is a waiting state, not an error (default, pending a decision). The claim stays open and retries while the app runs |
| An expired, used or revoked invite | The refusal above |
| A workspace link, with a grant, no member online | "Waiting for someone in the workspace to come online", until a member comes online or the person cancels |
| A workspace link or folder, as a member | It opens |
| A workspace link or folder, not a member | "You don't have access to this workspace. Ask the person who shared it for an invite link.", plus **Ask to Join** |
| An ask nobody accepts | After the request expires (10 minutes): "Not let in", and nothing about why |

Until the requests flag exists (below), the apps cannot tell "requests off"
from "no admin online", so they offer **Ask to Join** whenever a link or
folder gives no access. A declined, ignored and unanswered request all end
the same way, which is the point: a stranger is not told which.

- **No name in a link.** Before admission the app knows only the folder name the joiner chose, or the folder's own name. A name carried in a link would be unverified text from whoever wrote the link.
- **Progress and cancel.** A join reports its stages over IPC and can be cancelled (workspace#499): `finding-grant`, `connecting`, `waiting-for-member` (after 5 s with no member), `opening`. With the grant found, an app waits for a member until the person cancels.
  - Claiming an invite and asking report their own stages instead:
    `finding-admin`, `waiting-for-admin`, `asked`, `accepted`.

### Requesting access

A request has no invite to present, so it opens with a conversation instead of
a secret. Both entry points share this one channel: what the joiner sends —
`ask` or `claim` — is what decides which it is.

1. **Where requests go.** An admin device with requests turned on joins a request topic, SHA-256(`"workspace requests\0"` ‖ root key). Members who aren't admins never join it, so they never answer strangers.
2. **The request.** On a Protomux channel `workspace/request@1`, the joiner's device sends `{ name, commitment }` over the Noise connection, which proves the joiner's device key.
   - `name` is at most 64 characters.
   - `commitment` = SHA-256(`nR`), for a random 32-byte `nR`.
3. **The exchange.** The admin's device replies `{ nA }`, a random 32-byte nonce. The joiner reveals `nR`, and the admin checks it against the commitment.
4. **The code.** Both devices show the same code: the first 20 bits of SHA-256(`"workspace join code\0"` ‖ workspace id ‖ joiner key ‖ admin key ‖ `nR` ‖ `nA`), as 6 digits.
5. **Accept.** It runs `invite(deviceDid)` for the joiner's key and sends the sealed envelope on the same channel. Ignore or Decline sends nothing.
   - **Let the grant reach the wire before closing.** Sending and then
     destroying the connection in the same tick loses the write — the one
     message on this channel that must arrive. Accept waits briefly before
     ending the request; Decline and expiry send nothing and need no wait.
     Every test against a fake channel passed with this wrong; only a live DHT
     showed it (workspace#535).

**Why commit-then-reveal.** A 6-digit code is 20 bits. Without the commitment, someone between the two devices could try keys until the codes on both sides match, about a million tries, which takes seconds. With it, each side's nonce is fixed before the other's is seen, so there is nothing to grind. This is how Bluetooth numeric comparison and ZRTP make short codes safe.

**Limits:**
- one pending request per device key;
- a few requests a minute per remote address;
- requests expire after 10 minutes;
- the inbox holds at most 20.

A request grants nothing until Accept.

**Requests and the gate.** A request is heard without its device being let in:

1. **Topics.** An admin's device with requests on announces the request topic, `swarm.join(topic, { server: true, client: false })`. An asking device looks it up, `{ server: false, client: true }`. Hyperswarm keeps one connection per pair of devices whichever topic found it, so the gate can't tell a request's connection from a member's by topic; what the peer sends decides.
2. **No proof, no auth message.** A device without a grant sends nothing on `workspace/auth@1`. Today it sends an empty proof, which a member refuses at once, closing the connection before a request could open.
3. **Pairing.** A runtime pairs `workspace/request@1` only while its workspace has requests on. Otherwise Protomux refuses the channel and the auth timeout drops the connection, as it does today.
4. **An open request.** When a peer opens the request channel before presenting a proof, its auth timeout is replaced by the request's 10-minute expiry, and the request goes to the inbox under its limits. The connection is never admitted: nothing replicates and it isn't counted as a peer. Accept sends the envelope on the channel; Accept, Decline and expiry each close the connection.
5. **After Accept.** The asking device connects again on the workspace topic as a member, presenting the UCAN from its envelope.
   - **The second connection is scoped to the workspace**, exactly as an
     ordinary join is. A device sharing one connection across several
     workspaces names each one's membership exchange on its own Protomux
     channel; a runtime that omits the scope opens the unnamed channel while
     the admin, which has one, opens the named one, and the two never complete
     an exchange over the connection they do make. The symptom is a timeout
     that says nobody is online while both devices are online and reachable
     (workspace#536).
   - It also **keeps looking** rather than resting on one DHT lookup, for the
     same reason an ordinary join does (workspace#505).
6. **Trust.** The asking device doesn't need to verify who answered. The compared code binds both device keys, and it accepts an envelope only if the UCAN inside validates to the link's root.

**Requests on or off.** With no admin online, "requests off" and "admin offline" look the same: nobody is on the request topic. So the grant index, which the root signs and a joiner already reads to find its grant, carries a flag saying whether requests are on. A joiner with no grant reads the flag and shows **Ask to Join** only when it's set.

> **Specified, not built.** The grant index carries no such flag today, so the
> two cases are still conflated: an ask that finds nobody fails with one
> message covering "requests are off", "no admin is online" and "the admin did
> not answer in time". That message is deliberately vague rather than wrong,
> but it is the wrong shape — it cannot tell a person whether waiting would
> help. The flag is what fixes it.

### Constraints

- **Nothing server-side.** The admitting device is online when a join completes.
- **The gate, grant and welcome are unchanged.** Invites and requests only decide when `invite(deviceDid)` runs.

### Proposals, not decided

These are not decided, and aren't built.

| Proposal | What it adds | Recommended |
|---|---|---|
| **Send Invite…** on a request | An action next to Accept and Decline. The system share sheet sends a single-use invite link to a contact the admin already knows. The code comparison stays | Yes |
| **Known devices** | A local store of device keys with names the admin gave them. A request from a known device shows the admin's name for it, never the requester's | Yes |
| **Request token** | `#request=<token>` on the plain link. It isn't secret; resetting it cuts off a leaked link without rotating the topic | Yes |
| **Vouching** | A member relays a request and says who it is | Later |
| **Proof-of-work** on requests | Makes each request cost the sender | No, unless spam is seen |
| **QR codes** | Either link as a QR code, for sharing in person | Yes |
| **Export `.workspace/` only** | Export Folder… offers the whole folder or `.workspace/` alone | Yes |

## Decide 1 — the workspace id, the topic, and what the attestation signs

**Decided** (14 Sep 2026) and built in workspace-sh/workspace#466:

- **Id.** `workspaceId` is the root DID's multibase key (`z6Mk…`), as
  `uri-scheme.md` says. The manifest, the UCAN resource (`workspace://v1/<z…>`)
  and links use it. A reader refuses a manifest whose id is not its root's key.
- **Topic.** `manifest.topicId` is SHA-256 of the root's 32-byte public key for
  a new workspace, the topic a link holder derives. Peers join the topic the
  manifest names, so the topic can rotate (`permissions-model.md` Lever 2)
  without the id changing.
- **Attestation.** It signs `topicId` and `logs` with `workspaceId`,
  `createdAt` and `formatVersion`. A manifest pointing at other logs or another
  topic is refused, so a member cannot hand someone a folder whose manifest
  points at logs the member wrote.
- **Format 2, no migration.** Workspace is pre-alpha; folders made before are
  refused with a message to recreate them.

The spec records the result in `workspace-format.md` § manifest.json and
§ attestation.json (#56).

## Decide 2 — one link for everyone

**Decided** (15 Sep 2026): every member shares the same link,
`workspace://v1/<root key>`, the way a Google Workspace URL is shared. Who gets
in depends on the device that opens it:

| Google Workspace | Here |
|---|---|
| signed in as a person | the device's key, proven in the Noise handshake |
| "shared with you" | the device claimed an invite, had a request accepted, or was shared with by device ID: a sealed grant exists for it |
| "you don't have access" | no grant for this key (asking for access is Decide 3) |

### How a device finds its grant: records on the DHT

Members never answer a device that has not passed the gate. The grant travels
as HyperDHT records instead:

1. **The grant.** The envelope's UCAN and wrapped key, binary-encoded, published
   with `immutablePut`. Its address is the hash of its bytes.
2. **The index.** A list of `(tag, grant hash)` pairs, published with
   `mutablePut` under the **root key itself**. The DHT stores a mutable record
   only with a valid signature from that key, so a record fetched at the id in
   the link is the owner's.
   `tag` = the first 16 bytes of SHA-256(`"workspace grant\0"` ‖ root key ‖
   device key).
3. **Joining.**
   - From the link, the device takes the root key, fetches the index and looks
     for its own tag.
   - It fetches the grant by hash, validates the UCAN against the root DID, and
     unwraps K0.
   - It then joins the topic (SHA-256 of the root key) and presents its UCAN at
     the gate like any member.
   - The member it connects to sends the manifest and attestation after
     admission.

**Measured.**
- On a local testnet, a device holding only the link and its seed found its
  grant, validated the UCAN and recovered K0. A device with no grant found no
  tag, and a copied grant was refused: "envelope UCAN audience mismatch".
- On the public DHT, from a home connection, records of up to 1,300 bytes
  stored and fetched; 1,400 bytes timed out.
- A grant is 507 bytes and an index entry 48 bytes, so a 1,000-byte index
  holds about 20 pending grants.

**Keeping records alive.**
- DHT nodes keep records for up to 48 hours. An online member re-publishes the
  index and grants well inside that.
- Anyone can refresh a signed mutable record or an immutable one without the
  root key.
- An entry leaves the index once its device has joined.

**What the records reveal** to anyone holding the link:
- the number of pending grants;
- for a device key someone already knows, whether it has a pending grant.

No grant opens for any key but its recipient's. The link itself already reveals
the addresses of members who are online, through the topic.

**When records are unavailable,** members answer one question before the gate:
"is there a grant sealed to the key you just proved?" It is rate-limited and
serves nothing else.

**Inviting someone whose device ID you do not have** is an invite link, the
normal way in since 15 Sep 2026 (see [How a person joins](#how-a-person-joins-decided-15-sep-2026)).

## Decide 3 — joining without being invited first

**Decided** (15 Sep 2026): a device can ask to join.
- Requests are off until an admin turns them on for the workspace.
- A request is confirmed by a code both screens show and the two people compare over a channel they already share.
- An invite link is the other way in without an admin knowing the device first.

Both are specified under [How a person joins](#how-a-person-joins-decided-15-sep-2026).

A request grants nothing. It is rate-limited, size-capped and expiring, and the inbox is capped. Only admins' devices listen for requests, on a topic of their own, so members never answer strangers. If a workspace's key leaks anyway, rotating the topic (Decide 1) moves members to a topic the flood does not know.

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
one link for everyone (Decide 2) on today's one-scope workspace; specify items 1–4 next,
informed by WNFS, UCAN 1.0 and Ink & Switch's Keyhive and BeeKEM (research
under way); land capability-checked writes with multi-writer.

**Decide:** this model as the direction?

## Findings that settle three questions (14 Sep 2026)

Sources and detail: [`permissions-prior-art.md`](./permissions-prior-art.md), plus the Holepunch
sources cited here.

### Removing a writer while they write

An entry from a writer who is being removed is treated by where it falls in
Autobase's settled order:

| Entry | Outcome |
|---|---|
| Before the removal | Applied |
| After the removal | Never applied |
| Concurrent with the removal | **Held for review.** An admin keeps it (applied) or reverts it; the data may be useful and the writer not malicious |

- **The review decision is an entry**, appended by someone holding the capability to
  make it, so every device computes the same document.
- **While held:** hidden from the document and listed for admins to review; "keep"
  is an admin entry that applies it. Decided (14 Sep 2026) as the simplest
  to build. Showing held entries with a marker until reverted is in the backlog
  (#54).
- **"Concurrent" is decided by Autobase's signed order, not the writer's claim.** A
  removed writer's device can author entries that claim to predate the removal; an
  entry not in the indexer-signed order (`signedLength`) when the removal is signed
  is concurrent at best, never "before".
- **No wall-clock checks inside `apply`.** UCAN expiry is checked when an entry is
  ingested, or by causal position, so every device computes the same view.
- Keyhive takes the same shape: operations by later-revoked authors stay in the
  history and pass through a visibility index.

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
- So the proven practice is "removal stops writing". Workspace locks a removed
  device out:
  1. **The gate refuses it.** Data flows only between online peers that admit each
     other, so once members hold the revocation (workspace-sh/workspace#433) the
     removed device receives nothing new from them. This is the lock.
  2. **A new key epoch** (tagged by id) sealed to the remaining members, and **topic
     rotation**, as `permissions-model.md` describes. These cover new data reaching
     the removed device another way: a member device that has not yet synced the
     revocation, or a folder copied afterwards. Later than 1.

  MLS needs a commit sequencer (RFC 9420 §14) and BeeKEM is pre-alpha; neither is
  planned.

### UCAN version

- UCAN 1.0 is final (spec, delegation, invocation, 8 Jul 2026); revocation is
  1.0.0-rc.1. It is not tied to IPFS: tokens are DAG-CBOR with a Varsig header,
  verified offline.
- `iso-ucan` implements the 1.0 shape (`sub`, `cmd`, policies, delegations,
  invocations), latest 0.5.0 (Apr 2026), without a revocation module. `ucanto`
  still targets 0.9.1; its "Upgrade to UCAN 1.0" issue has been open since Mar 2024
  ([storacha/ucanto#345](https://github.com/storacha/ucanto/issues/345)).
- **Done:** `@workspace.sh/ucan-boundary` runs on `iso-ucan` (workspace#462; ADR
  0001 records why): subject the workspace root, the resource in the policy.
  Every grant is still `/workspace/read`.
- **Still to do:** capabilities as 1.0 commands (`/document/read`,
  `/document/edit`, `/document/publish`) with scope in the policy, and
  revocation in the rc.1 shape, stored inside the workspace.

## Implementation order (after the decisions)

1. ~~Identifiers and attestation (Decide 1)~~: done, workspace#466.
Built through step 10 except where marked.

2. Grant records: binary grant and index encoding (`portable-bootstrap`),
   record put/get on the runtime (`p2p-runtime`), `invite` publishing and an
   online member refreshing (`workspace`).
3. Post-gate bootstrap message: a member sends the manifest and attestation to
   an admitted peer that lacks them.
4. Join by link: `workspace` resolves a link to a folder (grant, topic, gate,
   bootstrap); IPC method; Linux Copy Link on Share…, and a `workspace://`
   handler (`.desktop` `x-scheme-handler/workspace`; the handler is **not
   built**, workspace#236).
5. A two-device smoke that joins from the link alone.
6. Links parsed in one place: the workspace link, `#invite=`, and z-base-32 (workspace#498).
7. Join progress and cancel over IPC, with the joiner's states above (workspace#499).
8. Access requests (workspace#493). These need no new dependency:
   - the request topic and `workspace/request@1` channel;
   - the commit-then-reveal code and the limits;
   - the requests flag in the grant index (**not built**);
   - the admin's inbox with Accept and Decline;
   - a smoke where a request is accepted after comparing codes.
9. Invite links (workspace#492), on the request channel step 8 builds:
   - the invite secret and the `claim` message (workspace#541, merged);
   - the invite store on the admin's device (workspace#544, merged);
   - wiring the claim to the inbox, and its refusals;
   - a smoke where a device joins from an invite link alone.
10. Share options in each app (workspace#494–#496):
    - Copy Invite Link (default), Copy Workspace Link and Export Folder…;
    - Share with Device ID… (advanced);
    - Allow requests to join.

## Open questions

- After a topic rotation, how does a link holder find the new topic? A link made
  before rotation belongs to a member who is, by then, either still a member
  (and should learn the new topic through the key delivery log) or revoked (and
  should not).
- Per-workspace admission when one connection carries several workspaces (#47).
- Revocation is enforced at every member's gate (workspace#433, #549, #599),
  but a device revoked while offline never learns it: every member refuses it,
  so there is nobody to read the revocation from.

## Cross-references

- [`uri-scheme.md`](./uri-scheme.md) — link shape, resolution flow, what leaks
- [`workspace-format.md`](./workspace-format.md) — manifest, attestation, envelopes, distribution shapes
- [`permissions-model.md`](./permissions-model.md) — the gate, the two carriers, revocation levers
- [`identity-recovery.md`](./identity-recovery.md) — device linking uses the same envelope
- [`lighthouse.md`](./lighthouse.md) — an always-on member, for bearer invites
- [`many-workspaces.md`](./many-workspaces.md) — one runtime, many workspaces
