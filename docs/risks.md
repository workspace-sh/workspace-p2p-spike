# Risks and Mitigations

Honest assessment of where this design could fail, the positions we're
taking, and the residual risk after mitigations. This is not boilerplate
— each risk below has been considered specifically against the design
in [`permissions-model.md`](./permissions-model.md),
[`workspace-format.md`](./workspace-format.md), and
[`threat-model.md`](./threat-model.md).

The risks fall into two groups: **architectural** (will the system
actually function as designed?) and **adoptive** (will users accept
and use it?). Both kinds are real.

For each risk: the risk itself, the position we're taking, a deeper
look at how the mitigation actually works, and the residual risk we
accept after the mitigation.

---

## 1. Relay infrastructure

### The risk

NAT traversal at scale is genuinely hard. Hyperswarm's DHT helps peers
find each other, but actual direct connections between two devices
behind restrictive NATs or carrier-grade NAT often need a relay to
proxy traffic. Most "P2P" apps that ship at consumer scale end up
relying on paid relays for reliability — at which point the "no
central infrastructure" claim is materially diluted.

If Workspace ends up requiring `workspace.sh`-run relays for most
real-world syncs, we are not really a P2P system; we are a
client-server system with a marketing layer.

### Position

Relays will need to exist. They are FOSS. They are designed to be
trivial to self-host. `workspace.sh` runs a public relay for
getting-started use, but no part of the protocol requires it. Direct
P2P is the happy path; relays are the fallback. Orgs and individuals
that care about full sovereignty self-host.

### Mitigation depth

The relay we use is a **blind relay** — Holepunch's pattern, which we
inherit by building on Hyperswarm. The relay forwards encrypted noise
streams between peers; it does not see plaintext contents, does not
hold keys, and cannot read what it carries.

What a blind relay can observe:

- That a connection exists between two peers (peer DIDs are visible
  via topic-layer auth handshakes)
- Timing and volume of traffic
- Which topics are being relayed

What it cannot observe:

- The contents of any encrypted block
- Symmetric keys or UCAN payloads
- Which Hypercore log a peer is replicating (within a topic)

Self-host story:

- A single binary (Node/Bare) + a Docker image
- One-click deploy recipes for Fly.io, Railway, Hetzner, plain VPS
- Org-specific relays declared in the workspace manifest
- Multi-relay fallback: a peer can know about many relays; tries
  them in order

When the user opens the Workspace app, a settings pane shows which
relays they're using and lets them add their own or remove ones they
don't trust. The default of "use workspace.sh's relay" is overrideable
without leaving the workspace.

### Residual risk

Casual users will rely on `workspace.sh`'s relay. If `workspace.sh`
goes down, their NAT-traversal path goes with it — they fall back to
direct DHT, which often works for sufficiently-permissive networks
but fails for the most restrictive ones (corporate guest wifi,
carrier-grade NAT mobile data, etc.). Mitigation: clear UX showing
relay state and easy override.

A motivated adversary running a malicious relay can observe metadata
patterns (which DIDs talk to which, when, how much). The encrypted
contents remain sealed but metadata leakage is real. Threat model is
explicit about this; topic rotation on revocation closes the worst
post-departure observation channel.

---

## 2. Mobile reliability

### The risk

iOS background networking is hostile. Apple's Background Tasks
framework gives apps tens of seconds, infrequently, to do background
work. Sync runs that take minutes — common for a real workspace —
cannot reliably complete in the background. Android is more
permissive but still battery-restrictive. The Hypercore-in-mobile
story via `react-native-bare-kit` is recent and untested at our
intended scale.

If mobile is unreliable, the consumer story is wounded —
"collaboration tool that doesn't sync on your phone" is a regression
from every SaaS competitor.

### Position

