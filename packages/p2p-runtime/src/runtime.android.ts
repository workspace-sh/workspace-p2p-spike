// Android implementation of @workspace.sh/p2p-runtime.
//
// Identical to iOS: `react-native-bare-kit` runs the same Bare worklet, over
// the same IPC byte channel, driving the same `SpawnedRuntime`. Bare ships
// Tier 1 Android prebuilds (arm, arm64, ia32, x64).
//
// Re-exported rather than reimplemented so the two platforms cannot drift.
// If they ever need to diverge, this file is the seam to open — but a
// duplicate that starts identical is a duplicate that silently stops being so.
//
// The remaining Android-specific unknowns are not in this layer: Doze-mode
// battery restrictions on background sync (docs/risks.md §2), and the
// `bare-pack --target android` bundle differing from the iOS one.

export {
  createRuntime,
  SpawnedRuntime,
  BareTransport,
  type BareWorklet,
  type IOSRuntimeOptions as AndroidRuntimeOptions,
} from './runtime.ios.ts';

export type {
  P2PRuntime,
  Log,
  Did,
  TopicId,
  LogKey,
  CreateRuntimeOptions,
} from './types.ts';
