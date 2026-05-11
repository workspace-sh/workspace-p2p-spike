// macOS implementation of @workspace/p2p-runtime.
//
// Uses a bespoke TurboModule (P2PRuntimeModule) that spawns a Node child
// process via NSTask and bridges its stdin/stdout to JS as native events.
// The JSON-RPC protocol is identical to the Node path (Phase 3a) — only the
// spawning mechanism differs.
//
// Integration checklist for the RN-macOS app (apps/macos):
//   1. Add P2PRuntimeModule.h / .mm to the Xcode target (see apps/macos/native/)
//   2. Run `pod install` (module is auto-linked via RCT_EXPORT_MODULE)
//   3. Call createRuntime({ childScriptPath: '...', nodeBin: '...' })
//   4. nodeBin defaults to the `node` binary found on $PATH; in production
//      you'd bundle a static Node binary and set an explicit path.

import { SpawnedRuntime } from './ipc/parent.ts';
import { MacOSTransport } from './ipc/transport.macos.ts';
import type { CreateRuntimeOptions, P2PRuntime } from './types.ts';

export interface MacOSRuntimeOptions extends CreateRuntimeOptions {
  /**
   * Absolute path to the child entrypoint script.
   * During development this is the source child-bin.ts; in a release build
   * point to the bundled/compiled JS output instead.
   */
  childScriptPath: string;

  /**
   * Absolute path to the Node binary.
   * Defaults to 'node' (relies on $PATH). For a fully self-contained app,
   * bundle a static Node binary and pass its path here.
   */
  nodeBin?: string;
}

export async function createRuntime(opts: MacOSRuntimeOptions): Promise<P2PRuntime> {
  const transport = new MacOSTransport();
  await transport.spawn(
    opts.nodeBin ?? 'node',
    opts.childScriptPath,
    opts.storage ?? null,
  );

  // SpawnedRuntime takes the pre-spawned transport; ready() sends the 'init'
  // JSON-RPC call and caches the DID.
  const runtime = new SpawnedRuntime({ transport, storage: opts.storage });
  await runtime.ready();
  return runtime;
}

export { SpawnedRuntime } from './ipc/parent.ts';
export { MacOSTransport } from './ipc/transport.macos.ts';
export type { MacOSRuntimeOptions };
export type {
  P2PRuntime,
  Log,
  Did,
  TopicId,
  LogKey,
  CreateRuntimeOptions,
} from './types.ts';
