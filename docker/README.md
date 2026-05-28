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

## Choosing a runtime

"Docker" here means the *CLI contract* and the *OCI image format*, not
necessarily Docker Inc.'s engine. Multiple runtimes implement the same
`docker` CLI and the same Compose Specification — pick whichever fits
your platform and licensing preferences.

### macOS — three options, FOSS preferred

| Runtime | Footprint | Licence | Install |
|---|---|---|---|
| **Colima** (recommended) | ~1–2GB | Apache 2.0 (fully FOSS) | `brew install colima docker` |
| OrbStack | ~1–2GB | Source-available, commercial above small-team threshold | `brew install --cask orbstack` |
| Docker Desktop | ~3–4GB | Commercial above $10M revenue / 250 people | [docs.docker.com/desktop](https://docs.docker.com/desktop/install/mac-install/) |

**We lean Colima** — fully open-source (Apache 2.0 on Colima itself
and on Lima, which it wraps), uses Apple's Virtualization.framework
under the hood, no GUI daemon at idle, free of commercial-licensing
considerations. OrbStack is polished and great as a UX but its
source-available licence isn't open-source in the strict sense.

After `brew install colima docker`, you need to start the VM once:

```sh
colima start
```

It stays running in the background until `colima stop`. The `docker`
CLI then works as normal.

### Linux — native Docker Engine

```sh
# Debian/Ubuntu
sudo apt install docker.io
# Or follow the distro-specific instructions at docs.docker.com

# Optionally add yourself to the docker group
sudo usermod -aG docker $USER
```

No VM, no Desktop GUI — the daemon runs natively. Lightest of any
platform. Podman is a fully FOSS alternative (`alias docker=podman`
and most things work).

### Windows

- **WSL2 + Docker Engine** — lightest. Install WSL2, install Docker
  Engine inside the Linux distro. `docker` works from both Windows
  PowerShell and the WSL shell.
- **Docker Desktop for Windows** — path of least resistance; uses
  WSL2 as its backend anyway.
- **Podman Desktop** — FOSS alternative.

## Usage

From the repo root, once you have a runtime installed and running:

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

The compose file and Dockerfile are runtime-agnostic — the commands
above work identically across Colima, OrbStack, Docker Desktop,
native Linux Docker Engine, Podman, and Podman Desktop.

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

- `docker/Dockerfile` — Node 22 with the build toolchain for native
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
