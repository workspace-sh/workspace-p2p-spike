# @workspace/p2p-spike-node

Scripts for exercising the spike. Two cover the design end-to-end; one
proves the live DHT transport works.

```
src/demos/
├── smoke.ts          ← live DHT, runtime-only
├── end-to-end.ts     ← bundle → topic → log, via live DHT
└── acme-org.ts       ← small-org walk-through; K0_org actually seals
```

## `smoke` — live DHT, runtime-only

Two `NodeRuntime` instances find each other via the public DHT and
replicate a log. Exercises **discovery + transport** through the real
Hyperswarm swarm. The unit test at
`packages/p2p-runtime/tests/replicate.test.ts` covers the same
replication code path via a direct duplex pipe — no network.

```sh
npm -w @workspace/p2p-spike-node run smoke
```

Requires internet access. Flaky if the DHT bootstrap is slow or your
network rate-limits UDP; rerun if it times out.

## `demo:end-to-end` — bundle + topic + replication (live DHT)

The first cohesive walk-through of the design, over the real swarm:

1. Peer A creates a workspace (root identity, attestation, K0_org)
2. Peer A writes a `.workspace/` bundle to disk for Peer B
3. Peer B reads the folder, validates the attestation, unwraps the
   envelope
4. Both peers join the topic derived from `workspaceId` (== root pubkey)
5. Peer A creates a Hypercore log and appends data
6. Peer B opens the log and reads it back via Hyperswarm

```sh
npm -w @workspace/p2p-spike-node run demo:end-to-end
```

Proves: bundle round-trips through disk, attestation verifies across
the boundary, envelope unwraps cleanly, topic derivation joins the
bundle flow to the replication flow without out-of-band coordination.
Same network caveat as `smoke`.

## `demo:acme` — small-org walk-through (deterministic, direct pipe)

A more thorough demo: three members of "Acme" share a workspace. The
working tree carries plaintext markdown files (workspace-public, per
the spec); the data log carries the same content **sealed under
K0_org**. Bob and Carol unwrap K0_org from their envelopes and decrypt;
Eve (no envelope) cannot.

```sh
npm -w @workspace/p2p-spike-node run demo:acme
```

Uses the runtime's direct duplex pipe rather than the live DHT — same
Hypercore replication code path, just deterministic and fast (~20ms).
The DHT path is exercised separately by `smoke`.

Proves: K0_org actually does something (without it, replicated bytes
are opaque), multiple recipients in one bundle work, and the working
tree + encrypted log layout from `docs/workspace-format.md` matches
what's on disk.

## What none of these demos prove (each is its own tracked issue)

- Runtime DID and bundle recipient DID aren't unified through the
  runtime API yet — the scripts use independent identities for the
  bundle vs the runtime
- Topic-layer auth (#10) doesn't gate connections by UCAN today
- Autobase wrapper / encrypted store (#11) — `seal`/`open` runs at the
  application layer in `demo:acme`; the runtime doesn't yet handle
  encryption transparently
- Live key delivery log (#9) — Bob and Carol's envelopes are in the
  bundle today; the live-channel carrier for new joiners is pending
