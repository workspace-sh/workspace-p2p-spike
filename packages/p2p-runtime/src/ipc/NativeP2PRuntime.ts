// Native module accessor for the macOS P2P runtime bridge.
//
// This app (workspace-sh/workspace) doesn't use TurboModule Codegen — no
// `codegenConfig`, no other native module uses `TurboModuleRegistry` — every
// existing module (FileOpener, SidebarBridge, ScrollWheelBridge,
// CanvasControlsBridge) is accessed via the classic `NativeModules.<Name>` +
// `NativeEventEmitter` bridge, matching apps/desktop's own convention (see
// apps/desktop/src/native/FileOpener.ts). This file follows the same
// pattern rather than the spike's original TurboModuleRegistry approach.
//
// Two events are emitted from native → JS:
//   'p2pLine'  { line: string }  — one complete stdout line from the child
//   'p2pExit'  { code: number }  — child process exited
//
// The native module handles all NSTask lifecycle; JS only calls send() and
// receives events. No polling, no timers.

import { NativeModules } from 'react-native';

export interface P2PRuntimeNativeModule {
  /**
   * Spawn the Node child process.
   * nodeBin    — absolute path to the node binary
   * scriptPath — absolute path to child-bin.ts (or compiled .js in prod)
   * storage    — passed as an env var so the child can init Corestore
   *              (unused by @workspace.sh/workspace's own child-bin, which
   *              receives storage via the RPC payload instead — kept for
   *              parity with the low-level protocol's child-bin.ts)
   */
  spawn(nodeBin: string, scriptPath: string, storage: string | null): Promise<void>;

  /** Write a complete newline-terminated JSON-RPC line to the child's stdin. */
  send(line: string): void;

  /** Terminate the child and wait for it to exit. */
  close(): Promise<void>;

  /**
   * This device's persistent 32-byte identity seed, as hex. Get-or-create:
   * generated via SecRandomCopyBytes and stored in the macOS Keychain on
   * first call; the same seed is returned on every subsequent call. See
   * docs/identity-recovery.md (device-linking flow).
   */
  identitySeed(): Promise<string>;

  /**
   * `<Application Support>/<bundle id>/p2p/<subpath>`, created if needed.
   * Never default corestore storage into a workspace's own (possibly
   * cloud-synced) folder — see docs/workspace-format.md invariant 4.
   */
  storagePath(subpath: string): Promise<string>;

  // ------ EventEmitter boilerplate (required by RN for native event modules) ------
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

const NativeP2PRuntime: P2PRuntimeNativeModule = NativeModules.P2PRuntime;

export default NativeP2PRuntime;
