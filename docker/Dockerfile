# Spike test image — Node 20 with all native modules pre-built.
#
# Used by docker-compose.yml to run the bootstrap node and the live Acme
# demo in isolation from the host. Native modules (sodium-universal,
# hypercore-crypto, corestore) compile during `npm ci` using the build
# toolchain that the slim image already includes via `python3` + `make` +
# `g++`.

FROM node:20-bookworm-slim AS base

# Build tooling for native modules. `node-gyp` needs python3, make, and a
# C++ compiler.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /spike

# Copy package manifests first so dep installs cache cleanly across
# source-only changes.
COPY package.json package-lock.json ./
COPY packages/p2p-runtime/package.json    packages/p2p-runtime/package.json
COPY packages/ucan-boundary/package.json  packages/ucan-boundary/package.json
COPY packages/portable-bootstrap/package.json packages/portable-bootstrap/package.json
COPY apps/node/package.json               apps/node/package.json

RUN npm ci --ignore-scripts=false

# Copy source.
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/node apps/node

# Default command is a shell — actual commands are specified per service
# in docker-compose.yml.
CMD ["bash"]
