// React Native TurboModule spec for the macOS P2P runtime bridge.
//
// This file is the Codegen input. RN's build system reads it and generates
// the Obj-C++ protocol that P2PRuntimeModule.mm must implement.
//
// Two events are emitted from native → JS:
//   'p2pLine'  { line: string }  — one complete stdout line from the child
//   'p2pExit'  { code: number }  — child process exited
//
// The native module handles all NSTask lifecycle; JS only calls send() and
// receives events. No polling, no timers.

import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  /**
   * Spawn the Node child process.
   * nodeBin    — absolute path to the node binary
   * scriptPath — absolute path to child-bin.ts (or compiled .js in prod)
   * storage    — passed as an env var so the child can init Corestore
   */
  spawn(nodeBin: string, scriptPath: string, storage: string | null): Promise<void>;

  /** Write a complete newline-terminated JSON-RPC line to the child's stdin. */
  send(line: string): void;

  /** Terminate the child and wait for it to exit. */
  close(): Promise<void>;

  // ------ EventEmitter boilerplate (required by RN for native event modules) ------
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('P2PRuntime');
