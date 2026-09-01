# Network conditions

What the transport actually costs on a real connection, and what the app
should do about it.

This exists because a measurement was surprising enough to change a design.
Opening a workspace was assumed to be dominated by process startup and
corestore; it is dominated by the DHT announce, by three orders of magnitude,
and on some connections that announce appears not to succeed at all.

The format is local-first. **Nothing a user does to their own files may wait on
a network round trip.** This page is the evidence for why that has to be an
enforced rule rather than an aspiration, and the place to record what each kind
of connection does.

## The measurements

One row per (connection, platform). All timings are for a throwaway store and a
**random** topic, so nothing real is announced and no peers are found — this
measures the cost of *joining*, not of syncing.

| connection | platform | `createRuntime()` | `joinTopic()` announce flush | notes |
|---|---|---|---|---|
| 5G cellular (carrier NAT presumed) | macOS 15, Node 23 | 73 ms / 72 ms | **40,276 ms / 40,350 ms** | Two runs 0.2% apart. See "Suspected timeouts". |
| Home Wi-Fi (unrestricted) | macOS | — | — | to populate |
| Home Wi-Fi | iOS (Bare) | — | — | to populate |
| Home Wi-Fi | Android (Bare) | — | — | to populate |
| Ethernet | macOS | — | — | to populate |
| Corporate network / VPN | macOS | — | — | to populate |
| 4G cellular | iOS | — | — | to populate |
| IPv6-only cellular | iOS | — | — | to populate |
| Airplane mode / fully offline | any | — | — | to populate — the case that must degrade cleanly |

For scale, on the same machine: bare `node` process startup is **20 ms**.

### Suspected timeouts

The 5G row's two runs differ by 0.2%. Organic network latency does not do that;
a fixed timeout does. The likely reading is that the announce is **not
succeeding** on that connection — carrier-grade NAT commonly blocks the UDP
hole-punching an announce depends on — and the call is giving up rather than
completing.

`joinTopic` **resolves** in that case rather than throwing, so a timed-out
announce and a successful one are indistinguishable to the caller. Until that
changes, "joined" means only "the call returned".

Any row that comes back suspiciously round, or suspiciously consistent, should
be treated as a timeout until proven otherwise. Record the raw numbers rather
than an average, so the tell stays visible.

## What this means for the app

The rules that follow from the table, and do not depend on any particular row
being right:

1. **Open locally, then sync.** Logs are open and folded before the join is
   attempted. A workspace must be readable and writable at that point, not when
   the network agrees. Awaiting the announce before returning is the bug.
2. **A join that has not landed is a normal state, not an error.** On a
   restricted connection it may never land. The workspace still works; it just
   has no peers yet.
3. **Say which state you are in.** "Local only", "connecting", "syncing with N
   peers" are different, and the user can act on the difference — switch
   networks, or carry on and sync later. A spinner that means all three means
   none of them.
4. **Never let a network state block an edit.** Not the save path, not the
   history panel, not opening a document.

## Relays

The restricted-NAT case is exactly what a relay exists to solve: when two peers
cannot hole-punch to each other, a third party that both *can* reach forwards
between them.

Hyperswarm/HyperDHT already relays, and Holepunch operate infrastructure for
it — so the 5G row above is not necessarily the last word, and testing whether
relaying rescues it is the single most valuable unmeasured thing on this page.
Do that before building anything.

If it does not, or does not reliably, a **Workspace-operated relay** is worth
considering. Three things to be clear about before it is:

- **It is availability, not trust.** A relay forwards encrypted Noise streams.
  It carries bytes it cannot read and never holds workspace keys, so operating
  one grants no access to anyone's content. Running our own does not weaken the
  format's threat model — but saying so is only true if it stays a relay and
  never becomes a store.
- **It must stay optional.** The moment a workspace *needs* our relay to sync,
  the format stops being peer-to-peer and becomes a service with extra steps.
  It is a fallback for connections that cannot hole-punch, not a path everything
  takes.
