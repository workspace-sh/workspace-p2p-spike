// React Native, declared rather than depended on.
//
// Two files in this package are the macOS bridge — `ipc/NativeP2PRuntime.ts`
// and `ipc/transport.macos.ts` — and they import from 'react-native'. In the
// Workspace monorepo that resolves against the real dependency. Here it must
// not: this repo is the public reference for the protocol, and it exists to be
// cloned and run with no native toolchain and no app framework. Taking a
// react-native dependency to typecheck two files would cost every reader an
// install they have no use for.
//
// So the surface is declared instead, and only the surface actually used. If a
// third symbol appears here, prefer widening this file over adding the
// dependency — and if that stops being tenable, the honest fix is to move the
// bridge out of the reference rather than to install a framework for it.

declare module 'react-native' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const NativeModules: Record<string, any>;

  export class NativeEventEmitter {
    constructor(nativeModule?: unknown);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addListener(event: string, listener: (...args: any[]) => void): {remove(): void};
    removeAllListeners(event: string): void;
  }
}
