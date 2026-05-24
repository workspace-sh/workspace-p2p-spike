# Threat Model

What Workspace protects against, and — equally important — what it does
not. The cryptographic detail lives in
[`permissions-model.md`](./permissions-model.md); this document is the
contract that detail serves.

Read this **before** the protocol detail. Knowing which game is being
played makes the moves comprehensible.

---

## The contract, in one paragraph

Workspace protects data in transit between peers and gates access by
unauthorised peers. It accepts that once an authorised peer has
decrypted data, that exposure is permanent and out of the system's
hands. Revocation is forward-only: it controls what an ex-peer receives
*next*, never what they already have. At-rest protection on the user's
own device is the operating system's job, not Workspace's.

That contract is the same one Google Docs, Notion, Linear, iCloud, and
every other consumer collaboration tool operates under. It is honest
about what software can and cannot do.

---

## What Workspace protects

- **Data in transit between peers.** All replication runs over
  Hyperswarm's noise-encrypted streams. A passive observer on the
  network sees nothing useful.
- **Access by unauthorised peers (network layer).** Connection-time
  UCAN authentication at the noise handshake rejects peers without a
  current valid org-membership delegation. They cannot join the swarm,
  cannot replicate blocks, cannot observe activity timing.
- **Access by unauthorised peers (content layer).** Block contents are
  encrypted with per-tier symmetric keys. A peer who is on the swarm
  but lacks the tier's key receives ciphertext only.
- **Future writes after revocation.** When a peer is revoked, the
  affected symmetric keys rotate for new writes. The ex-peer holds
  historical keys and can decrypt historical blocks they had already
  replicated; they cannot decrypt any new writes.
- **Tampering and replay of distributed files.** Root attestations and
  UCAN signatures defeat post-distribution modification and stale-file
  replay attacks.

---

## What Workspace does not protect

These are not bugs. They are accepted realities of any system that
delivers data to clients.

- **Data at rest on an authorised user's device.** Whatever the
  operating environment provides (FileVault on macOS, iOS Data
  Protection, Android disk encryption, BitLocker on Windows) is what
  the user gets. Workspace does not enforce this and does not rely on
  it.
- **What an authorised user does with decrypted data.** Screenshot,
  paste into a chat, sync to a personal backup, copy to a USB stick,
  retype into a competing tool — all out of scope. The user has the
  data; what they do with it is governed by law, contract, and
  professional ethics, not cryptography.
- **Data already received by a now-revoked peer.** Forward-only
  revocation is the only kind of revocation any "deliver to client"
  system can honestly offer. The departing peer keeps everything they
  had previously replicated.
- **The fraudulent-identity case for root attestations.** A root
  attestation defeats tampering of a distributed file and replay of
  stale ones. It does **not** defeat a malicious creator who claims
  `did:key:zEVIL` is "Acme's org root." Verifying the root DID itself
  requires an out-of-band channel — a signed announcement, a known
  URL, a fingerprint comparison, an existing trust relationship.
- **Device hygiene.** A logged-in Workspace app on a stolen device is
  a logged-in app. Account-level authentication and device management
  are application-layer concerns, not cryptographic ones.

If a future requirement demands controlling any of the above (e.g.
DRM-style "view but cannot copy"), that requirement is incompatible
with the contract and the system cannot honestly meet it. Better to
say so than to add theatre.

---

## Forward-only revocation, in plain terms

If Bob had access to Alice's salary yesterday and is revoked today, he
**still has** what he saw yesterday. He could have screenshotted it,
emailed it to himself, written it down, memorised it. The system
prevents him from seeing tomorrow's update. It does not retrieve
yesterday's.

This is exactly how Google Docs, Notion, Linear, Confluence, Office
365, and Slack all behave. A user with access at time T can preserve
what they saw at time T by any number of means; revocation closes
future access, not past exposure. Workspace makes the same trade and
makes it explicit.

