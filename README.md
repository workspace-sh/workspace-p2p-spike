# Workspace P2P Spike

research spike: evaluate Hypercore as Workspace's P2P data layer across iOS, Android, and macOS (and eventually Windows), with a single shared TypeScript codebase and platform-specific bootstrap layers.

**status: phase 1 done.** Node implementation works; two runtimes replicate over real Hyperswarm; integration test green. Phases 2 (BareKit on iOS/Android) and 3 (RN-macOS + spawned Node) are not yet started. read [PLAN.md](./PLAN.md) for the full phased scope.

## TL;DR

- evaluate Hypercore (via Holepunch/Bare) as a unified P2P substrate
- mobile (iOS/Android) path is documented: `react-native-bare-kit` + `bare-pack`
- macOS path is the open question: requires a bespoke native module spawning a Node.js child process, with TurboModule IPC
- web is supported as a stub today (browser cannot host Hypercore directly; would need a relay or WASM port)
- Windows compatibility is noted but out of scope for this spike's findings doc
- output: a written go/no-go recommendation plus a sketched `@workspace/p2p-runtime` interface

## Layout

```
.
├── PLAN.md                    # the issue — phases, scope, out-of-scope, risks
├── README.md
├── docs/
│   └── ucan-prior-research.md # findings from a parallel UCAN+Hypercore exploration
├── packages/
│   └── p2p-runtime/           # @workspace/p2p-runtime — TS interface + per-platform stubs
│       └── src/
│           ├── types.ts             # P2PRuntime, Log, Did, …
│           ├── runtime.ts           # default entry; throws if no platform matched
│           ├── runtime.node.ts      # Phase 1 target
│           ├── runtime.ios.ts       # Phase 2 (BareKit)
│           ├── runtime.android.ts   # Phase 2 (BareKit)
│           ├── runtime.macos.ts     # Phase 3 (RN-macOS + spawned Node)
│           ├── runtime.web.ts       # browser stub
│           └── runtime.windows.ts   # noted, not investigated
└── apps/
    └── README.md              # how each per-host harness gets scaffolded, when
```

## Install + Verify

```sh
npm install         # pulls corestore + hyperswarm + b4a (~80 packages)
npm run typecheck   # tsc --noEmit across the workspace
npm run test        # integration tests for runtime.node.ts (no network, ~3s)
```

End-to-end smoke against the real Hyperswarm DHT (needs internet):

```sh
npm -w @workspace/p2p-spike-node run smoke
```

This spins up two `NodeRuntime` instances in one process, joins them on a shared topic, appends three blocks on peer A, and reads them back on peer B. Last verified run replicated in **259 ms**.

Note: this is npm-only. Bun is not used because `react-native-macos` and Bun do not play well together; the eventual main monorepo will be npm-driven for the same reason.

## Out of Scope (call-outs from PLAN.md)

- UCAN integration — separate later spike. Findings from a parallel UCAN exploration are preserved at [docs/ucan-prior-research.md](./docs/ucan-prior-research.md).
- Any UI work.
- Bundling Node.js inside the macOS app (later concern).
- Hyperdrive, Autobase, or higher-level abstractions.

## Related

- [`workspace-sh/workspace`](https://github.com/workspace-sh/workspace) — the consuming app
- [`workspace-sh/table-file-format`](https://github.com/workspace-sh/table-file-format) — format spike; outcomes there benefit text and text/binary (SQLite) file formats downstream, and inform anything Workspace eventually persists
