# @workspace/p2p-spike-node

Phase 1 smoke harness. Standalone Node script that spins up two `NodeRuntime` instances, joins them on a shared Hyperswarm topic, and verifies a log replicates end-to-end.

## Run

```sh
npm -w @workspace/p2p-spike-node run smoke
```

Requires internet access — Hyperswarm needs the public DHT to bootstrap. Replication itself is local once peers connect.

## What it proves

This script is the answer to PLAN.md Phase 1: *"Confirm two instances can replicate via Hyperswarm on the same machine."*

The integration test at `packages/p2p-runtime/tests/replicate.test.ts` exercises the replication code path without the network (direct duplex pipe). This script exercises **discovery + transport** through the real swarm.

## What it doesn't prove

- Cross-process replication (both peers run inside one Node process here).
- Replication across machines (no NAT traversal in scope yet).
- Anything about mobile or macOS — those are Phase 2 / Phase 3.