The two levers Workspace uses to close future access are detailed in
[`permissions-model.md`](./permissions-model.md): encryption-layer
(rotate the symmetric key) and topic-layer (drop the peer from the
Hyperswarm topic). Both are forward-only. Both are honest.

---

## At-rest protection is environmental

**Workspace does not enforce at-rest encryption on the working tree,
does not rely on it for its security guarantees, and does not claim
to provide it.** Whatever your operating environment provides is what
you get. On managed devices the IT department's MDM may require disk
encryption; on personal devices it is the user's choice.

Mobile (iOS, Android) provides at-rest encryption automatically when
the device is locked, derived from the user's passcode. Workspace does
not control or guarantee this. It is an operating environment feature.

This boundary keeps the contract honest. Workspace does not claim to
solve problems it cannot solve.

---

## Audit trail = the delegation chain

A traditional audit log records actions: "Bob opened the salary field
at 14:32 on March 5." In a peer-to-peer system that decrypts data on
each peer's device, action-level logs are unfalsifiable (the peer
controls their own logging) and uninteresting (action implies
capability; capability is the thing that matters for forensics).

Workspace's audit answer is therefore a **capability** statement, not
an action statement. The UCAN delegation chain itself **is** the audit
trail:

> "Bob holds `K0_org` + `K1_alice` from 2026-03-01 to 2026-04-15."

This tells you:

