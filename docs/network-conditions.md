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
