# Permissions Model — Hypercore + UCAN + Autobase

The technical design for Workspace's P2P permission model. This is the
spike-side companion to
[`table-file-format/docs/PERMISSIONS.md`](https://github.com/workspace-sh/table-file-format/blob/develop/docs/PERMISSIONS.md),
which is the consumer-facing view. This document captures the
underlying cryptographic and protocol choices.

Status: **design**. None of this is implemented yet. The Phase 1/3a/3b
work in this repo proves the runtime + IPC; the permissions layer is
the next major piece, tracked in
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

### The delivery channel — also a Hypercore

Key delivery uses the **same protocol as document data**. There is no
separate infrastructure, mailbox server, or relay.

The org has a "key delivery" Hypercore log, replicated to every member.
Each block is one delivery payload addressed to one peer's DID. On
joining or coming online, a peer scans the log for blocks addressed to
them, unwraps the keys, and ignores the rest.

```
Key delivery Hypercore log (replicated to all org peers):

Block 0: { ucan: ..., wrapped_key: ..., recipient: did:key:zABC… }
Block 1: { ucan: ..., wrapped_key: ..., recipient: did:key:zDEF… }
...
```

Properties:
- Sender and recipient never need to be online simultaneously
- Any peer carries the message — it's just another Hypercore
- Wrapped key blobs are tiny (~100 bytes each)
- No central infrastructure

This is the asynchronous secure messaging pattern, applied to key
distribution.

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

### Resolved by existing components

- **Identity** — `did:key:z6Mk…` derived from Hypercore ed25519
  (implemented in this repo, `packages/p2p-runtime/src/did.ts`)
- **Sync layer** — Hypercore + Hyperswarm (Phase 1 of this repo)
- **macOS IPC** — NSTask + JSON-RPC (Phase 3b of this repo)
- **Multi-writer** — Autobase (in production at Keet; design-validated,
  not yet spiked here)
- **Forward-only revocation** — accepted contract, two levers

### Open engineering work (well-understood problems)

- **Topic-layer connection authentication** — Hyperswarm supports
  per-connection authentication via the noise handshake; needs
  implementation that checks a presented UCAN
- **Autobase merge semantics** for `rows.ndjson`-style data — choose
  LWW, custom, or a CRDT on top
- **ucanto delegation for `K_n`** — validate that ucanto's capability
  model handles wrapped-key delivery cleanly (issue #5)
- **Key delivery Hypercore log shape** — concrete block format, scan
  efficiency, garbage collection of already-consumed delivery blocks

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

- [`FINDINGS.md`](../FINDINGS.md) — spike verdict + extraction checklist
- [`docs/ucan-prior-research.md`](./ucan-prior-research.md) — UCAN
  notes from the earlier spike (ucanto `canIssue` gotcha, etc.)
- [`table-file-format/docs/PERMISSIONS.md`](https://github.com/workspace-sh/table-file-format/blob/develop/docs/PERMISSIONS.md) —
  consumer-side view of this same model, per file type
- [Issue #5](https://github.com/workspace-sh/workspace-p2p-spike/issues/5) —
  UCAN + Hypercore identity bridge (now expanded by this doc)
- [Issue #6](https://github.com/workspace-sh/workspace-p2p-spike/issues/6) —
  mobile path (Phase 2)
