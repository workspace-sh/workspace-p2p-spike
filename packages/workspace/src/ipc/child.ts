// WorkspaceChild — hosts one or more live Workspace instances, dispatching
// the wire protocol in ./protocol.ts. Mirrors @workspace.sh/p2p-runtime's
// own Child class (same wire shape: line-delimited JSON, id-correlated
// request/response, unsolicited events) but for Workspace-level operations
// instead of Log-level ones.
//
// Runs inside the spawned Node child process — the ONLY place this package's
// fs/sodium/ucanto/node:crypto-heavy code actually executes. The RN/Hermes
// side never imports @workspace.sh/workspace directly; it talks to this
// class's counterpart on the wire via RemoteWorkspace (./remote.node.ts /
// ./remote.macos.ts).

import { createRuntime } from '@workspace.sh/p2p-runtime/node';
// Framing only — NOT the `/ipc` barrel, which re-exports NodeTransport and so
// drags node:child_process into the Bare worklet graph (#229).
import { encode, LineDecoder } from '@workspace.sh/p2p-runtime/ipc/framing';
import { Workspace } from '../index.ts';
import type { Did } from '@workspace.sh/p2p-runtime';
import type {
  ChangeEvent,
  ChildToParent,
  Hex,
  Params,
  Request,
  WsCloseResult,
  WsEntriesResult,
  WsFlushResult,
  WsWatchResult,
  WorkingTreeEvent,
  WsInfoResult,
  WsListResult,
  WsInviteResult,
  WsWriteResult,
} from './protocol.ts';

export class WorkspaceChild {
  private workspaces = new Map<string, Workspace>();
  /** Active working-tree watchers, by handle. */
  private watchers = new Map<string, () => void>();
  private nextHandle = 1;
  private decoder = new LineDecoder();
  private write: (s: string) => void;

  constructor(write: (s: string) => void) {
    this.write = write;
  }

  /** Feed a chunk read from stdin. Dispatches each complete message. */
  async feed(chunk: string): Promise<void> {
    const messages = this.decoder.feed(chunk);
    for (const m of messages) {
      await this.handle(m as Request);
    }
  }

  private async handle(req: Request): Promise<void> {
    try {
      const result = await this.dispatch(req.params);
      this.send({ id: req.id, ok: true, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.send({ id: req.id, ok: false, error: { message } });
    }
  }

  private async dispatch(params: Params): Promise<unknown> {
    switch (params.method) {
      case 'wsCreate': {
        const ws = await Workspace.create({
          createRuntime,
          folder: params.folder,
          name: params.name,
          storage: params.storage,
          rootSeed: params.rootSeedHex ? hexToBytes(params.rootSeedHex) : undefined,
          identitySeed: params.identitySeedHex
            ? hexToBytes(params.identitySeedHex)
            : undefined,
          bootstrap: params.bootstrap,
        });
        return this.track(ws);
      }
      case 'wsOpen': {
        const ws = await Workspace.open({
          createRuntime,
          folder: params.folder,
          storage: params.storage,
          identitySeed: hexToBytes(params.identitySeedHex),
          bootstrap: params.bootstrap,
        });
        return this.track(ws);
      }
      case 'wsInvite': {
        const ws = this.require(params.handle);
        await ws.invite(params.recipientDid as Did);
        return { ok: true } satisfies WsInviteResult;
      }
      case 'wsWrite': {
        const ws = this.require(params.handle);
        await ws.write(hexToBytes(params.entryHex));
        return { ok: true } satisfies WsWriteResult;
      }
      case 'wsEntries': {
        const ws = this.require(params.handle);
        const entries = await ws.entries();
        return { entriesHex: entries.map(bytesToHex) } satisfies WsEntriesResult;
      }
      case 'wsWatch': {
        const ws = this.require(params.handle);
        const handle = params.handle;
        const existing = this.watchers.get(handle);
        if (!params.enabled) {
          if (existing) {
            existing();
            this.watchers.delete(handle);
          }
          return { watching: false } satisfies WsWatchResult;
        }
        if (existing) return { watching: true } satisfies WsWatchResult;
        this.watchers.set(
          handle,
          ws.watchWorkingTree(change => {
            const evt: WorkingTreeEvent = {
              event: 'workingTree',
              handle,
              path: change.path,
              bytesHex: change.bytes === null ? null : bytesToHex(change.bytes),
            };
            this.send(evt);
          }),
        );
        return { watching: true } satisfies WsWatchResult;
      }
      case 'wsList': {
        const ws = this.require(params.handle);
        const files = await ws.listWorkingTree(
          params.extensions ? { extensions: params.extensions } : undefined,
        );
        return {
          files: files.map(f => ({ path: f.path, bytesHex: bytesToHex(f.bytes) })),
        } satisfies WsListResult;
      }
      case 'wsFlush': {
        const ws = this.require(params.handle);
        const r = await ws.flushStore();
        return { written: r === null ? null : r.written } satisfies WsFlushResult;
      }
      case 'wsClose': {
        const ws = this.require(params.handle);
        const stopWatch = this.watchers.get(params.handle);
        if (stopWatch) {
          stopWatch();
          this.watchers.delete(params.handle);
        }
        await ws.close();
        this.workspaces.delete(params.handle);
        return { ok: true } satisfies WsCloseResult;
      }
    }
  }

  private track(ws: Workspace): WsInfoResult {
    const handle = `ws${this.nextHandle++}`;
    this.workspaces.set(handle, ws);
    ws.on('change', () => {
      const evt: ChangeEvent = { event: 'change', handle, length: ws.length };
      this.send(evt);
    });
    return {
      handle,
      id: ws.id,
      did: ws.did,
      rootDid: ws.rootDid,
      isAdmin: ws.isAdmin,
      length: ws.length,
    };
  }

  private require(handle: string): Workspace {
    const ws = this.workspaces.get(handle);
    if (!ws) throw new Error(`unknown workspace handle: ${handle}`);
    return ws;
  }

  private send(msg: ChildToParent): void {
    this.write(encode(msg));
  }
}

// ----- hex helpers ----------------------------------------------------------

function hexToBytes(hex: Hex): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd-length hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): Hex {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    s += b[i]!.toString(16).padStart(2, '0');
  }
  return s;
}
