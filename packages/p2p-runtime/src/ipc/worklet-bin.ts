// Entry point for the Bare worklet — the iOS/Android counterpart to
// `child-bin.ts`.
//
// The macOS path spawns a Node child and speaks JSON-RPC over stdin/stdout.
// Mobile has no child processes, so `react-native-bare-kit` runs a Bare
// instance *in-process* and gives it a bidirectional byte channel
// (`BareKit.IPC`) instead of pipes. Everything above the byte channel is
// identical: this file is `child-bin.ts` with the two lines that touch stdio
// swapped for the two that touch IPC.
//
// That symmetry is the point. `Child` takes a write callback and a `feed()`
// method and knows nothing about how bytes arrive, so the protocol, the
// framing, and the runtime beneath are shared verbatim between platforms —
// mobile is a different transport, not a different implementation.
//
// Bundled with `bare-pack`, which resolves the builtins the runtime uses
// (fs, os, path) to their `bare-*` equivalents via this package's `imports`
// map. `child_process` is NOT among them: it is used only by the Node *parent*
// in `transport.node.ts`, never on the child side.
//
// That resolution only works because the runtime imports those builtins
// UNPREFIXED and uses `b4a` rather than `Buffer`. It did neither before #229,
// which is why this file had never successfully packed.

// Bare provides no TextEncoder/TextDecoder globals, and this file runs inside
// the Bare worklet on iOS/Android. b4a covers both hosts (#243).
import b4a from 'b4a';

import { createRuntime } from '../runtime.node.ts';
import { Child } from './child.ts';

declare const BareKit: {
  IPC: {
    write(data: Uint8Array | string): void;
    on(event: 'data', cb: (data: Uint8Array) => void): void;
    on(event: 'close', cb: () => void): void;
  };
};

// Same runtime as the macOS child: `runtime.node.ts` is named for its original
// host but is host-agnostic, so both entry points bind the same implementation.
const child = new Child((s) => {
  BareKit.IPC.write(s);
}, createRuntime);

BareKit.IPC.on('data', (data) => {
  const chunk = typeof data === 'string' ? data : b4a.toString(data, 'utf8');
  child.feed(chunk).catch((err: unknown) => {
    // No stderr to inherit here — the host sees this through liblog, which is
    // where console output from a worklet goes.
    console.error(`[worklet] feed crashed: ${(err as Error).stack ?? String(err)}`);
  });
});
