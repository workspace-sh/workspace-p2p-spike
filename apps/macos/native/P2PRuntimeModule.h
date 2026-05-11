// P2PRuntimeModule — React Native TurboModule for the macOS P2P runtime bridge.
//
// Spawns a Node child process via NSTask and bridges its stdin/stdout to JS
// as native events. The JSON-RPC protocol is defined in ipc/protocol.ts and
// is identical to the Node/test path (Phase 3a).
//
// JS interface (Codegen spec): packages/p2p-runtime/src/ipc/NativeP2PRuntime.ts
//
// Integration:
//   1. Add P2PRuntimeModule.h + P2PRuntimeModule.mm to your Xcode target.
//   2. In your Podfile add: pod 'React-RCTAppDelegate' (already present in
//      most RN-macOS projects via auto-linking).
//   3. Run `pod install`.
//   The module auto-registers via RCT_EXPORT_MODULE(); no manual setup needed.

#pragma once

#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

NS_ASSUME_NONNULL_BEGIN

/// Native module that owns an NSTask running the Node child process.
/// JS calls spawn() / send() / close(); native emits p2pLine / p2pExit events.
@interface P2PRuntimeModule : RCTEventEmitter <RCTBridgeModule>
@end

NS_ASSUME_NONNULL_END
