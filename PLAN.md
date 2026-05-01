# Spike: Evaluate Hypercore for Workspace's P2P data layer (findings doc)

## Goal

Produce a findings document that answers: can we adopt Hypercore as Workspace's P2P data layer across iOS, Android, and macOS, with a single shared TypeScript codebase for the P2P logic and platform-specific bootstrap layers? The output of this spike is a written recommendation, not a merged feature.

## Context

- We've been evaluating P2P tech for Workspace and have landed on Hypercore (via the Holepunch/Pear/Bare ecosystem) as the most promising candidate over IPFS. Reasons:
  - Native mutability (append-only logs) vs IPFS's IPNS-as-afterthought
  - Better default privacy (Hyperswarm uses discovery key hashes, not raw content hashes)
  - Cleaner data model for app state vs content-addressed blob store
- The intended architecture: shared TypeScript for the Hypercore/Hyperswarm logic, with a platform-specific bootstrap and IPC layer.

## Per-platform integration strategy to validate

| Platform | Host                | P2P runtime                              | IPC mechanism                | Maturity |
|----------|---------------------|-------------------------------------------|------------------------------|----------|
| iOS      | React Native        | Bare worklet via `react-native-bare-kit`  | BareKit IPC                  | Official |
| Android  | React Native        | Bare worklet via `react-native-bare-kit`  | BareKit IPC                  | Official |
| macOS    | react-native-macos  | Node.js child process (spawned natively)  | stdin/stdout or Unix socket  | Bespoke — no off-the-shelf library |

The mobile path is the "happy path" — install a package, use a documented API. The macOS path requires writing a native module that spawns Node and exposes a Worklet-like API surface to JS, because no equivalent of `react-native-bare-kit` exists for macOS.

## Spike scope (in priority order)

### Phase 1 — Validate the shared core in isolation

1. Create a minimal Node.js script that initializes a Hypercore, writes test data, reads it back. Confirm two instances can replicate via Hyperswarm on the same machine.

### Phase 2 — Validate the mobile path

2. In a side branch, install `react-native-bare-kit` and bundle the Phase 1 script with `bare-pack`.
3. Verify IPC round-trip on iOS via the bare-expo example as reference.
4. Smoke-test on Android.
5. Document any pain points (bundle size, cold start, missing Bare-side modules).

### Phase 3 — Validate the macOS path (the open question)

6. In the react-native-macos branch, write a minimal native module that spawns a Node.js child process and exposes a TurboModule / NativeModule API.
7. Wire up stdin/stdout-based IPC.
8. Run the same Phase 1 script under the spawned Node process.
9. Document the actual implementation effort, any react-native-macos-specific gotchas, and how Node.js gets resolved (system Node during dev; how would we ship it later).

### Phase 4 — Design the unified abstraction

10. Sketch what `@workspace/p2p-runtime` looks like — a TypeScript interface implemented per-platform via `.ios.ts` / `.android.ts` / `.macos.ts` files.
11. Confirm the same Hypercore JS bundle can be consumed by both the Bare worklet (mobile) and the spawned Node process (macOS) without per-platform changes to the shared logic.

## Output

A findings document committed to the repo (location TBD per existing convention) covering:

- Whether each platform path actually worked end-to-end
- Effort estimate for the macOS native module to reach production quality
- Known limitations (bundle size, cold start, missing modules, lifecycle quirks)
- Recommended `@workspace/p2p-runtime` interface shape
- Go/no-go recommendation, with the alternative being either Hypercore-mobile-only-for-now or a different stack entirely

## Out of scope

- Hyperdrive, Autobase, or any higher-level abstractions
- Multi-device sync over the network (only same-machine replication for the spike)
- UCAN integration (separate later spike)
- Any UI work
- Production hardening of the relay infra
- Bundling Node.js inside the macOS app (acknowledged as a later concern; spike can use the system Node)

## Risks / open questions to surface

- Whether the macOS native module work is small enough to be worth doing in-house, or large enough to warrant either contributing macOS support upstream to react-native-bare-kit or picking a different stack
- Whether Bare's standard library coverage is sufficient for Hypercore's dependency tree (some npm packages assume Node-specific APIs)
- Whether react-native-macos's TurboModule story is mature enough to support this
- How divergent the IPC framing needs to be between BareKit and child-process pipes — and whether we can hide that behind one TypeScript interface

## Reference links

- https://github.com/holepunchto/react-native-bare-kit
- https://github.com/holepunchto/bare-expo
- https://github.com/holepunchto/bare
- https://github.com/holepunchto/bare-kit
- https://github.com/holepunchto/hypercore
- https://blog.mauve.moe/posts/hyper-react-native (background: nodejs-mobile + Hypercore for mobile)
- https://docs.pears.com/
