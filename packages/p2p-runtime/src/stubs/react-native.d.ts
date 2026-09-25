// React Native's surface as this package sees it — two symbols — reached ONLY
// through `paths` in this package's own tsconfig (and workspace's, which
// typechecks these sources). Never by ambient declaration.
//
// The ambient version (#390) was a landmine. A `declare module 'react-native'`
// in a non-module .d.ts DEFINES the module rather than augmenting it, so the
// first React Native app whose compilation included it lost every real export:
// `Module '"react-native"' has no exported member 'View'`, 83 times. It was
// merged on a verification that never loaded the file.
//
// `paths` is not inherited by consumers. An app compiling these same files
// with the real react-native present resolves the real types; only the two
// package-local typechecks — the ones with no react-native to resolve — see
// this. That is the property the ambient file claimed and did not have.
//
// If a third symbol appears here, widen this file rather than adding a
// react-native dependency: this repo deliberately runs two of them, and a
// shared package pulling its own risks a third. If that stops being tenable,
// move the bridge out of this package rather than install a framework to
// typecheck two files.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const NativeModules: Record<string, any>;

export class NativeEventEmitter {
  constructor(nativeModule?: unknown);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addListener(event: string, listener: (...args: any[]) => void): {remove(): void};
  removeAllListeners(event: string): void;
}
