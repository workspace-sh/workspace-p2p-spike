// iOS implementation of @workspace.sh/p2p-runtime.
//
// Mobile has no child processes, so instead of spawning Node via NSTask this
// runs a Bare instance in-process through `react-native-bare-kit`. Bare ships
// Tier 1 prebuilds for iOS (arm64 + simulator) and is what Keet uses in
// production, so the Hypercore stack under it is a known quantity rather than
// an experiment.
//
// Everything above the byte channel is shared with macOS: same JSON-RPC
// protocol, same framing, same `SpawnedRuntime`. Only the transport differs —
// which is the whole reason `Transport` exists as a five-member interface.
//
// Setup (host app):
//   1. npm i react-native-bare-kit
//   2. Bundle the worklet:  bare-pack --target ios --linked --out app.bundle \
//        packages/p2p-runtime/src/ipc/worklet-bin.ts
//   3. Load that bundle and pass it as `bundle` below, with a fresh Worklet.
//
// The bundle is passed in rather than read here so this module keeps no
// opinion about asset loading — which differs between Expo, bare RN, and a
// test harness.

import { SpawnedRuntime } from './ipc/parent.ts';
import { BareTransport, type BareWorklet } from './ipc/transport.ios.ts';
import type { CreateRuntimeOptions, P2PRuntime } from './types.ts';

export interface IOSRuntimeOptions extends CreateRuntimeOptions {
  /** A `new Worklet()` from `react-native-bare-kit`. Injected so this module
   *  never imports the native package directly, keeping it testable against a
   *  fake and importable where the native side isn't installed. */
  worklet: BareWorklet;

  /** The `bare-pack` bundle for `worklet-bin.ts`. */
  bundle: ArrayBuffer | Uint8Array | string;

  /** Entry filename the worklet reports. Defaults to `/app.bundle`. */
  filename?: string;
}

export async function createRuntime(opts: IOSRuntimeOptions): Promise<P2PRuntime> {
  const transport = new BareTransport({
    worklet: opts.worklet,
    filename: opts.filename,
  });
  await transport.start(opts.bundle);

  const runtime = new SpawnedRuntime({ transport, storage: opts.storage });
  await runtime.ready();
  return runtime;
}

export { SpawnedRuntime } from './ipc/parent.ts';
export { BareTransport, type BareWorklet } from './ipc/transport.ios.ts';
export type {
  P2PRuntime,
  Log,
  Did,
  TopicId,
  LogKey,
  CreateRuntimeOptions,
} from './types.ts';