- **It is a running cost with a public commitment attached.** Bandwidth for
  other people's syncing, and an uptime expectation, permanently.

Piggybacking Holepunch's infrastructure is the right default until measurement
says it is insufficient. Our own becomes justified when we can point at a row
in the table above that relaying does not fix.

## Sharing the link — what we cost everything else

Every row above measures what the network costs us. On a constrained link the
more important number is the reverse: **what we cost every other application
sharing it.**

Observed during development, on a phone hotspot (`172.20.10.x`), while a
workspace was open and syncing normally:

- `git push` to github.com over HTTPS reset repeatedly.
- `api.github.com` worked, then intermittently did not.
- SSH to the same host worked throughout, uninterrupted.
- Quitting the app restored the rest.

That pattern is not filtering — filtering does not spare one protocol to the
same host and then change its mind. It is the signature of **NAT table
exhaustion**. A phone hotspot keeps a small translation table; the DHT plus
hole-punching opens many short-lived UDP flows and evicts other applications'
entries. SSH survived because it was one long-lived connection already
established and refreshed.

**Confirmed by stopping the app.** With a workspace open, `https://github.com`
reset on every attempt for roughly an hour. With the app and its Metro process
quit and nothing else changed:

| probe | app running | app stopped |
|---|---|---|
| `https://github.com` | reset, every attempt | HTTP 200 in 0.39–0.44 s, three for three |
| git `…/info/refs` | reset | HTTP 401 — a completed round trip |
| GitHub API | reset intermittently | working |

### Measured: two sockets, eighty peers

The flow count is no longer unmeasured, and the first attempt at measuring it
was wrong in a way worth recording.

Counting **sockets** shows nothing. With a workspace open and syncing, the P2P
child holds **two UDP sockets** — flat over thirty seconds, and total system UDP
endpoints indistinguishable from baseline. On that evidence the app looks
entirely innocent, which is what an earlier check concluded.

It is the wrong metric. `udx` multiplexes; it does not open a socket per peer.
**NAT entries key on the four-tuple**, so two local sockets talking to eighty
remote endpoints is eighty entries. Capturing on the interface instead:

| metric | value |
|---|---|
| local UDP sockets | **2** |
| distinct remote endpoints (200 packets) | **69**, across 39 IPs |
| distinct remote endpoints (800 packets) | **80** |
| **new** endpoints between two nearby samples | **53** |

One peer appeared five times on five different source ports — five entries for
one relationship.

An iPhone Personal Hotspot hands out a `/28` and keeps a translation table in
the low hundreds. Fifty-plus new entries in a short window is real pressure
against that.

**What this establishes, and what it does not.** The mechanism is now measured:
high endpoint count and high churn from a small socket count. Whether it *causes*
the observed failures is still correlational — during this capture HTTPS was
healthy (0.71 s), so the app was applying pressure without anything breaking.
The earlier incident reproduced once and has not reproduced since.

The honest position: the pressure is real and quantified; the failure threshold
is not known, and the link is independently unstable enough that a single
recovery-on-quit should not be read as proof.

### Prior art, and why it does not cover this

Worth knowing what already exists before inventing anything.

**BitTorrent solved the bandwidth version.** µTP with LEDBAT (RFC 6817) is a
*scavenger* transport: it watches one-way delay and yields the moment anything
else wants the link. It exists because BitTorrent was making home connections
unusable — the same complaint, twenty years earlier.

**IPFS/Kubo and libp2p solved the connection-count version.** Watermarked
connection managers, resource managers with per-scope limits, and a `lowpower`
profile, all added after nodes overwhelmed routers.

**Neither covers what happened here**, and the reason is worth stating.

