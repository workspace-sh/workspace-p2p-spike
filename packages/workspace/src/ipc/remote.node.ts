// Node-path RemoteWorkspace — spawns the child via child_process.spawn
// (NodeTransport). Used by tests, Node-hosted tools, and to prove the IPC
// layer itself with no native/Xcode involvement at all. The macOS RN app
// uses remote.macos.ts instead — same protocol, NSTask spawn.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { NodeTransport } from '@workspace.sh/p2p-runtime/ipc';
import { RemoteWorkspace } from './remote-base.ts';
import type { BootstrapNode } from './protocol.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CHILD_SCRIPT = resolve(HERE, 'child-bin.ts');

export interface RemoteWorkspaceCreateOptions {
  folder: string;
  name?: string;
  rootSeed?: Uint8Array;
  /** Required — no invariant-4-violating default at this layer. */
  storage: string;
  /** Private DHT bootstrap nodes. Omit for the public DHT (production). */
  bootstrap?: BootstrapNode[];
  nodeBin?: string;
  childScriptPath?: string;
}

export interface RemoteWorkspaceOpenOptions {
  folder: string;
  identitySeed: Uint8Array;
  storage: string;
  bootstrap?: BootstrapNode[];
  nodeBin?: string;
  childScriptPath?: string;
}

export async function createWorkspace(opts: RemoteWorkspaceCreateOptions): Promise<RemoteWorkspace> {
  const transport = new NodeTransport({
    nodeBin: opts.nodeBin,
    scriptPath: opts.childScriptPath ?? DEFAULT_CHILD_SCRIPT,
  });
  return RemoteWorkspace.fromTransport(transport, {
    method: 'wsCreate',
    folder: opts.folder,
    name: opts.name,
    storage: opts.storage,
    rootSeedHex: opts.rootSeed ? bytesToHex(opts.rootSeed) : undefined,
    bootstrap: opts.bootstrap,
  });
}

export async function openWorkspace(opts: RemoteWorkspaceOpenOptions): Promise<RemoteWorkspace> {
  const transport = new NodeTransport({
    nodeBin: opts.nodeBin,
    scriptPath: opts.childScriptPath ?? DEFAULT_CHILD_SCRIPT,
  });
  return RemoteWorkspace.fromTransport(transport, {
    method: 'wsOpen',
    folder: opts.folder,
    storage: opts.storage,
    identitySeedHex: bytesToHex(opts.identitySeed),
    bootstrap: opts.bootstrap,
  });
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    s += b[i]!.toString(16).padStart(2, '0');
  }
  return s;
}

export { RemoteWorkspace };
