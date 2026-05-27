# @workspace/p2p-spike-node

Scripts for exercising the spike. Two cover the design end-to-end on
direct pipes; two more exercise the swarm transport (one over the
public DHT, one over a private DHT you run yourself); one is the
private DHT itself.

```
src/demos/
├── smoke.ts            ← live DHT, runtime-only (2 peers)
├── end-to-end.ts       ← bundle → topic → log, via live DHT
├── acme-org.ts         ← small-org walk-through, direct pipe (no network)
├── bootstrap-dht.ts    ← private hyperdht bootstrap node
└── acme-org-live.ts    ← acme-org, but over the private DHT
```

See [`docs/discovery-layers.md`](../../docs/discovery-layers.md) for
why we offer both pipe-based and swarm-based versions — the discovery
layer is the first thing that differs across local / LAN / WAN
scenarios.

## `smoke` — live DHT, runtime-only

Two `NodeRuntime` instances find each other via the public DHT and
replicate a log. Exercises **discovery + transport** through the real
Hyperswarm swarm. The unit test at
`packages/p2p-runtime/tests/replicate.test.ts` covers the same
replication code path via a direct duplex pipe — no network.

```sh
npm -w @workspace/p2p-spike-node run smoke
```

Requires internet access. Flaky if the public DHT is slow or your
network throttles UDP; rerun if it times out.

## `demo:end-to-end` — bundle + topic + replication (live DHT)

The first cohesive walk-through of the design, over the real swarm:

1. Peer A creates a workspace (root identity, attestation, K0_org)
2. Peer A writes a `.workspace/` bundle to disk for Peer B
3. Peer B reads the folder, validates the attestation, unwraps the
   envelope
4. Both peers join the topic derived from `workspaceId`
5. Peer A creates a Hypercore log and appends data
6. Peer B opens the log and reads it back via Hyperswarm

```sh
npm -w @workspace/p2p-spike-node run demo:end-to-end
```

Same network caveat as `smoke`.

## `demo:acme` — small-org walk-through (deterministic, direct pipe)

A more thorough demo: three members of "Acme" share a workspace. The
working tree carries plaintext markdown files (workspace-public, per
the spec); the data log carries the same content **sealed under
K0_org**. Bob and Carol unwrap K0_org from their envelopes and
decrypt; Eve (no envelope) cannot.

```sh
npm -w @workspace/p2p-spike-node run demo:acme
```

Uses the runtime's direct duplex pipe rather than the swarm. Same
Hypercore replication code path, just deterministic and fast (~20ms).
Doesn't touch the network at all.

## `demo:bootstrap` + `demo:acme:live` — over a private DHT

For exercising the actual Hyperswarm transport without polluting your
network: run a **private hyperdht bootstrap node**, point peers at it
instead of the public DHT. Useful for testing on a tethered
connection, in CI, or anywhere you don't want N×UDP probes leaving
your machine.

```sh
# Terminal 1 — start the private DHT (listens on 127.0.0.1:49737)
npm -w @workspace/p2p-spike-node run demo:bootstrap

# Terminal 2 — run the Acme demo against it
npm -w @workspace/p2p-spike-node run demo:acme:live
```

The runtime accepts a `bootstrap` option (see
`CreateRuntimeOptions`) so any code can opt into this private-DHT
mode. The bootstrap process keeps running until Ctrl-C; the demo
shuts down its own peers.

See [`docs/discovery-layers.md`](../../docs/discovery-layers.md) for
the architectural framing of why this exists — it's the same
mechanism a self-hosted org would use to run a workspace's swarm on
their own infrastructure.

## What none of these demos prove (each is its own tracked issue)

- Runtime DID and bundle recipient DID aren't unified through the
  runtime API yet — the scripts use independent identities for the
  bundle vs the runtime
- Topic-layer auth (#10) doesn't gate connections by UCAN today
- Autobase wrapper / encrypted store (#11) — `seal`/`open` runs at
  the application layer in the Acme demos; the runtime doesn't yet
  handle encryption transparently
- Live key delivery log (#9) — envelopes are in the bundle today;
  the live-channel carrier for new joiners is pending
- LAN discovery (mDNS) — designed in
  [`docs/discovery-layers.md`](../../docs/discovery-layers.md);
  not yet implemented
