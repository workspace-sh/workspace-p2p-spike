# workspace-p2p-spike

research spike: evaluate Hypercore as Workspace's P2P data layer across iOS, Android, and macOS (and eventually Windows), with a single shared TypeScript codebase and platform-specific bootstrap layers.

**status: scaffolded, phases not yet started.** the monorepo + library shape is in place; the actual replication smoke tests, BareKit integration, and macOS native module are still to do. read [PLAN.md](./PLAN.md) for the phased scope.

## tldr

- evaluate Hypercore (via Holepunch/Bare) as a unified P2P substrate
- mobile (iOS/Android) path is documented: `react-native-bare-kit` + `bare-pack`
- macOS path is the open question: requires a bespoke native module spawning a Node.js child process, with TurboModule IPC
- web is supported as a stub today (browser cannot host Hypercore directly; would need a relay or WASM port)
- Windows compatibility is noted but out of scope for this spike's findings doc
- output: a written go/no-go recommendation plus a sketched `@workspace/p2p-runtime` interface

## layout

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

## install + typecheck

```sh
npm install
npm run typecheck
```

`npm install` is intentionally light at this stage — no hypercore / hyperswarm / Expo / react-native-macos toolchain is pulled in until the relevant phase begins. Adding those happens in their own commits.

## out of scope (call-outs from PLAN.md)

- UCAN integration — separate later spike. Findings from a parallel UCAN exploration are preserved at [docs/ucan-prior-research.md](./docs/ucan-prior-research.md).
- Any UI work.
- Bundling Node.js inside the macOS app (later concern).
- Hyperdrive, Autobase, or higher-level abstractions.

## related

- [`workspace-sh/workspace`](https://github.com/workspace-sh/workspace) — the consuming app
- [`workspace-sh/table-file-format`](https://github.com/workspace-sh/table-file-format) — sibling research repo, same shape
