// Windows implementation — STUB. Out of scope for this spike's findings doc;
// kept as a placeholder so the platform-extension shape is symmetric and a
// later contributor knows where to drop the file.
//
// Plausible plan (untested): same approach as macOS — react-native-windows
// TurboModule (`Microsoft.ReactNative`) that spawns a Node child process,
// IPC over named pipe (\\.\pipe\… instead of Unix socket).
//
// Risks worth flagging when this gets investigated:
//   - react-native-windows's TurboModule story has historically lagged the iOS/Android side
//   - Bundling Node.exe into a Windows app store package has its own constraints
//   - sodium-native / udx-native prebuilds for win32 are present but less battle-tested

import type { CreateRuntimeOptions, P2PRuntime } from './types.ts';

export async function createRuntime(_opts: CreateRuntimeOptions = {}): Promise<P2PRuntime> {
  throw new Error(
    '[@workspace.sh/p2p-runtime/windows] not investigated — out of scope for the current spike (PLAN.md). ' +
      'Likely shape: RN-Windows TurboModule + spawned Node child + named pipe IPC.',
  );
}

export type { P2PRuntime, Log, Did, TopicId, LogKey, CreateRuntimeOptions } from './types.ts';
