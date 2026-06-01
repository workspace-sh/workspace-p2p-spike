// iOS implementation — STUB. Filled in during Phase 2 of PLAN.md.
//
// Plan: thin RPC client over BareKit IPC. The actual Hypercore stack runs
// inside a Bare worklet packaged with `bare-pack`; this file is the host-side
// surface that mirrors `runtime.node.ts`'s shape.

import type { CreateRuntimeOptions, P2PRuntime } from './types.ts';

export async function createRuntime(_opts: CreateRuntimeOptions = {}): Promise<P2PRuntime> {
  throw new Error(
    '[@workspace.sh/p2p-runtime/ios] not implemented yet — Phase 2 of PLAN.md (react-native-bare-kit + bare-pack)',
  );
}

export type { P2PRuntime, Log, Did, TopicId, LogKey, CreateRuntimeOptions } from './types.ts';
