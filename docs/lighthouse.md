# Lighthouse

A Lighthouse is a trusted always-on node a user opts a workspace into.
It stays online, replicates the workspace's logs, and keeps the swarm
reachable when no peer device is awake.

Lighthouses are optional. A workspace works without one — that's the
whole point of the P2P design. But laptops close, phones sleep, and
offices have weekends. A Lighthouse is how an organisation gets
reliability without leaving a machine plugged in under someone's desk.

**Status:** concept — design and implementation pending, post-spike.
The Lighthouse implementation will live in a separate repo (TBD).

---

## What it is

A Lighthouse is a peer. It joins the swarm like any other peer, holds
the same Hypercore logs, replicates the same blocks. The difference is
operational, not architectural:

- It's online all the time
- It's run by someone the workspace's owner has chosen to trust with
  availability (themselves, their org, or a paid provider)
- It has no special cryptographic authority — it can't forge writes,
  can't grant capabilities, can't read tier-gated content it hasn't
  been granted access to

In capability terms, a Lighthouse holds whatever UCAN delegation the
workspace owner issued it. Usually that's enough to participate in
replication and serve blocks back to peers. It doesn't need write
access to be useful. It doesn't need decryption keys to be useful. It
just needs to be reachable.

---

## Why it matters

Pure P2P is great until everyone goes to sleep at the same time. Three
failure modes a Lighthouse closes:

- **The "everyone's offline" gap.** A small team where every member's
  laptop is asleep means a new joiner can't find anyone to sync from.
  A Lighthouse stays up.
- **The cold-start problem.** First-time peers need *somewhere* to
  fetch the initial blocks. A Lighthouse serves that role without
  being authoritative.
- **The mobile peer problem.** Phones sleep aggressively, throttle
  background work, and can't be relied on as swarm participants.
  Desktops are better but not always-on. A Lighthouse is.

None of this gives up the P2P guarantees. The cryptographic substrate
is unchanged; the Lighthouse is just a peer that happens to be plugged
in.

---

## What it is not

- **Not authoritative.** The workspace's root attestation is the
  ground truth. A Lighthouse can't fork the workspace, can't censor
  writes (peers can still talk directly), can't grant or revoke
  capabilities. Its trust is operational (availability), not
  cryptographic.
- **Not custodial.** A Lighthouse holds bytes, not access. Tier-gated
  content is encrypted at rest; the Lighthouse stores it but can't
  read it unless it was issued the same keys as a regular member.
- **Not a relay.** Relays forward topic traffic without holding state.
  Lighthouses hold state — they're full peers. Both can coexist; they
  solve different problems.
- **Not an Anchor.** "Anchor" is reserved separately for a future
  on-chain bootstrap concept (immutable discovery metadata in
  perpetuity). Lighthouses are mutable, opt-in, operational. Anchors
  would be permanent, fixed, foundational.

---

## Deployment shapes

The same code runs in all three:

- **Self-hosted.** A user runs the Lighthouse binary on a VPS, a home
  server, an old laptop in a cupboard. They control it end-to-end.
- **Org-hosted.** An organisation runs Lighthouses for their team's
  workspaces. Same binary, more uptime, possibly hardened.
- **Hosted service (free or paid).** A provider runs Lighthouses for
  users who don't want to deal with infrastructure. Same binary, run
  by us. Free tier for casual workspaces, paid tier for storage and
  bandwidth beyond a threshold.

A workspace can be pointed at multiple Lighthouses. None of them is
authoritative; they're all just peers with good uptime.

### When a Lighthouse is needed — and when it isn't

Lighthouses are an **availability** tool, not a discovery
requirement. Whether one is needed depends on where workspace members
actually are:

- **Same-LAN orgs** (everyone in one office, household, or other
  shared network) don't need a Lighthouse for the LAN to work. Peers
  discover each other directly via the LAN-discovery layer (see
  [`discovery-layers.md`](./discovery-layers.md)). A Lighthouse may
  still be useful for "the laptops are all asleep at the weekend" —
  but it's an opt-in convenience, not a prerequisite.
- **Remote-team orgs** (members spread across the internet) get
  significant value from a Lighthouse. With one running on a host
  that's reachable over WAN — a VPS, a hosted service — peers have a
  reliable rendezvous point without depending on the public DHT or on
  any given member's device being online.

The architecture stays the same in both cases; the Lighthouse is just
absent in the first and present in the second.

---

## Cross-references

- [`workspace-format.md`](./workspace-format.md) — the format a
  Lighthouse replicates
- [`permissions-model.md`](./permissions-model.md) — the capability
  layer a Lighthouse participates in (no special privileges)
- [`discovery.md`](./discovery.md) — how a workspace's URI gets
  resolved (separate from how its content gets replicated)
- [`discovery-layers.md`](./discovery-layers.md) — the local-first /
  LAN / WAN discovery hierarchy a Lighthouse fits into at layer 3
- [`threat-model.md`](./threat-model.md) — what trusting a Lighthouse
  does and doesn't expose
- [`uri-scheme.md`](./uri-scheme.md) — `workspace://` URIs can name
  a Lighthouse as a cold-start hint via the `relays=` parameter
- [`risks.md`](./risks.md) — Lighthouse mitigates the casual-user
  relay dependency (risk #1) and the mobile-only availability gap
  (risk #2)

---

## Naming

Named by Michelangelo, after a visit to the lighthouse at Tossa del
Mar. A lighthouse doesn't own the harbour or guide the boats — it
just stays lit, so the boats can find their way home. Same job.
