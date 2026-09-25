// Reusable IPC primitives — transport + wire framing, protocol-agnostic.
//
// Exposed as a package entry point (`@workspace.sh/p2p-runtime/ipc`) so other
// packages can build their OWN JSON-RPC protocol over the same spawn/transport
// mechanics without depending on this package's specific Log/runtime protocol.
// `@workspace.sh/workspace`'s own IPC layer (a Workspace-level protocol, not a
// Log-level one) is the first consumer — see packages/workspace/src/ipc/.
//
// Node-safe only. MacOSTransport imports 'react-native' at module-eval time
// (ESM re-exports load eagerly, no tree-shaking under plain `node`), so it's
// deliberately NOT re-exported here — import it from
// `@workspace.sh/p2p-runtime/ipc/macos` instead, from a `.macos.ts`-suffixed
// consumer file only (same split as runtime.node.ts / runtime.macos.ts).
//
// The same eager-evaluation caveat applies to NodeTransport below, in the
// other direction: it pulls `node:child_process` / `node:url` / `node:path`,
// none of which resolve under Bare, so importing this barrel from anything
// that has to pack into a worklet breaks the mobile bundle. Child-side code
// wants `@workspace.sh/p2p-runtime/ipc/framing`, which is just the wire
// framing and nothing else (#229).

export { encode, LineDecoder } from './framing.ts';
export type { Transport } from './transport.ts';
export { NodeTransport } from './transport.node.ts';
export type { NodeTransportOptions } from './transport.node.ts';
