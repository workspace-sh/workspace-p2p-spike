# @workspace/p2p-spike-node

Two scripts for exercising the spike against the real Hyperswarm DHT.
Both need internet access to bootstrap the swarm.

## `smoke` — runtime-only

Two `NodeRuntime` instances find each other via the public DHT and
replicate a log. Exercises **discovery + transport** through the real
swarm (the unit test at `packages/p2p-runtime/tests/replicate.test.ts`
exercises the same code path via a direct duplex pipe — no network).

```sh
npm -w @workspace/p2p-spike-node run smoke
```

## `demo` — end-to-end design demonstration

The first cohesive end-to-end walk-through of the design:

1. Peer A creates a workspace (root identity, root attestation, K0_org)
2. Peer A writes a `.workspace/` bundle to disk for Peer B
   (sealed envelope addressed to B's DID, carrying K0_org + UCAN)
3. Peer B reads the folder, validates the attestation, unwraps the envelope
4. Both peers join the workspace's topic — derived from `workspaceId`
   (which IS the root pubkey)
5. Peer A appends data to a Hypercore log
6. Peer B opens the log and reads the data back via Hyperswarm

```sh
npm -w @workspace/p2p-spike-node run demo
```

What this proves: bundle round-trips through disk, attestation verifies
across the boundary, envelope unwraps cleanly, and the topic derivation
joins the bundle flow to the replication flow without any out-of-band
coordination.

What it doesn't prove (each is its own tracked issue):

- The unwrapped K0_org isn't yet used to decrypt log content — the
  encrypted store layer (#11 / Autobase) is the next piece
- Runtime DID and bundle recipient DID aren't unified through the
  runtime API yet — the script uses independent identities for the
  bundle vs the runtime
- Topic-layer auth (#10) doesn't gate connections by UCAN today; the
  script demonstrates the topic join, not the authorisation check
