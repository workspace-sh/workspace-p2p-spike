// Mobile-path RemoteWorkspace — runs the child inside a Bare worklet
// (`react-native-bare-kit`) instead of spawning a process. Same protocol,
// same child code; only the transport differs.
//
// Serves iOS AND Android: both use the same binding, so there is one file
// rather than two that start identical and drift.
//
// Imported by explicit path (`@workspace.sh/workspace/remote-ios`) rather
// than relying on Metro's moduleSuffixes, matching how the macOS entry avoids
// depending on bundler-specific suffix behaviour through a package's exports.
//
// Integration checklist:
//   1. `npm i react-native-bare-kit` and rebuild the dev client — this is a
//      native module, so a JS-only reload will not pick it up.
//   2. Bundle the worklet with `yarn mobile:p2p:bundle`.
//      It must be THIS package's worklet entry (./worklet-bin.ts), not
//      @workspace.sh/p2p-runtime's — that one serves the Log-level protocol
//      and would reject every request RemoteWorkspace sends (#243). The
//      script also needs --preset mobile (ios-arm64 alone excludes the
//      simulator) and --imports, for the builtins node_modules reaches for.
//      Pass the resulting bytes as `bundle`; the caller owns asset loading,
//      which differs between Expo, bare React Native, and a test harness.
//   3. `storage` is REQUIRED, as on macOS — see docs/workspace-format.md
//      invariant 4: corestore storage must never default into a folder that
//      might be cloud-synced.

import { BareTransport, type BareWorklet } from '@workspace.sh/p2p-runtime/ipc/ios';
import { RemoteWorkspace } from './remote-base.ts';
import type { BootstrapNode } from './protocol.ts';

/** Bytes of a `bare-pack` bundle, or a path/source string the host resolves. */
export type WorkletBundle = ArrayBuffer | Uint8Array | string;

export interface RemoteWorkspaceMobileCreateOptions {
  folder: string;
  name?: string;
  rootSeed?: Uint8Array;
  storage: string;
  /** Private DHT bootstrap nodes. Omit for the public DHT (production). */
  bootstrap?: BootstrapNode[];
  /** A `new Worklet()` from `react-native-bare-kit`. */
  worklet: BareWorklet;
  bundle: WorkletBundle;
}

export interface RemoteWorkspaceMobileOpenOptions {
  folder: string;
  identitySeed: Uint8Array;
  storage: string;
  bootstrap?: BootstrapNode[];
  worklet: BareWorklet;
  bundle: WorkletBundle;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function createWorkspace(
  opts: RemoteWorkspaceMobileCreateOptions,
): Promise<RemoteWorkspace> {
  const transport = new BareTransport({ worklet: opts.worklet });
  await transport.start(opts.bundle);
  return RemoteWorkspace.fromTransport(transport, {
    method: 'wsCreate',
    folder: opts.folder,
    name: opts.name,
    storage: opts.storage,
    rootSeedHex: opts.rootSeed ? bytesToHex(opts.rootSeed) : undefined,
    bootstrap: opts.bootstrap,
  });
}

export async function openWorkspace(
  opts: RemoteWorkspaceMobileOpenOptions,
): Promise<RemoteWorkspace> {
  const transport = new BareTransport({ worklet: opts.worklet });
  await transport.start(opts.bundle);
  return RemoteWorkspace.fromTransport(transport, {
    method: 'wsOpen',
    folder: opts.folder,
    storage: opts.storage,
    identitySeedHex: bytesToHex(opts.identitySeed),
    bootstrap: opts.bootstrap,
  });
}

export { RemoteWorkspace } from './remote-base.ts';
export type { BareWorklet } from '@workspace.sh/p2p-runtime/ipc/ios';