Our transport (`libudx`) implements **BBR** — bandwidth and RTT based, with
explicit pacing. BBR is deliberately *competitive*: it finds the bottleneck and
takes its share. It is the opposite of a scavenger. But that is beside the
point, because **congestion control is the wrong axis**. It governs how fast one
stream sends; the failure here was how many flows exist. A LEDBAT-style
transport would open exactly the same number of NAT entries and simply push
fewer bytes through each.

`dht-rpc` does already adapt. It drops background query concurrency from 10 to 2
when its own requests pile up, under a comment that reads `// yield to other
traffic`:

```js
q.on('data', () => {
  // yield to other traffic
  q.concurrency = this.io.inflight.length < 3 ? this.concurrency : backgroundCon
})
```

**But "other traffic" means its own other queries.** It yields to itself.

### The gap: nothing yields to other applications

There is no mechanism by which a peer-to-peer app defers to *other processes*
sharing a NAT, because **the signal is not observable from inside the process**.
LEDBAT works because one-way delay is measurable end to end. There is no
equivalent measurement for "the router's translation table is nearly full" —
the kernel does not expose it, the router does not report it, and another
application's flows are invisible.

This has a consequence for design. An environmental heuristic — *am I behind a
phone hotspot?* — is not a crude stand-in for a measurement we could take
properly. **It may be the only signal available.** You cannot observe the table,
so you infer it from where you are.

That is the argument for detection (below) being load-bearing rather than a
convenience, and for a user override on top: the person can see things about
their situation that neither the process nor the platform can.

### The rule this implies

**A peer-to-peer app on a shared constrained link has an obligation to the
other traffic on it.** Being local-first is not sufficient: an app that never
blocks *its own* edits on the network, while making someone's video call
unusable, has still failed the user. Bandwidth is not the scarce resource here
— NAT table entries are, and they are shared with everything else the user is
doing.

This is the argument for connection *modes* rather than a single behaviour
tuned for a good link.

## Connection modes

Three, distinguished by what the link can afford rather than by what it is:

| mode | swarm behaviour | when |
|---|---|---|
| **Unrestricted** | Hyperswarm defaults. Announce, hole-punch, accept connections freely. | Ethernet, home Wi-Fi |
| **Constrained** | Cap concurrent connections hard. Back off announces. Prefer existing connections over discovering new peers. Do not accept inbound. | Cellular, tethering, hotspot, Low Data Mode, and any link the user has flagged |
| **Local-only** | No swarm at all. Logs open, edits work, nothing announces. | Offline, or the user's explicit choice |

Two things make this tractable rather than theoretical:

**The platform will tell us.** Apple's `NWPathMonitor` reports `isExpensive`
(cellular or tethered) and `isConstrained` (Low Data Mode), and Android has
equivalents in `ConnectivityManager`. Neither is a format concern — it is a
per-platform input to a decision the runtime makes — but the *modes* should be
specified here so every platform reaches the same behaviour.

**Local-only must already work.** The rules above require that a workspace is
readable and writable before any join is attempted, so local-only is not a
degraded mode needing new code — it is the existing startup path with the join
skipped. If that is not true, it is a bug in the app rather than a feature to
build here.

### What is still open

- **Where the mode is decided.** The runtime, from a platform signal, or the
  app, from a user setting? A user who says "this link is constrained" must be
  able to override a platform that says otherwise — tethering is not always
  reported as expensive.
- **Whether constrained mode is enough.** If a capped swarm still exhausts a
  hotspot's table, the honest answer is that local-only is the correct default
  on such links, with syncing an explicit act.
- **Whether the user is told.** Rule 3 above already asks the app to say which
  state it is in. "Not syncing, because this connection is metered" is a
  different sentence from "connecting", and only one of them is actionable.

## A flow budget that adapts

The design that follows from the gap above. Not implemented in this repo — this
is the specification; the app implements it.

### The idea

Congestion control regulates how fast one stream sends. The equivalent for flow
count is a **budget**: an upper bound on concurrent flows, adjusted by whether
our own requests are succeeding.

