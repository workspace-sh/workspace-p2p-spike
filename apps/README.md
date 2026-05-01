# apps/

Per-host harnesses that consume `@workspace/p2p-runtime`. Empty until the relevant phase of [PLAN.md](../PLAN.md) begins.

When ready, scaffold:

| dir         | purpose                                         | scaffold command (rough)                                              | phase   |
|-------------|-------------------------------------------------|-----------------------------------------------------------------------|---------|
| `node/`     | standalone two-instance replication smoke test | `npm init -w apps/node` (plain Node script, no host framework)        | 1       |
| `mobile/`   | Expo 55 dev-client with `react-native-bare-kit` | `npx create-expo-app@latest --template blank-typescript`              | 2       |
| `macos/`    | react-native-macos host with bespoke TurboModule | scaffold from `react-native-macos` init template                      | 3       |
| `web/`      | browser smoke harness for the TS interface only | Vite + React + RSD (matching `workspace-sh/table-file-format`'s shape) | (any)  |
| `windows/`  | (placeholder; see PLAN.md out-of-scope note)    | not investigated                                                      | future |

Once an app exists, add it to the root `package.json` `workspaces` array (alongside `packages/*`).

## Why empty for now

`npm install` at the repo root would otherwise pull in Expo's full toolchain, react-native-macos's CocoaPods/Xcode chain, etc., before any spike work begins. Keep the surface light until each phase actually starts.
