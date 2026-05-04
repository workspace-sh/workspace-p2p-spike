// Spawned runtime — a P2PRuntime backed by a Node child process.
//
// Used directly by tests (proves the IPC mechanism). The macOS implementation
// in runtime.macos.ts will reuse the SpawnedRuntime *protocol* but spawn via
// the TurboModule's NSTask instead of Node's child_process.spawn.
//
// The naming is deliberate: this file is platform-neutral plumbing; the
// platform-specific .ts files only swap the spawning step.

import { SpawnedRuntime, type SpawnedRuntimeOptions } from './ipc/parent.ts';
import type { CreateRuntimeOptions, P2PRuntime } from './types.ts';

export async function createRuntime(
  opts: CreateRuntimeOptions = {},
): Promise<P2PRuntime> {
  const r = new SpawnedRuntime(opts as SpawnedRuntimeOptions);
  await r.ready();
  return r;
}

export { SpawnedRuntime } from './ipc/parent.ts';
export type { SpawnedRuntimeOptions } from './ipc/parent.ts';
export type {
  P2PRuntime,
  Log,
  Did,
  TopicId,
  LogKey,
  CreateRuntimeOptions,
} from './types.ts';