- What he could read during that window (everything tier-0 across the
  org, plus tier-1 of Alice's record)
- When his access began (issuance timestamp on the delegation)
- When it was revoked (revocation cascade kills downstream chains too)
- Anything he sub-delegated downstream is visible in the same chain

The delegation chain is append-only, distributed, offline-verifiable,
and signed end-to-end. It cannot be tampered with or back-dated. It
answers every audit question that's actually answerable.

### What the chain does not tell you

- Whether Bob *actually* read X (he could have, that's the point)
- Whether Bob exfiltrated X (out of scope per the contract above)

If regulatory or contractual requirements demand action-level proof
("show me every read of this row"), the chain is insufficient and a
separate logging layer would be needed. That layer is not currently
designed and would not be tamper-evident in a P2P setting without
introducing a trusted recorder — a tension worth being explicit about.

### `history.ndjson` is a projection of the chain

PR #26 against `table-file-format` lists `history.ndjson` as "the
reserved extension for an audit log." Under this framing,
`history.ndjson` is **not a separate event log**; it is a
human-readable **projection** of the underlying delegation chain. The
chain is the source of truth; the projection makes it queryable.

This avoids the dual-source-of-truth problem (two logs that can drift)
and inherits the chain's tamper-evidence for free.

### Reading the audit trail is itself a capability

Not every member of an org should be able to enumerate "here is who
has access to what." That ability is itself a UCAN — held by admins,
auditors, or whatever role the org configures. Audit-read recurses
nicely into the same capability model the rest of the system uses.

---

## Cooperative client behaviour — the policy file

Some desirable behaviours on revocation (delete local files, clear
caches, show the user a notification) cannot be cryptographically
enforced — they depend on the client running the cleanup. Workspace
addresses this with a **workspace policy file** signed by the root
DID: `_workspace/policy.json` (see
[`workspace-format.md`](./workspace-format.md) for the schema). The
policy declares what cooperating apps *should* do on lifecycle events
(revocation, key rotation, workspace deletion). A revocation notice
block on the live key delivery log (see
[`permissions-model.md`](./permissions-model.md)) carries the trigger.

### What this protects

In the **cooperating-client case** (the user is running a real
Workspace app, kept up to date, connected to the swarm on a normal
schedule): the policy file's directives are honoured. On revocation,
the user is notified; their local working tree is cleaned up
according to policy; their local key state is cleared. The 95% of
real-world cases.

### What this does not protect

In the **adversarial-client case**: a motivated user can run a
modified Workspace client that reads the policy and ignores it.
They can also stay offline indefinitely after taking a snapshot,
never receiving the revocation notice and never running the cleanup.

The policy is honest about being a hint, not a directive.
Cryptographic enforcement carries the security load (forward-only
revocation: rotated keys, rejected handshakes). The policy file is
what makes the cooperating-client cleanup happen cleanly — not what
makes revocation work.

### The replicated-state property

A user cannot escape the policy by deleting the local file. Both
the policy file and any revocation notice are part of the workspace's
**replicated state**, distributed via Hypercore. Local tampering does
not work because the next sync restores the canonical state from
peers. The only paths to evade cooperative-client behaviour are:

- Run a forked or modified client that ignores the policy
- Stay offline forever after a pre-revocation snapshot

Both require engineering or accepting permanent disconnection.
Neither is a one-liner.

### Why this is still worth doing

Two reasons, beyond the obvious one of "most users use cooperating
clients":

1. **Compliance / legal cover.** When an admin clicks "remove user"
   and the user's cooperating app deletes their local copy, the org
   has a documented chain of "we asked the system to remove access;
   the system did its job." If the user kept screenshots or backups
   outside the cooperating client, that's a separate (legal /
   contractual) matter — but Workspace's behaviour was correct.
2. **It's the same trade every comparable tool makes.** Google Docs,
   Notion, Linear, iCloud all rely on cooperating clients honouring
   server-issued cleanup directives. A determined user can defeat any
   of them. The contract is honest about its limits.

---

## Explicit not-in-scope list

Listing these out so future contributors don't waste effort proposing
solutions to problems the contract has already declined:

- **Screenshot prevention** — impossible on consumer hardware; not
  attempted.
- **Copy/paste blocking on decrypted content** — same.
- **DRM-style "view but cannot save"** — same; cryptographically
  incoherent in a P2P setting.
- **Tracking who decrypted what when (action-level audit)** — possible
  in principle but unfalsifiable in a P2P design (each peer controls
  their own logs); not attempted in v1.
- **Post-revocation forgetting (re-encrypting historical blocks the
  ex-peer holds)** — Hypercore is append-only; this would require a
  full re-publication and is incoherent with the data layer's design.
- **Defeating device-level malware on an authorised user's machine** —
  if the OS is compromised, so is everything. Not a goal.
- **Authenticating the root DID without out-of-band channels** — the
  attestation defeats tampering; identity establishment is a separate
  trust-bootstrap problem.

---

## Summary

| What                                       | In scope? |
|--------------------------------------------|-----------|
| Data in transit between peers              | yes       |
| Access by unauthorised peers (net + content)| yes       |
| Future writes after revocation             | yes       |
| Tampering of distributed files             | yes       |
| Capability-level audit trail               | yes       |
| At-rest on authorised devices              | no — environmental |
| Authorised user's misuse of decrypted data | no — accepted contract |
| Already-replicated data on revoked peer    | no — forward-only |
| Action-level audit log (tamper-evident)    | no — would require trusted recorder |
| Screenshot / copy / DRM-style controls     | no — not attempted |
| Verifying root DID without out-of-band     | no — separate trust problem |

The system is honest about what it does. That honesty is itself a
design property.

---

## Cross-references

- [`permissions-model.md`](./permissions-model.md) — the cryptographic
  detail this contract serves (including the revocation notice block
  format that triggers cooperative-client cleanup)
- [`workspace-format.md`](./workspace-format.md) — the container shape
  that distributes the artefacts this contract protects, including
  the schema for the `_workspace/policy.json` file
- [`risks.md`](./risks.md) — where this could fail and what we're
  doing about it
- [`ucan-prior-research.md`](./ucan-prior-research.md) — UCAN-side
  research notes; the `canIssue` and revocation gotchas matter for the
  delegation-chain audit trail
- [`table-file-format/docs/PERMISSIONS.md`](https://github.com/workspace-sh/table-file-format/blob/develop/docs/PERMISSIONS.md)
  (PR #26) — consumer-side view of the permission model
