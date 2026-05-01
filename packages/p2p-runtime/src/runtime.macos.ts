// macOS implementation — STUB. Filled in during Phase 3 of PLAN.md.
//
// Plan: bespoke TurboModule on the react-native-macos side that spawns a Node
// child process running runtime.node.ts. IPC over stdin/stdout (or a Unix socket).
// The TS surface here mirrors runtime.node.ts but every call serialises to the
// child process and back.
//
// This is the open question of the spike — see PLAN.md Phase 3.

import type { CreateRuntimeOptions, P2PRuntime } from './types.ts';

export async function createRuntime(_opts: CreateRuntimeOptions = {}): Promise<P2PRuntime> {
  throw new Error(
    '[@workspace/p2p-runtime/macos] not implemented yet — Phase 3 of PLAN.md (RN-macOS TurboModule + spawned Node child)',
  );
}

export type { P2PRuntime, Log, Did, TopicId, LogKey, CreateRuntimeOptions } from './types.ts';
