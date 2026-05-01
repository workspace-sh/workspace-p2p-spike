# workspace-p2p-spike

research spike: evaluate Hypercore as Workspace's P2P data layer across iOS, Android, and macOS, with a single shared TypeScript codebase and platform-specific bootstrap layers.

**status: parked.** work has not started. this repo holds the plan; the findings doc lands here when the phases run.

read [PLAN.md](./PLAN.md) for full scope, phases, out-of-scope, and risks.

## tldr

- evaluate Hypercore (via Holepunch/Bare) as a unified P2P substrate for Workspace
- mobile (iOS/Android) path is documented: `react-native-bare-kit` + `bare-pack`
- macOS path is the open question: requires a bespoke native module spawning a Node.js child process, with TurboModule IPC
- output: a written go/no-go recommendation plus a sketched `@workspace/p2p-runtime` interface

## out of scope (call-outs)

- UCAN integration — that's a separate later spike
- any UI work
- bundling Node.js inside the macOS app (later concern)

## related

- [`workspace-sh/workspace`](https://github.com/workspace-sh/workspace) — the consuming app
- [`workspace-sh/table-file-format`](https://github.com/workspace-sh/table-file-format) — sibling research repo, same shape
