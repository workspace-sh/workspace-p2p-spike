# Identity Recovery, Device Linking, and Key Rotation

How a user adds a device, recovers after losing all of them, and
rotates keys — specified as three concrete flows over primitives that
already ship in this repo, not as abstractions.

**Status:** design. Every primitive referenced is implemented; what
remains is orchestration + the pairing-channel and recovery UX. Tracked
in [#17](https://github.com/workspace-sh/workspace-p2p-spike/issues/17).

The durability requirement below is not design — it is a rule learned
from an implementation that broke, and it is normative
([#38](https://github.com/workspace-sh/workspace-p2p-spike/issues/38)).

Primitives in play:

- **Wrapped keys** — X25519 seal to a recipient's key
  ([#7](https://github.com/workspace-sh/workspace-p2p-spike/issues/7),
  `@workspace.sh/p2p-runtime` `wrap`/`unwrap`).
- **UCAN delegation** — root → device, scoped + expiring
  ([#8](https://github.com/workspace-sh/workspace-p2p-spike/issues/8),
  `@workspace.sh/ucan-boundary`).
- **Key delivery log** — the live carrier; one block per delivery,
  scanned from a cursor
  ([#9](https://github.com/workspace-sh/workspace-p2p-spike/issues/9),
  `publishDelivery`/`scanDeliveries`).
- **Root attestation** — sign over workspace identity
  ([#16](https://github.com/workspace-sh/workspace-p2p-spike/issues/16)).

A device's identity is an ed25519 keypair whose public half is its
`did:key`; the private half never leaves the device.

### Where that private half lives — a durability requirement

"Never leaves the device" is a confidentiality property. It says nothing
about whether the key is still *there* tomorrow, and that turns out to be
the harder half.

**Identity storage must survive repackaging of the app that created it.**
An identity that disappears when an app is renamed, re-signed, or shipped
under a new identifier is not a device identity — it is an installation
identity, and the protocol is entitled to assume otherwise.

This is not hypothetical. It happened during Workspace implementation
(workspace-sh/workspace#345): the macOS bundle identifier changed, the
Keychain item became unreadable to the renamed app, and the device minted
a fresh seed. New seed → new `did:key` → no envelope in any workspace was
addressed to it any more. The folders were untouched and complete; the
device had simply become a stranger to them.

Per platform, the trap is the same shape:

- **Apple** — a Keychain item belongs to the *signing app*. Surviving a
  bundle-identifier change requires a `keychain-access-groups` entitlement
  with a group scoped to the team rather than the app.
- **Android** — Keystore aliases are scoped to the package name; a package
  rename loses them identically.
- **Anywhere** — storage keyed on an application identifier inherits that
  identifier's lifetime. Application Support paths built from a bundle id
  have exactly this problem, and that one is self-inflicted: the path is
  the implementation's choice, not the platform's.

### Failing to find an identity is not the same as not having one

A renamed app does not get an *error* from the keystore. It gets
"not found" — byte-for-byte what a genuine first run gets. An
implementation that mints on "not found" will silently re-identify a
device that was already a member of things.

**Implementations MUST distinguish the two.** A durable marker outside the
keystore — recording that an identity was established, in storage that
does not move — makes the difference observable. Marker present and
keystore empty is identity *loss*: refuse to mint, and say so. Only the
absence of both licenses a new identity.

Refusing is not merely tidier. Minting produces a device that appears to
work, syncs nothing, and gives no indication why — the failure is silent
at every layer, which is the worst property a failure can have.

### What recovery then means

A device in this state is not broken and neither is the workspace. It is
an *unlinked device holding a folder*, which §1 already covers: it needs
an envelope sealed to its new DID. The remedy is an invitation, not a
repair — and an implementation that has detected the loss can say exactly
that.

---

## 1. Device linking (the happy path)

Adding a second device to an existing identity. Spec this first.

1. The **new device generates its own ed25519 keypair locally.** The
   private key never leaves it.
2. The new device **presents its public key** to an existing device —
   QR code, local network, or copy-paste. The channel needs **integrity,
   not confidentiality**: it carries only a public key, so eavesdropping
   is harmless; what matters is that the existing device sees the real
   key (a tampered key links an attacker's device).
3. The existing device **issues a UCAN delegation** (#8) from the user's
   root identity to the new device's DID, scoped and expiring per
   policy.
4. The existing device **wraps the workspace key** (#7) to the new
   device's public key and **appends it to the key delivery log** (#9)
   — exactly the `createEnvelope` → `publishDelivery` path already
   demonstrated in `demo:key-delivery`.
5. The new device **scans the delivery log** (#9), finds the block
   addressed to its DID, unwraps, and is live.

Nothing new is required beyond the pairing-channel UX and the
orchestration. This is the same machinery as inviting a member — a
"device" and a "member" are both just a DID receiving a sealed
envelope.

---

## 2. Recovery (all devices lost)

Losing every device means losing the private keys on them. The escape
hatch is an **escrowed recovery key** established up front — itself just
another keypair, treated as a permanently-offline device:

- **At workspace creation**, the recovery key's *public* half gets a
  wrapped workspace key in the delivery log (#9) and a long-lived UCAN
  delegation — exactly like a linked device. The recovery key's private
  half is held by the user as a **printed mnemonic** or a
  **passkey-derived key** in the platform credential store.
- **On recovery**, the user re-derives the keypair from the
  mnemonic/passkey, re-establishes root attestation (#16 — the recovery
  key signs a fresh attestation chain, or holds a delegation from the
  original root), and re-enters the delivery log. **No surviving device
  is required.**

This stays P2P-pure: the escrow is a piece of paper or a passkey, **not
a third party**. (A Lighthouse *could* additionally hold an escrowed
share for users who opt in — convenience, not a requirement.)

---

## 3. Rotation

Replacing the workspace key (e.g. after a suspected compromise or a
departure):

1. Generate the new workspace key.
2. **Wrap it to all current device keys** via the delivery log (#9) —
   one block per device, the same mechanism as linking.
3. **Mark the old key superseded** with a supersession/tombstone block
   on the delivery log. The #9 scan loop must understand this block
   type — the `kind`-tagged record format already shipped
   (`kind: "workspace/key-delivery@1"`) leaves room for a
   `kind: "workspace/key-supersede@1"` variant without ambiguity.
4. **Re-issue UCAN delegations** under the new key material with fresh
   expiry.

### The honest caveat: rotation protects the future, not the past

A device that already holds the *old* workspace key can read everything
encrypted under it **forever** — rotation cannot retroactively un-read
data. Rotation only protects *future* content (written under the new
key). UCAN **expiry** is the blunt instrument actually available for
"revocation"; combined with the topic-layer gate
([#10](https://github.com/workspace-sh/workspace-p2p-spike/issues/10),
which stops a non-member *connecting*), it bounds a departed device's
*future* access, not its access to history it already replicated. The
design must state this plainly rather than implying rotation excludes a
device from past content.

---

## Open questions for implementation

- **Where does the recovery secret live?** User-held mnemonic,
  Lighthouse-escrowed share, or both as a user choice. Each has a
  different threat model and support burden.
- **Lazy vs eager rotation?**
  - *Lazy* — the new key applies from the next write; old content stays
    under the old key. Cheap, fits append-only logs.
  - *Eager* — an immediate re-encryption sweep of existing content;
    actually cuts off a compromised key from future *reads of old
    content*, but is expensive and needs a resumable sweep.
  - Likely answer: **lazy by default**, eager as an explicit "I believe
    a device was compromised" action.

---

## Cross-references

- [`permissions-model.md`](./permissions-model.md) — the two carriers,
  revocation levers, the supersession block lives on the key delivery log
- [`threat-model.md`](./threat-model.md) — what revocation does and
  doesn't guarantee (the forward-only contract)
- [`lighthouse.md`](./lighthouse.md) — optional escrow / always-on peer
- [`adr/0001-ucan-library.md`](./adr/0001-ucan-library.md) — the UCAN
  layer these flows delegate over