Mobile is **online-mostly**, not always-on. Sync runs while the app
is in foreground or recently-backgrounded. Desktop is the always-on
peer that holds workspace state durably. Mobile-only users use a
relay (their own or `workspace.sh`'s) as their stand-in for
"always-on peer."

We do not pretend mobile can be a primary always-on participant in
the swarm. We design around what mobile actually allows.

### Mitigation depth

What mobile does:

- **Foreground sync.** When the user has the app open, full Hypercore
  + Hyperswarm replication runs. Edits propagate within seconds.
- **Background sync (best effort).** iOS BGTask + push notifications
  let us schedule short sync windows. Good enough to pull urgent
  updates, not to download a workspace from scratch.
- **Push notifications via relay.** When a peer the user cares about
  publishes a change, the relay can push a notification. App opens
  in foreground, full sync runs.

What mobile does not do:

- Background-only-ever operation
- Acting as a discovery / relay node for other peers
- Sync without ever opening the app

UX positioning:

- During onboarding, the app explicitly explains: "Workspace works
  best with a desktop or always-on peer. Open the app on mobile to
  catch up."
- Workspaces with only mobile peers nudge the user toward setting up
  a relay (own or hosted).
- Read-only and light-editing operations are mobile-first. Heavy edits
  (e.g. importing large tables) recommend desktop.

react-native-bare-kit specifics:

- Holepunch maintains it; in production via Keet
- We treat it as a known dependency with a "watch upstream closely"
  posture
- If Bare-on-mobile becomes infeasible, fallback is a thin native
  HTTP client talking to a user-trusted relay (degraded P2P story
  but ships)

### Residual risk

Mobile-only households or solo users with no desktop and no relay
will experience degraded sync. Mitigation: relay as a recommended
fallback (own or hosted). Honest framing during onboarding rather than
hiding it.

If react-native-bare-kit hits hard limits at scale, we have a
fallback path but it dilutes the P2P story for mobile. Worth
maintaining ongoing dialogue with the Holepunch team.

---

## 3. UCAN ecosystem fragmentation

### The risk

The UCAN ecosystem has not consolidated. The library we use today
(ucanto, Storacha) ships a wire format that predates the ucan-wg
v1.0-rc.1 spec. The library tracking the new spec (iso-ucan) does not
yet have a revocation module we can rely on. Wire-format interop
between ucanto and rs-ucan/go-ucan/iso-ucan is one-way at best.

If we commit to ucanto and the ecosystem consolidates around v1.0, we
inherit a migration burden later. If we commit to iso-ucan now, we
have to build revocation ourselves and may end up rewriting if its
API stabilises differently.

### Position

ucanto for v1, because **revocation is load-bearing** for our
permission model and ucanto has a working revocation hook today.
The boundary module pattern
(`@workspace/ucan-boundary`, see PR #22) confines every ucanto call
to one file. A future swap is a 1–2 day job for the imports plus a
capability-model rewrite. We track the spec; we revisit when
iso-ucan ships revocation or when wire-format interop becomes
load-bearing.

### Mitigation depth

Comparison of the two implementations as of 2026-05:

| Property | ucanto (Storacha) | iso-ucan (Hugo Dias) |
|---|---|---|
| Spec tracking | Pre-v1.0 dialect (DAG-CBOR + custom) | v1.0-rc.1 envelopes |
| Revocation | Built-in, validated in this spike | Module not yet exported |
| IPFS coupling | Heavy — pulls in `@ipld/car`, `@ipld/dag-cbor`, `@ipld/dag-ucan`, `multiformats` | Lighter — modular by design |
| Wire interop with rs-ucan/go-ucan | One-way | v1.0 target (eventual) |
| Production usage | web3.storage / Storacha | Smaller; growing |
| Capability model | `{can, with}` | `{sub, cmd, pol}` policy predicates |
| Bundle size on Node | Substantial (~hundreds of KB tree) | Lighter |
| ESM-native | Yes | Yes |
| Active maintenance | Steady | Steady |

**For IPFS-agnostic specifically**: iso-ucan wins. ucanto bundles a
lot of the IPFS toolchain even if you only use the delegation
primitives. iso-ucan separates the envelope spec, delegation,
invocation, and revocation into different packages, so we could pull
in only what we need.

For our v1, however, **revocation matters more than IPFS-agnosticism**.
Without revocation we can't honestly close the topic-layer lever or
project the audit chain correctly. iso-ucan plus our own revocation
implementation is a real cost we'd rather not bear.

The capability-model rewrite cost on swap (ucanto's `with+can` →
ucan-wg's `sub+cmd+pol`) is the real expense — the wire format and
library API are easier than the semantic shift. We absorb this when
the swap becomes unavoidable, not before.

Trigger conditions for revisiting (already captured in
[issue #19](https://github.com/workspace-sh/workspace-p2p-spike/issues/19)):

- iso-ucan ships a stable revocation module
- A production integration with a non-ucanto UCAN service becomes a
  requirement
- ucan-wg v1.0 finalises and the wider ecosystem consolidates
- ucanto's IPFS coupling becomes a real cost (bundle size on mobile,
  conflicts with a non-IPFS dep we need)

### Residual risk

If ucan-wg v1.0 finalises and ecosystem momentum moves there before
iso-ucan ships revocation, we may end up running an out-of-favour
dialect for longer than is comfortable. Mitigation: keep the boundary
module narrow; plan a migration window; track the spec actively.

The wire-format interop limitation means we cannot easily integrate
with a future rs-ucan-based service. Acceptable for v1; flag if a
specific integration becomes a hard requirement.

---

## 4. Identity recovery

### The risk

P2P + cryptographic identity means losing your device can mean losing
your access permanently. Worse: a user who loses their identity loses
the ability to verify they are who they claim to be — they cannot be
"re-onboarded" without an admin issuing them a fresh delegation under
a new DID. This is the "I forgot my password" problem with no helpful
"reset" button.

For a consumer-facing product, this is a UX cliff that has killed
adjacent products (notably anything requiring users to manage
private keys directly).

### Position

Layered recovery story. Users pick the tier that matches their
threat model:

1. **OS keystore (default).** macOS Keychain / iCloud Keychain, iOS
   Keychain, Android Keystore. The OS provider already holds the
   user's most sensitive secrets; this is the default for the 90%.
2. **Self-managed (paranoid).** Export a seed file or seed phrase; the
   user is responsible for keeping it safe (1Password, paper backup,
   USB stick). Maximum sovereignty; demands discipline.
3. **Workspace.sh hosted recovery (convenience).** Encrypted seed
   backup held by `workspace.sh`, recoverable via email confirmation
   + a user-derived password. Self-hostable equivalent for orgs.
4. **Future: social recovery.** Shamir secret sharing of the seed
   among trusted peers (m-of-n threshold). Out of scope for v1.

### Mitigation depth

For each tier, the trust model and failure mode:

**OS keystore.** Trust: the OS provider's security (Apple, Google,
Microsoft). For the average user, this is strictly better than
managing their own secret. Failure: OS account compromise or loss.
Mitigated by the OS provider's own recovery mechanisms (iCloud
recovery, etc.) — outside our scope but not worse than the user's
existing exposure.

**Self-managed.** Trust: none beyond the user. Strongest sovereignty.
Failure: user loses the seed and has no recourse. Mitigated by
clear UX during seed export ("write this down, store somewhere
safe, you cannot recover this without it").

**Workspace.sh hosted.** Trust: us. Failure modes: our service
compromised, our email channel phished, account hijacked. Mitigated
by: the backup is encrypted to a service key XOR'd with a
user-derived password (we cannot decrypt unilaterally; an attacker
who breaches us alone cannot read the seed). Email recovery is
challenge-based: user clicks a one-time link, completes an
out-of-band verification, our service decrypts only after both
checks pass.

**Self-hostable hosted recovery.** Orgs that want their own escrow
run the same recovery service on their own infrastructure. Same
trust model; the trusted party is the org instead of `workspace.sh`.

**Rotation on recovery.** When a user recovers from backup, the app
offers a "rotate keys" step. The recovered DID continues to validate
under existing delegations (so they can read what they had), but a
new identity is generated and existing admins are notified to
re-delegate them under the new DID. This protects against the case
where the recovery itself was triggered by compromise.

### Residual risk

Self-managed users can still lose seeds. Mitigation: aggressive
educational UX during seed export.

Workspace.sh hosted recovery has the same blast radius as any
password-recovery service. We don't fix the fundamental problem of
"identity recovery requires trust in someone"; we make the trust
explicit and offer self-hostable alternatives.

The "social recovery" path (m-of-n via trusted peers) closes most of
the residual risk for paranoid users without trusting a service, but
it's a significant implementation undertaking; deferred to v1.x.

---

## 5. Discovery and onboarding

### The risk

Without a central directory, "I want to join Acme's workspace"
requires Acme to send the bundle. There is no frictionless "type your
work email, we find your org" flow. SaaS competitors have the
opposite default — discovery is the easy bit.

If joining a workspace feels harder than logging into Notion, the
mainstream adoption story stalls.

### Position

The bootstrap unit is `workspace://` URI scheme — a URL form of the
bundle metadata. Tap to open. Multiple delivery channels (QR code,
email, chat, AirDrop). Notification-based admin approval for new
peers. `workspace.sh` runs an optional directory layer for
friendly-name lookups; orgs can self-host their own.

### Mitigation depth

**The workspace:// URI.** Encodes everything needed to bootstrap: the
workspace's root DID, the workspace ID, the topic identifier, and
an embedded attestation. Tappable on any platform that registers the
scheme. Maps directly to the magnet-link mental model from
`workspace-format.md`.

**Delivery channels:**

- **QR code.** Workspace app generates one at "share this workspace."
  Scannable on phone. The QR encodes the workspace:// URI.
- **Email link.** Admin sends a workspace:// link by email. Recipient
  taps; app opens.
- **Slack / Teams / WhatsApp link.** Same.
- **AirDrop the .workspace folder directly.** The folder *is* the
  bundle; copying it is the share operation (per
  `workspace-format.md`).
- **Drag-and-drop in the Workspace app.** Drop the folder onto the
  app icon or window.

All of these resolve to the same code path: app parses bundle metadata,
validates attestation, prompts user to confirm before joining.

**The admin notification UX.** When a new peer presents a UCAN at the
noise handshake (topic-layer auth, issue #10), the admin's app
notifies them: "X (did:key:zABC…) wants to join, claiming role
'employee'. Approve / reject / approve-with-different-role." One-click
approve triggers envelope generation (containing the keys X needs)
and writes the envelope to the live key delivery log.

**workspace.sh directory (optional).** Maps friendly names to
manifest URLs:

- `acme.workspace.sh/join` → manifest URL → workspace:// URI
- One-click "request to join Acme's workspace" → email Acme's admins
- Admin notification fires; admin approves; envelope flows back

**Self-hosted directory.** Orgs that don't want a `workspace.sh`
dependency run their own:

- `acme.com/workspace/join` — same shape, no third-party dependency
- A YAML/JSON file at a known path, plus the existing notification UX
- Replaces the "discovery" step without replacing the protocol

### Residual risk

The "type your work email and find your org" flow is genuinely
better than what we offer at zero infrastructure. `workspace.sh`'s
directory closes most of the gap; doesn't fully replace it for the
most-lax users. Mitigation: keep the URI flow one-tap.

For truly small / informal use ("I want to share a workspace with
five friends"), the manual URI/QR flow is fine. The gap matters most
for medium-scale org rollouts; `workspace.sh` directory or self-hosted
equivalent closes it.

---

## 6. Compliance

### The risk

Enterprise IT expects: centralised audit logs they control, SSO
integration, DLP / monitoring tools, data residency guarantees,
contractual indemnification, defined access-control reviews. The P2P
substrate provides some of this natively (audit via UCAN chain, data
residency via peer placement), provides none of it in the
enterprise-conventional packaging, and is structurally incompatible
with some of it (DLP / monitoring of decrypted content). Enterprise
adoption is limited unless we wrap the substrate in a
compliance-friendly layer.

### Position

SMB and team-scale users get the substrate natively. Enterprise
users get `workspace.sh` hosted compliance services as an optional
managed layer; the substrate itself is unchanged. Self-hostable
equivalents exist for orgs that want managed compliance without
trusting us.

The substrate's properties are honest: forward-only revocation,
capability-as-audit, no DLP. We educate; we don't pretend to deliver
what we can't.

### Mitigation depth

What we have natively (P2P substrate):

- **Capability-level audit.** UCAN delegation chain is the canonical
  audit. Reads as: "X had Y access from time T1 to time T2, granted
  by Z, with proof chain back to root." Projects as
  `history.ndjson` (per
  [`table-file-format/docs/PERMISSIONS.md`](https://github.com/workspace-sh/table-file-format/blob/develop/docs/PERMISSIONS.md))
  for human-readable form.
- **Data residency.** Workspace data lives on participants' devices
  and any relays they trust. Orgs requiring data-in-EU can self-host
  relays in EU; require peers to be EU-located via policy.
- **Access control.** Tiered symmetric keys + UCAN delegation + topic
  membership. Stronger than role-based ACLs in some respects
  (cryptographically enforced, not just policy-enforced).
- **Forward-only revocation.** Honest. Documented in
  `threat-model.md` as the explicit contract.

What we don't have natively:

- **SSO bridge.** Out of scope for the protocol. Doable as a hosted
  layer that issues UCAN delegations after SAML/OIDC auth. Available
  via `workspace.sh` hosted, self-hostable for orgs.
- **DLP / monitoring of decrypted content.** Incompatible with
  forward-only revocation. We do not pretend to offer it. Some
  regulatory regimes will not accept its absence; those orgs are not
  our customer.
- **Centralised admin console for compliance reporting.** The chain
  projects into reports; `workspace.sh` offers a hosted version that
  generates SOC 2-friendly outputs. Self-hostable equivalent for orgs
  that want their own.

The `workspace.sh` hosted compliance package:

- Managed relays in jurisdictions of choice
- Optional key escrow (with org consent, encrypted to the org's own
  recovery key)
- SSO bridge (SAML / OIDC → UCAN delegation issuance)
- Audit report generation from the chain
- Contractual indemnification and uptime SLA
- Self-hostable: every component is FOSS; orgs that don't trust us
  run their own

The substrate is unchanged whether using hosted or self-managed
services. Hosted is convenience + value-adds, not gatekeeping.

### Residual risk

Some compliance regimes mandate specific tooling that conflicts with
the forward-only revocation contract (e.g. mandatory DLP, mandatory
content surveillance). We cannot meet those without changing what
Workspace is. Honest framing: those orgs are not our target customer.
Better to be explicit than to over-promise.

Enterprise procurement is slow even when the tech fits. Mitigation:
strong SMB foothold first; enterprise pull, not push.

---

## 7. Mental model and onboarding UX

### The risk

"Your folder is the workspace; sharing is file copy; the app does
the keys for you" is novel. Most users mental-model Notion / Linear
/ Slack as "log in at notion.com." The file-as-unit framing requires
learning. If onboarding takes more than ~five minutes, drop-off is
brutal.

### Position

Concrete UX touchpoints teach the model without lecturing. The
file/folder *behaviour* tells the story; the app makes it tangible.

### Mitigation depth

**macOS Quick Look for `.workspace`.** Selecting a `.workspace`
folder and pressing Space shows a custom preview:

- Workspace name (friendly name from manifest)
- Root DID (truncated, with copy button)
- Creation date
- Count of files visible at this access level
- A QR code encoding the workspace:// URI
- "Open in Workspace" button

The user sees the file, sees what it represents, and has an obvious
next action. The QR is the magnet-link analogue: scannable from
another device.

**URL scheme registration.** workspace:// URIs open the Workspace
app, which shows a join confirmation. Same surface as App Store deep
links or `slack://` URIs.

**Mobile equivalents.** Long-press file in Files.app → "Open in
Workspace." iOS share sheet → "Send to Workspace" → triggers admin
approval flow on the receiving end.

**Cross-device transfer.** Scan QR code with phone; app opens with
the URI; phone has the bootstrap info and syncs from peers (or relay)
when next online. Or AirDrop the folder directly.

**Drag-and-drop in the app.** Drop a .workspace folder onto the app
window: unmistakable "join this workspace?" prompt.

**Empty-state UX.** First launch shows three equal-weight options:

1. **Create a new workspace** — for someone starting something
2. **Open a workspace file** — for someone who received a folder
3. **Join by URL or QR** — for someone with a workspace:// URI

No "log in / sign up" path. The friction surface matches what the
user actually has in hand.

**In-app demonstration workspace.** First-launch ships with a
read-only demo workspace pre-loaded. User can poke at it, see the
working tree, see permissions in action, before doing anything
real.

**Templates.** "Create from template" gives starter workspaces:
project tracker, team docs, knowledge base. New users get to
something useful without designing their own schema from scratch.

### Residual risk

Some users will still need explicit education. Mitigation: in-app
onboarding walkthrough; clear documentation; templates that
demonstrate the model.

The "I'm used to logging in" intuition is deeply ingrained.
Workspaces feeling more like files than like accounts is the right
direction; some users will take time to adjust. Mitigation: provide
both onboarding paths — "log in to Workspace.sh" (creates a
workspace under your account) and "open a workspace file" (the
P2P-native flow) — equally weighted, equally legitimate.

---

## Honest residual unknowns

Things we don't know that no amount of design can resolve in advance:

1. **Will end users actually pay for P2P?** Most won't. We're betting
   on a privacy-conscious + control-conscious slice. The slice
   exists; its size and willingness-to-pay are unproven.
2. **Does macOS-first generalise?** The bet is yes; the bare-kit
   path on mobile is unproven at scale. Real users on real networks
   are the only way to find out.
3. **Will workspace.sh hosted services become a de-facto dependency?**
   Possible. Mitigation: invest in self-hostability from day one;
   never make hosted-only features unless they're clearly
   value-adds (analytics, support, etc.) rather than core
   functionality.
4. **Will competitors clone the format?** If successful, yes. The
   format is intentionally portable. Goal: be the best
   implementation, not the only one. Worth thinking about a healthy
   ecosystem rather than moat-building.
5. **Will the UCAN ecosystem consolidate around v1.0 quickly enough?**
   Unknown. We have a contingency (boundary module pattern, planned
   swap). The migration window is the variable.
6. **Will Holepunch stay maintained?** Hypercore et al. depend on
   the Holepunch team. They've been steady for years; not a worry
   today, but a single-team dependency is a real risk worth
   monitoring.

The design is right. Execution risk is the dominant remaining
variable.

---

## Cross-references

- [`threat-model.md`](./threat-model.md) — what Workspace protects and
  what it doesn't (the contract that bounds the technical risks)
- [`permissions-model.md`](./permissions-model.md) — the protocol
  these risks attach to
- [`workspace-format.md`](./workspace-format.md) — the container
  format
- [Issue #19](https://github.com/workspace-sh/workspace-p2p-spike/issues/19)
  — UCAN library choice ADR
- [Issue #17](https://github.com/workspace-sh/workspace-p2p-spike/issues/17)
  — identity recovery / device linking / key rotation