The insight that makes it work: **a NAT table that is full rejects new mappings,
and the app filling it is the first to notice**, because its own new flows start
failing. So the harm we do to others has a signature we can see in our own
numbers — the same trick LEDBAT plays with delay, one layer up.

### The signal

Everything needed is already computed by `dht-rpc` and Hyperswarm:

```
dht.stats.requests = { active, total, responses, timeouts, retries }
swarm._allConnections.size   // flows held
swarm.connecting             // flows in flight
```

Nobody has wired them into an admission decision. `dht-rpc` uses its own numbers
only to yield to its own queries.

### The rule

AIMD — additive increase, multiplicative decrease — applied to flow admission
rather than send rate. The shape is borrowed deliberately: it is well understood,
it is stable, and it fails towards being quiet.

- **Healthy** (failure rate below the low-water mark): budget grows by one per
  interval. Slowly, because the cost of being wrong upwards is someone else's
  connection.
- **Stressed** (failure rate above the high-water mark **and** flows near the
  budget): budget halves. Quickly, because the damage is already happening.
- The second condition matters. A high failure rate while we hold two flows is a
  bad network, not us. Halving would be superstition.

### Where the environment comes in

The environmental signal — expensive link, hotspot-sized subnet — sets the
**starting budget and the ceiling**, not the behaviour. It is a prior, not a
verdict:

| link | start | ceiling |
|---|---|---|
| Unrestricted | Hyperswarm default | Hyperswarm default |
| Expensive or hotspot-shaped | small | modest |
| No link | zero | zero |

This is the right division of labour. The environment is knowable instantly and
imprecisely; the pressure is knowable accurately but only after acting. Starting
careful on a hotspot avoids the first burst doing the damage, and adaptation
handles everything the heuristic gets wrong — including a hotspot that turns out
to cope fine, which will simply grow its budget.

### Why not just cap statically

A static cap is a guess that is wrong on both sides: too low on a link that
could take more, too high on one that cannot. It also cannot notice that
conditions changed — a hotspot with one other device on it is a different
proposition from one with six.

### Honest limits

- **We cannot attribute the pressure.** A failure rate that climbs because a
  video call started looks identical to one we caused. The response is the same
  either way — open fewer flows — so this is tolerable, but it is not
  measurement.
- **A floor is required.** Below some budget the workspace cannot sync at all,
  and silently reaching that state is worse than syncing slowly. The floor
  should be "can reach one peer", and hitting it is worth reporting.
- **It is unverified.** The mechanism is inferred from one reproduction. The
  measurement that would confirm it — flow counts during a join, on a hotspot
  and on a home router — is still the outstanding row on this page.

## Adding a row

```ts
import { createRuntime } from '@workspace.sh/p2p-runtime/node';

const t = async (label, fn) => {
  const started = performance.now();
  await fn();
  console.log(`${label} ${(performance.now() - started).toFixed(0)} ms`);
};

const runtime = await t('ready', () => createRuntime({ storage: '/tmp/x' }));
// A RANDOM topic — announcing a real one publishes a real workspace's presence.
const topic = [...crypto.getRandomValues(new Uint8Array(32))]
  .map(b => b.toString(16).padStart(2, '0')).join('');
await t('join', () => runtime.joinTopic(topic));
await t('close', () => runtime.close());
```

Run it at least twice and record both numbers. Note the connection honestly —
"office Wi-Fi" and "office Wi-Fi over VPN" are different rows.

Use a random topic. Announcing a real workspace's topic tells the public DHT
that this device holds that workspace.

## What is not measured here

- **Whether relaying rescues the restricted-NAT case.** The most valuable gap
  on this page, and a precondition for any relay decision.
- **Time to first peer.** Distinct from the announce, and the number that
  actually matters for sync. Needs two devices, so it is a separate exercise.
- **Throughput once connected.** A different question again.

Refs: workspace#313, workspace#309, workspace#312
