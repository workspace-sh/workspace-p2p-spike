# @workspace/p2p-runtime

P2P runtime interface + per-platform implementations. The TypeScript shape every Workspace surface (web, mobile via Expo, macOS via react-native-macos, eventually Windows) talks to.

**Status: Phase 1 done.** `runtime.node.ts` is implemented (corestore + hyperswarm) and verified end-to-end via [`apps/node`](../../apps/node). Phases 2 (BareKit on iOS/Android) and 3 (RN-macOS + spawned Node) are not yet started.

## Shape

```ts
import { createRuntime, type P2PRuntime } from '@workspace/p2p-runtime';

const runtime = await createRuntime({ storage: '/path/to/data' });
await runtime.ready();
console.log(runtime.did());

const log = await runtime.createLog();
await log.append(new TextEncoder().encode('hello'));

await runtime.joinTopic('…32-byte-hex…');
```

## Platform Resolution

The bundler picks the matching `runtime.<platform>.ts`:

| target              | extension                            | bundler signal                                            |
|---------------------|--------------------------------------|-----------------------------------------------------------|
| iOS                 | `runtime.ios.ts`                     | Metro platform extension                                  |
| Android             | `runtime.android.ts`                 | Metro platform extension                                  |
| macOS (RN-macOS)    | `runtime.macos.ts`                   | Metro platform extension (`react-native-macos` registers) |
| Windows (RN-Win)    | `runtime.windows.ts` (placeholder)   | Metro platform extension                                  |
| Web (browser)       | `runtime.web.ts`                     | Vite alias / `resolve.conditions`                         |
| Plain Node          | `runtime.node.ts`                    | `package.json` `exports["./node"]`, import explicitly     |

For plain Node consumers (the Phase 1 smoke test, the spawned-Node child on macOS), import directly:

```ts
import { createRuntime } from '@workspace/p2p-runtime/node';
```

## Why This Shape

The interface is deliberately small (`createLog` / `openLog` / `joinTopic` / `leaveTopic`) so the same TypeScript surface compiles unchanged across hosts that route to wildly different runtimes underneath — a Bare worklet on mobile, a spawned Node child on macOS, a stub on web. See PLAN.md Phase 4 for the design rationale.
