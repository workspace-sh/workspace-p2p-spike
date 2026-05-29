# Permissions Model — Hypercore + UCAN + Autobase

The technical design for Workspace's P2P permission model. This is the
spike-side companion to
[`table-file-format/docs/PERMISSIONS.md`](https://github.com/workspace-sh/table-file-format/blob/develop/docs/PERMISSIONS.md),
which is the consumer-facing view. This document captures the
underlying cryptographic and protocol choices.

**Status:** design + partial implementation. The wrap primitive, UCAN
boundary module, root attestation primitive, and bootstrap envelope
flow are implemented (`@workspace/p2p-runtime`, `@workspace/ucan-boundary`,
`@workspace/portable-bootstrap`). The live key delivery log (#9),
topic-layer auth at the noise handshake (#10), and the Autobase
multi-writer wrapper (#11) remain to be built. Tracked in
[issue #5](https://github.com/workspace-sh/workspace-p2p-spike/issues/5).

---

## Goals

- Encrypt data at rest and in transit, with **per-tier** access within a
  single document (e.g. an employee's salary and team name in the same
  record, readable by different sets of peers).
- Distribute keys peer-to-peer with **no required third-party
  infrastructure**. Self-hosted relays for NAT traversal are acceptable
  and expected; data and key paths must not require them.
- Support **multi-writer collaboration** (Alice edits her own contact
  info; HR edits salary; manager edits notes) without a central writer.
- Support **forward-only revocation** honestly. Once a peer has received
  and decrypted data, that exposure is accepted; revocation prevents
  access to future data.
- Stay **standards-aligned** for identity and capability tokens:
  `did:key:z6Mk…` ed25519, UCAN delegation, IETF MLS as an upgrade path.

---

## Two layers of keys

Every document uses two unrelated kinds of cryptographic key. Conflating
them is the most common source of confusion in this design.

### Layer 1 — Hypercore writer keypair (ed25519)

- Generated when the log is created
- **Public half** = the log's 32-byte address; the discovery handle
- **Secret half** = held only by the writer; signs each appended block
- Replication: peers exchange blocks based purely on the public address;
  no content inspection
- Determines **who can write** and **how the log is discovered**

### Layer 2 — symmetric encryption keys (`K0`, `K1`, `K2`, …)

- Independent of the Hypercore keypair
- AES-256 (or equivalent) symmetric keys
- Used to encrypt the *contents* of blocks before they're appended
- Multiple tiers coexist in one log: different fields encrypted with
  different keys
- Distributed peer-to-peer via UCAN delegation + wrapped key blobs
- Determines **who can read what**

A block on disk:

```
[ block header — signed with Hypercore writer secret key ]
[ block body   — ciphertext( contents, encrypted with K_n ) ]
```

Replication checks the signature. Decryption uses the symmetric key.
**Two independent gates.**

---

## Multi-writer — Autobase

A single Hypercore has exactly one writer. The employee database
requires multiple writers; this is what **Autobase** is for.

- Each contributing peer keeps their own Hypercore log of edits
- The "document" is a *merged view* computed locally on every peer
- Conflict resolution is configurable (LWW by timestamp, custom, or
  CRDTs on top)

```
Alice's edits  → Hypercore A  ┐
HR's edits     → Hypercore H  ├── Autobase merge → "Alice's current record"
Manager's edits→ Hypercore B  ┘
```

Encryption tiers still apply: each writer encrypts their fields with
the appropriate `K_n` before appending to their own log.

Autobase is part of the Holepunch stack, in production at Keet. Same
DHT, same Hyperswarm, no central server. Validated as the answer for
multi-writer; not yet spiked in this repo.

---

## Key distribution — UCAN + wrapped keys

UCAN delegations and the symmetric keys they authorise are *two
different artefacts*. Conflating them is the second most common source
of confusion in this design.

### What UCAN carries

A signed capability token:

> *"Issued by `did:key:zABC…` (admin), the peer `did:key:zXYZ…` (new
> employee) is authorised to access resource `<log-address>` at tier
> `K1`."*

UCANs are short-lived, chainable, verifiable offline. They carry
**authorisation**, not the key itself.

### How the symmetric key actually arrives

Delivered as a **wrapped key blob**: the key material encrypted to the
recipient's ed25519 public key via X25519 ECDH. Only the recipient's
matching secret key can unwrap it.

Each delivery is one self-contained payload:

```
{
  ucan:        <signed delegation token>,
  wrapped_key: <symmetric key, sealed to recipient's public key>,
  resource:    <hypercore log address this key applies to>
}
```

### Two carriers — bundled envelopes and the live key delivery log

The same payload shape travels two ways, picked by context:

#### Carrier 1 — Bundled envelopes (offline first-contact)

Inside the `.workspace` bundle itself: `.workspace/envelopes/` holds
one envelope per intended recipient, sealed to their DID. When the
bundle is delivered offline (USB stick, AirDrop, email attachment,
even just dragged into a shared folder), the recipient's app finds
their envelope locally and unwraps the keys without needing to be
online with the original sender.

Implemented in `@workspace/portable-bootstrap`. Used when:

- Inviting a new member who is not yet on the swarm
- Distributing a workspace snapshot via offline channels
- First-contact delivery, where neither sender nor recipient may be
  online simultaneously

See [`workspace-format.md`](./workspace-format.md) for the on-disk
shape.

#### Carrier 2 — Live key delivery Hypercore log (steady-state churn)

A "key delivery" Hypercore log replicated to every workspace member.
Each block is one delivery payload addressed to one peer's DID. New
invites, key rotations, and ongoing membership changes ride this
channel. Peers scan from their last-seen position for blocks
addressed to them, unwrap, and ignore the rest.

```
Key delivery Hypercore log (replicated to all org peers):

Block 0: { kind: "workspace/key-delivery@1", envelope: { recipient: zABC…, ucan, wrappedKey, … } }
Block 1: { kind: "workspace/key-delivery@1", envelope: { recipient: zDEF…, ucan, wrappedKey, … } }
Block 2: <revocation block — see Revocation below>
...
```

Each block is a tagged record. The `kind` tag lets the log carry more
than key deliveries later (revocation blocks the obvious next variant);
scanners skip records of a `kind` they don't recognise. The `envelope`
is byte-identical to a bundle envelope — same `createEnvelope` produces
it, same `consumeEnvelope` validates and unwraps it.

**Implemented** in `@workspace/portable-bootstrap`
([#9](https://github.com/workspace-sh/workspace-p2p-spike/issues/9)):
`publishDelivery(log, envelope)` appends; `scanDeliveries(log, {selfDid,
selfSecretKey, rootDid, fromCursor})` reads from a cursor, returns the
deliveries addressed to this peer (validated + unwrapped) plus a new
cursor to resume from. A block that fails validation routes to an
`onError` callback rather than aborting the scan — deliveries arrive
over time and one bad block shouldn't blind a peer to the rest.

Used when:

- An admin invites someone after the workspace is already live
- Tier keys rotate (e.g. after a departure)
- Existing members need new envelopes (a new tier is created, an
  existing tier's key is rotated)

#### Properties shared by both carriers

- Sender and recipient never need to be online simultaneously
- No central infrastructure — both rest on Hypercore replication
- Wrapped key blobs are tiny (~100 bytes each)
- Same `wrap` primitive, same UCAN format, same validation rules

The choice of carrier is transport-only. The payload, the
cryptographic guarantees, and the recipient's local handling are
identical.

---

## Worked example — 54-person org

> 1 admin, 3 managers, 50 employees, with HR as a separate role.

### Keys

```
K0_org         — 1 key,  all 54 people hold it
K1_<manager>   — 1 key per manager, 3 total
K2_<employee>  — 1 key per employee, 50 total
─────────────────────────────────────────────
54 symmetric keys
```

Admin is the peer who issued all the others; "admin" is a role, not a
separate key tier.

### Who holds what

| Role     | Keys held                          | Can read                                                        |
|----------|------------------------------------|-----------------------------------------------------------------|
| Admin    | `K0_org` + all `K1`s + all `K2`s   | Everything, for everyone                                        |
| Manager  | `K0_org` + `K1_<self>`             | Public info (everyone's) + sensitive info (own reports only)    |
| Employee | `K0_org` + `K2_<self>`             | Public info (everyone's) + own private info                     |
| HR       | `K0_org` + all `K2`s               | Public info (everyone's) + private info (everyone's)            |

### Lifecycle events

**New employee joins:**
1. Admin issues UCAN+wrapped-`K0_org` to new employee → key delivery log
2. Admin issues UCAN+wrapped-`K2_<new_employee>` to new employee
3. Admin issues UCAN+wrapped-`K2_<new_employee>` to HR

Three UCANs, three wrapped keys. New employee's manager already holds
the relevant `K1` — no extra work there.

**Manager leaves:**
1. Rotate `K1_<departing_manager>` — generate `K1_v2` for future writes
2. Issue UCAN+wrapped-`K1_v2` to the replacement manager (and admin)
3. Drop the departing peer from the Hyperswarm topic (topic-layer
   revocation, see below)
4. Historical tier-1 blocks remain encrypted with the old `K1` — the
   departing manager still has the old key on their device but no
   forward access

**Employee leaves:**
1. Optionally rotate `K2_<departing_employee>` for new HR members later
2. Drop them from the Hyperswarm topic
3. Their device retains historical keys; this is the accepted contract

---

## Revocation — two levers

Revocation is forward-only at every layer. What an ex-peer already
received cannot be unsent. The design provides two independent levers
to control what they receive next.

### Lever 1 — Encryption-layer

- The departing peer's UCAN is invalidated.
- The affected symmetric key is **rotated for future writes**. New
  blocks use a fresh key, distributed via the key delivery log.
- Past blocks remain encrypted with the previous key — Hypercore is
  append-only; we cannot "re-encrypt history."
- The departing peer retains the old key locally; can still decrypt
  historical blocks they had previously replicated; cannot decrypt any
  new writes.

### Lever 2 — Topic-layer

Even without decryption, a peer who knows the Hypercore public
addresses and the Hyperswarm topic identifier can:
- Connect to the swarm
- Observe block arrival timing, log lengths, write patterns
- Identify writers (with Autobase)

To close this lever:
1. Drop the departing peer from the Hyperswarm topic via connection-time
   authentication — org peers reject connections from peers that cannot
   present a current valid UCAN proving org membership.
2. Rotate the topic identifier alongside `K0_org` on departure to
   invalidate the discoverability path entirely.

**Encryption alone is not sufficient for full post-departure revocation.
Topic membership is the second lever** — network-layer access, distinct
from encryption-layer access.

### Revocation notice block on the key delivery log

When a peer is revoked, an admin appends a signed **revocation block**
to the key delivery log:

```json
{
  "kind": "revocation",
  "subject": "did:key:zMarco…",
  "revokedAt": 1717200000,
  "issuer": "did:key:zLeslie…",
  "signature": "<base64-ed25519-signature>"
}
```

Signed by the issuer (an admin with revoke capability over the
subject's chain). Replicated to all peers. The subject's app sees
the block on next sync, reads the workspace's
[`.workspace/policy.json`](./workspace-format.md), and runs whatever
cleanup the policy declares.

This is **cooperative-client behaviour** — a hint to well-behaved
apps, not a cryptographic enforcement. A modified client can ignore
the revocation notice. The cryptographic levers (key rotation,
topic-layer rejection) carry the actual security load. See
[`threat-model.md`](./threat-model.md) for the contract.

The revocation block being part of the replicated log means a
revoked peer cannot escape it by deleting their local copy — next
sync restores the canonical state.

---

## Scaling

The simple `K0_org` model — one key, all members, rotated on every
membership change — scales roughly:

| Org size       | Approach                                              |
|----------------|-------------------------------------------------------|
| ≤ 500          | Simple `K0_org` + peer-to-peer UCAN delivery          |
| 500 – 10,000   | Same + asynchronous key delivery via Hypercore log    |
| 10,000+        | Add MLS for `K0` group key agreement                  |

`K0_org` rotation cost is O(n) — n peers, n wrapped-key deliveries per
event. At 100 peers, trivial. At 100,000, daily turnover means constant
rotation and the simple model breaks down.

**[MLS (RFC 9420)](https://datatracker.ietf.org/doc/rfc9420/)** is the
IETF standard for group key agreement with frequent membership changes,
used by Signal/WhatsApp/Wickr. It does the same job in O(log n) per
change. Composes cleanly with the rest of the design: replace the
`K0_org` distribution mechanism with MLS group state; everything else
stays the same.

For Workspace's likely audience (small-to-medium teams), the simple
model is sufficient. Enterprise scale gets MLS as the upgrade path.
Both keep the system P2P.

---

## Metadata leakage — what's still observable

Encryption hides contents. It does not hide:

- The existence of a Hypercore log (the public address is visible to
  any peer on the topic)
- Log length and growth rate
- Block size and timing
- Writer identity (with Autobase, each writer's contributions are
  identifiable by their log)

**Within the org:** acceptable. Active members already have legitimate
insight into colleagues' activity (you can see when documents are being
updated; you just can't read them).

**Post-departure:** the topic-layer revocation (above) cuts off this
observation channel entirely. Ex-employees lose both decryption and
topic membership.

**For documents whose existence is itself sensitive** (severance
discussions, redundancy planning, board-level material): a separate
Hyperswarm topic with restricted membership. The document's Hypercore
address is never shared with the wider org.

---

## What's resolved vs. what remains

### Resolved (implemented in this repo)

- **Identity** — `did:key:z6Mk…` derived from Hypercore ed25519
  (`packages/p2p-runtime/src/did.ts`)
- **DID encode/decode** — `didFromPublicKey` / `publicKeyFromDid`
  for the bidirectional mapping needed by the wrap primitive and
  attestation flow
- **Sync layer** — Hypercore + Hyperswarm
- **macOS IPC** — NSTask + JSON-RPC
- **Wrap primitive** — X25519 ECDH sealing for delivery envelopes
  (`packages/p2p-runtime/src/wrap.ts`)
- **Root attestation** — sign + verify over `(workspaceId, createdAt,
  formatVersion)` (`packages/p2p-runtime/src/attestation.ts`)
- **UCAN boundary** — issueDelegation, validateDelegation with
  canIssue override, serialise, whole-second expiry handling
  (`packages/ucan-boundary`)
- **Bootstrap envelopes** — bundle creation, consumption, JSON
  serialisation, tamper detection (`packages/portable-bootstrap`)
- **Live key delivery log (#9)** — `publishDelivery` / `scanDeliveries`
  over a replicated Hypercore; the steady-state carrier for peers who
  join after creation (`packages/portable-bootstrap/src/key-delivery.ts`)
- **Transparent log encryption** — `encryptedLog(log, key)` seals on
  append / opens on get, so tier-gated content rides the same
  replication path as ciphertext (`packages/p2p-runtime/src/encrypted-log.ts`)

### Resolved (design + accepted contracts)

- **Multi-writer** — Autobase (in production at Keet; design-validated,
  implementation pending in #11)
- **Forward-only revocation** — accepted contract, two cryptographic
  levers plus the cooperative policy hint
- **Two carriers for envelope delivery** — bundled (offline) +
  live key delivery log (steady-state)

### Open engineering work

- **Key delivery log — remaining polish (#9)** — core implemented;
  still want scan-efficiency tuning (index by recipient) and GC of
  superseded delivery blocks for long-lived workspaces
- **Topic-layer auth (#10)** — Hyperswarm supports per-connection
  authentication via the noise handshake; needs UCAN check on
  presented credential
- **Autobase wrapper (#11)** + **merge strategy (#12)** — multi-writer
  document API + concurrent-edit semantics
- **Revocation notice block + policy enforcement** — block format
  defined above; needs the live key delivery log (#9) and
  app-side honour-the-policy logic
- **Workspace policy file** — schema defined in
  [`workspace-format.md`](./workspace-format.md); honoured by app at
  revocation, key rotation, workspace deletion events

### Upgrade path (out of scope for v1)

- **MLS integration** — for enterprise-scale orgs (10k+ peers). Design
  must not foreclose this. Issue to file.

### Genuinely accepted limitations (contracts, not gaps)

- Revocation is forward-only — same as any system that delivers data
  to a client
- Metadata is observable to peers on the same Hyperswarm topic — the
  topic lever closes this post-departure
- Pre-quantum encryption assumption — the protocol layer is replaceable
  beneath the `@workspace/p2p-runtime` interface when post-quantum
  migration becomes relevant

---

## Cross-references

- [`threat-model.md`](./threat-model.md) — the contract this protocol
  serves (what Workspace protects, what it doesn't, forward-only
  revocation, audit trail = delegation chain, cooperative-client
  policy)
- [`workspace-format.md`](./workspace-format.md) — the `.workspace`
  container format that distributes the artefacts this protocol
  produces (folder-as-unit, `workspace://` URI, hidden schema
  entries, policy file)
- [`risks.md`](./risks.md) — where this could fail and what we're
  doing about it
- [`lighthouse.md`](./lighthouse.md) — the always-on-node concept;
  participates in the same UCAN + replication layer as any other peer
- [`discovery-layers.md`](./discovery-layers.md) — how peers find
  each other (local / LAN / WAN) before this protocol takes over
- [`FINDINGS.md`](../FINDINGS.md) — spike verdict + extraction checklist
- [`docs/ucan-prior-research.md`](./ucan-prior-research.md) — UCAN
  library notes (ucanto `canIssue` gotcha, library comparison)
- [`table-file-format/docs/PERMISSIONS.md`](https://github.com/workspace-sh/table-file-format/blob/develop/docs/PERMISSIONS.md) —
  consumer-side view of this same model, per file type
- [Issue #5](https://github.com/workspace-sh/workspace-p2p-spike/issues/5) —
  UCAN + Hypercore identity bridge (now expanded by this doc)
- [Issue #6](https://github.com/workspace-sh/workspace-p2p-spike/issues/6) —
  mobile path
