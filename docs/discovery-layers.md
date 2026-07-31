# Discovery Layers

How a Workspace peer finds another peer — and why we layer the
discovery mechanisms by network locality so that local-first really
means "no internet involved when no internet is involved."

A workspace open on two laptops sitting on the same office Wi-Fi
shouldn't have its discovery hammering the public internet. A
workspace whose members are spread across the world still has to
work without manual configuration. Both cases must hold, and the
runtime picks the right layer for the situation.

**Status:** design — implementation pending. Only the WAN layer (the
public Hyperswarm DHT) runs today; the LAN, Lighthouse-hint, and
direct-pipe layers are in various states of design or partial
implementation.

---

## Why layered discovery

Hyperswarm — the discovery layer underneath Workspace — was built
for "find any peer anywhere." It does this brilliantly via a public
DHT, but the same lookup mechanism applies to peers on the same LAN
as to peers on the other side of the planet. That's correct, but
wrong for locality: two Macs sharing one office network shouldn't
need the public internet to notice each other.

The fix isn't to replace Hyperswarm — it's to layer cheaper, more
local discovery mechanisms above it, and let the runtime pick
whichever finds a peer first. Hyperswarm's public DHT stays as the
universal fallback.

This pattern is well-trodden: Resilio Sync, Syncthing, Dropbox LAN
sync, AirDrop, Spotify Connect, AirPlay — all layered-discovery
systems with the same shape.

---

## The layers, in priority order

### 1. Direct / local IPC

Same host, same app. No network at all. Two `NodeRuntime` instances
in one process can be paired via direct duplex pipes between their
Corestores; multiple windows of the same workspace running on one
Mac talk to each other through this path.

**Today:** implemented as `__pipeReplicate` on the Node runtime. Used
by the integration tests and the `demo:acme` script in
`apps/node/`.

### 2. LAN / mDNS multicast

Same LAN, no internet needed. Peers multicast "I exist on topic X"
on the local network using mDNS (RFC 6762). Other peers on the same
Wi-Fi or wired LAN hear the broadcast and connect directly. This is
the same mechanism behind AirDrop, Dropbox LAN sync, and Spotify
Connect.

This is the layer that makes "open Workspace at the same café
on a wifi with no internet, see each other instantly" honest.

**Today:** not implemented. Prior art exists — Holepunch's
`multicast-dns` module (mafintosh-authored) wrapped the protocol
for Node; the dat-ecosystem's `dns-discovery` layered it for peer
discovery. ~200 lines of new code to wire in; no Hypercore protocol
fork required.

### 3. Configured Lighthouse(s)

Known peers with high uptime. If a workspace has Lighthouse pointers
(in its manifest or by user configuration), the runtime tries them
directly before falling through to the public DHT. The Lighthouse is
both a peer that replicates workspace state and a discovery aid for
finding other peers on its network.

See [`lighthouse.md`](./lighthouse.md) for the Lighthouse concept
itself. Note the distinction:

- **Same-LAN orgs** (everyone in one office, household, etc.):
  Lighthouse not required for the LAN to work. Layer 2 (mDNS) does
  the discovery.
- **Remote-team orgs** (members across the internet): a Lighthouse
  on a publicly-reachable host (VPS, hosted service) gives peers a
  reliable rendezvous without depending on the public DHT.

**Today:** the Lighthouse concept exists; the runtime doesn't yet
take a list of pre-configured Lighthouse addresses as discovery
hints.

### 4. Public Hyperswarm DHT

Last resort, works everywhere. The default Hyperswarm behaviour:
peers announce on the public DHT and discover each other through it.

**Today:** the default and only discovery mechanism the runtime
uses.

---

## Fall-through behaviour

The layers compose. Each layer's success means the next isn't tried
for that peer:

- Two Macs at the same office find each other at layer 2; the DHT is
  never invoked.
- A Mac at the office and another on the same workspace tethered
  from a phone elsewhere: the office Mac finds local peers via mDNS;
  the tethered Mac falls through to the public DHT (layer 4); both
  pairs of peers are connected.
- Two Macs on opposite continents with no Lighthouse fall straight
  through to layer 4.

Discovery isn't either/or — it's "whichever works, soonest."

---

## What the runtime needs to expose

For the layered discovery to be testable and configurable:

- A `bootstrap` option on `createRuntime` — point peers at a private
  `hyperdht` bootstrap instead of the public one. Used for testing,
  for self-hosted orgs running their own DHT, and as the mechanism
  Lighthouse-as-discovery-hint can be implemented on top of.
- An `mdns` toggle (default on; off for tests that don't want
  multicast traffic on the runner).
- A `lighthouses` list — pre-configured Lighthouse addresses tried
  as layer 3 hints before falling through to the DHT.

Today's runtime accepts none of these. They land as the layers
themselves are built.

---

## What this is NOT

- **Not a Hyperswarm replacement.** Workspace builds *on top of*
  Hyperswarm and adds layers for local cases the public DHT doesn't
  optimise for. The public DHT remains the universal fallback.
- **Not a protocol fork.** The Hypercore replication that runs once
  two peers are connected is unchanged across all four layers. Only
  the *discovery* shape changes.
- **Not a config burden.** Defaults work; the layers fall through
  automatically. Self-hosters and orgs that want more control can
  override.

---

## PAN — a future fifth layer

Personal Area Network discovery (Bluetooth, Wi-Fi Direct, Apple's
AWDL) would sit below layer 2 — finding peers when there's no shared
network at all, just two devices in physical proximity. Significant
per-platform engineering (AWDL is private API on Apple platforms;
Wi-Fi Direct works well on Android but is constrained on iOS);
deferred until mobile is in scope.

Tracked as a backlog item; see [`risks.md`](./risks.md) and
[`FINDINGS.md`](../FINDINGS.md).

---

## Cross-references

- [`workspace-format.md`](./workspace-format.md) — the on-disk
  format these layers replicate
- [`permissions-model.md`](./permissions-model.md) — the
  cryptographic protocol that runs once peers are connected
- [`lighthouse.md`](./lighthouse.md) — the always-on-node concept
  used at layer 3
- [`discovery.md`](./discovery.md) — DNS TXT +
  `.well-known/workspace` discovery; resolves a *domain* to a
  workspace URI (distinct concern from the peer-to-peer discovery
  this doc covers)
- [`risks.md`](./risks.md) — relay / mobile / casual-user
  availability risks that the LAN and Lighthouse layers help close
