// macOS-path RemoteWorkspace — spawns the child via the P2PRuntimeModule
// TurboModule (NSTask) instead of child_process.spawn. Same protocol, same
// child-bin.ts; only the transport differs.
//
// Not auto-resolved by Metro's moduleSuffixes — imported by explicit path
// (`@workspace.sh/workspace/remote-macos`) so platform selection doesn't
// depend on bundler-specific suffix behaviour through a package's `exports`
// map. Mirrors @workspace.sh/p2p-runtime/src/runtime.macos.ts.
//
// Integration checklist:
//   1. The P2PRuntimeModule TurboModule (NSTask spawn + stdio bridge) must
//      be linked into the Xcode target — this file doesn't care WHICH
//      protocol the spawned child speaks, it's fully generic.
//   2. childScriptPath must point at packages/workspace/src/ipc/child-bin.ts
//      (dev: the .ts source directly — the child runs under plain
//      `node --experimental-strip-types`, not through Metro).
//   3. storage is REQUIRED — callers must compute an Application Support
//      path themselves. See docs/workspace-format.md invariant 4: never
//      default corestore storage into a folder that might be cloud-synced.

import { MacOSTransport } from '@workspace.sh/p2p-runtime/ipc/macos';
import { RemoteWorkspace } from './remote-base.ts';
import type { BootstrapNode } from './protocol.ts';

export interface RemoteWorkspaceCreateOptions {
  folder: string;
  name?: string;
  /**
   * Fixes the WORKSPACE's root identity. Omit for a random one, which is what
   * every real caller should do — the root public key is the workspaceId and
   * the swarm topic is a hash of it, so two workspaces sharing a root seed are
   * one workspace as far as the network is concerned (#317).
   */
  rootSeed?: Uint8Array;
  /** The CREATOR's device identity. Not the same thing as `rootSeed`. */
  identitySeed?: Uint8Array;
  storage: string;
  /** Private DHT bootstrap nodes. Omit for the public DHT (production). */
  bootstrap?: BootstrapNode[];
  nodeBin?: string;
  /** No filesystem-relative default — the bundled path differs per build. */
  childScriptPath: string;
}

export interface RemoteWorkspaceOpenOptions {
  folder: string;
  identitySeed: Uint8Array;
  storage: string;
  bootstrap?: BootstrapNode[];
  nodeBin?: string;
  childScriptPath: string;
}

// ---------------------------------------------------------------------------
// One child, many workspaces
// ---------------------------------------------------------------------------
//
// The child has always been able to hold many workspaces: `child.ts` keys them
// by handle and `wsOpen`/`wsClose` operate on entries in that map. Below it,
// the runtime keeps a Map of joined topics, and Corestore replicates EVERY core
// it holds over one connection per peer — so ten open workspaces sharing a peer
// is one connection carrying ten sets of cores, not ten connections.
//
// What forced one-workspace-at-a-time was this file: a fresh `MacOSTransport`
// per call meant a fresh child per call, and the native module is a singleton
// that refuses the second spawn. The stack was built for this; we were not
// using it.
//
// So the child is spawned once and kept. It outlives any single workspace and
// is torn down with the app, which is also why a failed open no longer needs to
// close it (#326 becomes unreachable rather than handled).

let shared: MacOSTransport | null = null;
let spawning: Promise<MacOSTransport> | null = null;

async function sharedTransport(nodeBin: string, scriptPath: string): Promise<MacOSTransport> {
  // A child that has exited is not reusable. Respawning here rather than
  // failing means a crashed child costs one slow operation instead of every
  // later operation until the app restarts.
  if (shared !== null && !shared.closed) return shared;
  // Concurrent opens must not race into two spawns — the second would be
  // refused, and the first caller would have no idea why.
  if (spawning !== null) return spawning;

  spawning = (async () => {
    const transport = new MacOSTransport();
    try {
      await transport.spawn(nodeBin, scriptPath, null);
    } catch (err) {
      // Cleared so the next attempt tries again rather than awaiting a promise
      // that has already rejected.
      spawning = null;
      throw err;
    }
    shared = transport;
    spawning = null;
    return transport;
  })();

  return spawning;
}

/**
 * Drop the shared child, for tests and for a deliberate teardown.
 *
 * Not called on workspace close: the whole point is that the child outlives
 * any one workspace.
 */
export async function closeSharedTransport(): Promise<void> {
  const transport = shared;
  shared = null;
  spawning = null;
  if (transport !== null && !transport.closed) await transport.close();
}

export async function createWorkspace(opts: RemoteWorkspaceCreateOptions): Promise<RemoteWorkspace> {
  const transport = await sharedTransport(opts.nodeBin ?? 'node', opts.childScriptPath);
  return RemoteWorkspace.fromTransport(
    transport,
    {
      method: 'wsCreate',
      folder: opts.folder,
      name: opts.name,
      storage: opts.storage,
      rootSeedHex: opts.rootSeed ? bytesToHex(opts.rootSeed) : undefined,
      identitySeedHex: opts.identitySeed ? bytesToHex(opts.identitySeed) : undefined,
      bootstrap: opts.bootstrap,
    },
    // Shared: closing this workspace must not take the child with it.
    false,
  );
}

export async function openWorkspace(opts: RemoteWorkspaceOpenOptions): Promise<RemoteWorkspace> {
  const transport = await sharedTransport(opts.nodeBin ?? 'node', opts.childScriptPath);
  return RemoteWorkspace.fromTransport(
    transport,
    {
      method: 'wsOpen',
      folder: opts.folder,
      storage: opts.storage,
      identitySeedHex: bytesToHex(opts.identitySeed),
      bootstrap: opts.bootstrap,
    },
    false,
  );
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    s += b[i]!.toString(16).padStart(2, '0');
  }
  return s;
}

export { RemoteWorkspace };
