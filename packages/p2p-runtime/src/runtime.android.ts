// Android implementation — STUB. Filled in during Phase 2 of PLAN.md.
// Same shape as runtime.ios.ts; both target react-native-bare-kit.

import type { CreateRuntimeOptions, P2PRuntime } from './types.ts';

export async function createRuntime(_opts: CreateRuntimeOptions = {}): Promise<P2PRuntime> {
  throw new Error(
    '[@workspace.sh/p2p-runtime/android] not implemented yet — Phase 2 of PLAN.md (react-native-bare-kit + bare-pack)',
  );
}

export type { P2PRuntime, Log, Did, TopicId, LogKey, CreateRuntimeOptions } from './types.ts';
