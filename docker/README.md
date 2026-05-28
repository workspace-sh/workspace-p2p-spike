# Containerised P2P testing

Anything that exercises Hyperswarm, hyperdht, or multi-peer flows runs
**inside containers** by default. The host machine never touches those
sockets, never spawns those processes, and is protected by hard memory
and CPU limits per container.

This was set up after a host-level system fault during P2P testing.
The fault probably wasn't directly caused by the test load — but
isolating the test load is the cheap insurance.

## Why containers, not bare host

| Concern | Bare host | Container |
|---|---|---|
| Runaway memory | Eats whole machine | Killed at limit (512MB for Acme) |
| Runaway CPU | Slows machine | Limited to 1.0 CPU |
| Socket exhaustion | Affects host networking | Confined to container namespace |
| Cleanup if Node hangs | `kill -9` + hope | `docker compose down` always works |
| Network impact | Real packets on host network | Stay inside Docker's bridge |
| Reproducibility | Depends on host state | Same image, same behaviour |

The bare-host scripts (`npm run smoke`, `demo:end-to-end`,
`demo:acme:live`) still exist for when you're explicitly testing the
real Hyperswarm or local-host setup. The container is the default for
anything iterative.

## Usage

From the repo root:

```sh
# Build the image once (or after dep changes)
docker compose build

# Run the Acme demo against a containerised private DHT
docker compose up acme
```

`docker compose up acme` brings up the `bootstrap` service first, then
runs `acme` against it. The demo runs to completion and exits;
the bootstrap stops when the compose command tears down.

Clean shutdown if anything's stuck:

```sh
docker compose down
```

## The testing matrix

Five modes, picking the right one for the situation:

| Mode | Network | Use case | Where it runs |
|---|---|---|---|
| **1. Unit tests** | None | Day-to-day dev | Host — `npm test` |
| **2. Pipe-only demo** | None | Multi-peer flows without sockets | Host — `demo:acme` |
| **3. Containerised private DHT** | Loopback inside container | Real swarm transport without host impact | Container — `docker compose up acme` |
| **4. Bare-host private DHT** | Loopback on host | Same as 3 but without Docker overhead | Host — `demo:bootstrap` + `demo:acme:live` |
| **5. Live public DHT** | Real internet | Verifying the actual Hyperswarm DHT | Host — `smoke`, `demo:end-to-end` |

Default to 1 and 2. Reach for 3 when you need the swarm transport
exercised. Use 4 only when Docker isn't available. Use 5 only when
explicitly verifying the public-DHT path.

## What's inside

- `docker/Dockerfile` — Node 20 with the build toolchain for native
  modules (`sodium-universal`, `hypercore-crypto`, `corestore`). Slim
  image; ~200MB.
- `docker-compose.yml` — two services: `bootstrap` and `acme`, on a
  private `p2p-internal` bridge network. Hard resource limits per
  container.
- `.dockerignore` — excludes `node_modules`, build artefacts, the
  macOS app sources, and other things the build doesn't need.

## Cross-references

- [`apps/node/README.md`](../apps/node/README.md) — the demo scripts
  themselves
- [`docs/discovery-layers.md`](../docs/discovery-layers.md) — the
  architectural framing for local-first / LAN / WAN; explains why
  private DHT is a first-class story
