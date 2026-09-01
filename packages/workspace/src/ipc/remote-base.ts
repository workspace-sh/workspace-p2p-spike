// RemoteWorkspace — a Workspace proxy backed by a spawned Node child process.
//
// Transport-agnostic: takes an already-constructed, ready-to-use Transport
// (see @workspace.sh/p2p-runtime/ipc). ./remote.node.ts and ./remote.macos.ts
// are the thin per-platform files that actually spawn one — this file holds
// all the shared RPC/event-handling logic so it isn't duplicated per platform.
//
// Mirrors @workspace.sh/workspace's own Workspace class shape as closely as
// possible so call sites read the same either way — but every method here is
// an RPC round-trip, since the real Workspace instance lives in the child
// (fs/sodium/ucanto/node:crypto only run there — see ../ipc/child.ts).

// `encode` comes from the framing entry point, NOT the `/ipc` barrel: the
// barrel re-exports NodeTransport, and an ESM re-export loads eagerly, so a
// value import from it drags `node:child_process` / `node:url` / `node:path`
// into whatever bundles this file. That breaks Metro on macOS, which reaches
// here via ./remote.macos.ts. The barrel's own header flags the same hazard
// for Bare worklets (#229) — this file is shared by every platform, so it can
// only ever use the platform-neutral entry points.
//
// The `Transport` type below is erased at compile time and never reaches the
// bundler, so it can keep coming from the barrel.
import { encode } from '@workspace.sh/p2p-runtime/ipc/framing';
import type { Transport } from '@workspace.sh/p2p-runtime/ipc';
import type {
  ChangeEvent,
  WorkingTreeEvent,
  Hex,
  Method,
  Params,
  Request,
  WsEntriesResult,
  WsInfoResult,
  WsListResult,
} from './protocol.ts';

type ChangeListener = () => void;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/**
 * Request ids, unique across every RemoteWorkspace rather than within one.
 *
 * Each instance used to number its own requests from 1, which was fine while a
 * workspace owned its child. Sharing a child breaks it: two workspaces both
 * send id 1, both see every reply on that transport, and each resolves on the
 * other's answer. A module-scoped counter makes the collision unrepresentable
 * rather than merely unlikely.
 */
let nextRequestId = 1;

export class RemoteWorkspace {
  /** Opaque child-side identifier for this workspace instance. */
  readonly handle: string;
  /** Stable workspace identifier — the root public key, hex. */
  readonly id: string;
  /** This peer's DID. */
  readonly did: string;
  /** The workspace root authority DID. */
  readonly rootDid: string;
  /** True if this handle can invite members (i.e. holds the root key). */
  readonly isAdmin: boolean;

  private transport: Transport;
  /**
   * Whether closing this workspace should close the child process too.
   *
   * False when the transport is shared. One child holds many workspaces — the
   * child has always keyed them by handle, and Corestore replicates every core
   * it holds over one connection per peer — so closing the transport because
   * ONE workspace closed would tear down every other workspace with it.
   */
  private readonly ownsTransport: boolean;
  private pending = new Map<number, Pending>();
  private _length: number;
  private listeners = new Set<ChangeListener>();
  private workingTreeListeners = new Set<(path: string, bytes: Uint8Array | null) => void>();

  private constructor(transport: Transport, info: WsInfoResult, ownsTransport: boolean) {
    this.transport = transport;
    this.ownsTransport = ownsTransport;
    this.handle = info.handle;
    this.id = info.id;
    this.did = info.did;
    this.rootDid = info.rootDid;
    this.isAdmin = info.isAdmin;
    this._length = info.length;
    this.transport.onMessage((msg) => this.handleMessage(msg));
  }

  /** Number of entries currently visible locally. */
  get length(): number {
    return this._length;
  }

  /**
   * Bootstrap a RemoteWorkspace over an already-spawned, ready transport by
   * sending the initial wsCreate/wsOpen request. Called by the per-platform
   * `create`/`open` functions once they've constructed their Transport.
   */
  static async fromTransport(
    transport: Transport,
    params: Params,
    /**
     * Whether this workspace owns the child. Default true, which is the
     * one-process-per-workspace shape the Node path still uses. The macOS path
     * passes false: its child is shared and outlives any single workspace.
     */
    ownsTransport = true,
  ): Promise<RemoteWorkspace> {
    let info: WsInfoResult;
    try {
      info = (await RemoteWorkspace.rpcOnce(transport, params)) as WsInfoResult;
    } catch (err) {
      // The child is already spawned by the time this call is made, and if the
      // call fails nothing else holds a reference to it — no RemoteWorkspace
      // exists to close later. Left running it wedges the singleton native
      // runtime, so the NEXT open or create fails with "Child process is
      // already running", blaming an operation that did nothing wrong (#326).
      //
      // Pointing at a folder that is not a workspace is the ordinary way in:
      // the child spawns fine and `wsOpen` then fails on the missing manifest.
      // Only if we own it: a shared child is still holding other workspaces,
      // and this open failing says nothing about them.
      if (ownsTransport) {
        try {
          await transport.close();
        } catch {
          // A child that will not close cannot be helped from here, and the
          // caller needs the ORIGINAL failure — not this one.
        }
      }
      throw err;
    }
    return new RemoteWorkspace(transport, info, ownsTransport);
  }

  // One-shot RPC used only for the bootstrap call, before the instance (and
  // its own `pending` map) exists. id=1 is safe to reuse afterwards — this
  // listener removes itself the moment the bootstrap response arrives, well
  // before the constructed instance's own id counter starts issuing calls.
  private static rpcOnce(transport: Transport, params: Params): Promise<unknown> {
    // Also from the shared counter. This runs BEFORE the instance exists, so
    // it used a hardcoded id 1 — which on a shared child would collide with
    // whatever an already-open workspace happened to be doing.
    const id = nextRequestId++;
    return new Promise((resolve, reject) => {
      const off = transport.onMessage((msg) => {
        const r = msg as { id: number; ok: boolean; result?: unknown; error?: { message: string } };
        if (r.id !== id) return;
        off();
        if (r.ok) resolve(r.result);
        else reject(new Error(r.error?.message ?? 'IPC error'));
      });
      const req: Request = { id, method: params.method as Method, params };
      transport.send(encode(req));
    });
  }

  /**
   * Invite a peer by DID. Admin-only (requires the root key) — throws
   * (via the child's own check) if this handle isn't the admin.
   */
  async invite(recipientDid: string): Promise<void> {
    await this.rpc({ method: 'wsInvite', handle: this.handle, recipientDid });
  }

  /** Append an entry to the workspace's data log (sealed under K0_org). */
  async write(entry: Uint8Array): Promise<void> {
    await this.rpc({ method: 'wsWrite', handle: this.handle, entryHex: bytesToHex(entry) });
  }

  /** Read all entries, decrypted. */
  async entries(): Promise<Uint8Array[]> {
    const r = (await this.rpc({ method: 'wsEntries', handle: this.handle })) as WsEntriesResult;
    return r.entriesHex.map(hexToBytes);
  }

  /** Subscribe to "an entry was appended" (local or replicated). */
  on(event: 'change', cb: ChangeListener): () => void {
    if (event !== 'change') throw new Error(`unknown event: ${String(event)}`);
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Start (or stop) watching the working tree for external edits.
   *
   * Fires for OUR OWN writes too — the filesystem cannot distinguish them —
   * so the caller must filter echoes before writing back to the log.
   */
  /**
   * One pass over the working tree. See `Workspace.listWorkingTree` — the
   * watcher reports changes, so a file that merely exists is invisible to it.
   */
  async listWorkingTree(options?: {
    extensions?: string[];
  }): Promise<{ path: string; bytes: Uint8Array }[]> {
    const res = (await this.rpc({
      method: 'wsList',
      handle: this.handle,
      ...(options?.extensions ? { extensions: options.extensions } : {}),
    })) as WsListResult;
    return res.files.map(f => ({ path: f.path, bytes: hexToBytes(f.bytesHex) }));
  }

  async watchWorkingTree(cb: (path: string, bytes: Uint8Array | null) => void): Promise<() => void> {
    this.workingTreeListeners.add(cb);
    if (this.workingTreeListeners.size === 1) {
      await this.rpc({ method: 'wsWatch', handle: this.handle, enabled: true });
    }
    return () => {
      this.workingTreeListeners.delete(cb);
      if (this.workingTreeListeners.size === 0) {
        void this.rpc({ method: 'wsWatch', handle: this.handle, enabled: false }).catch(() => {});
      }
    };
  }

  /**
   * Flush the transport form (`.workspace/store/v1/`) so the folder is a
   * complete copy. Close does this implicitly; call it before sharing.
   */
  async flushStore(): Promise<{ written: number } | null> {
    const r = (await this.rpc({ method: 'wsFlush', handle: this.handle })) as {
      written: number | null;
    };
    return r.written === null ? null : { written: r.written };
  }

  async close(): Promise<void> {
    await this.rpc({ method: 'wsClose', handle: this.handle });
    // `wsClose` releases this workspace inside the child. Whether the child
    // itself should go is a different question, and the answer is no when it
    // is shared — other workspaces are still using it.
    if (this.ownsTransport) await this.transport.close();
  }

  private rpc(params: Params): Promise<unknown> {
    const id = nextRequestId++;
    const req: Request = { id, method: params.method as Method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.send(encode(req));
    });
  }

  private handleMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    if ('event' in msg) {
      const evt = msg as ChangeEvent | WorkingTreeEvent;
      if (evt.event === 'workingTree' && evt.handle === this.handle) {
        const wt = evt as WorkingTreeEvent;
        const bytes = wt.bytesHex === null ? null : hexToBytes(wt.bytesHex);
        for (const cb of this.workingTreeListeners) cb(wt.path, bytes);
        return;
      }
      if (evt.event === 'change' && evt.handle === this.handle) {
        this._length = evt.length;
        for (const cb of this.listeners) cb();
      }
      return;
    }
    const r = msg as { id: number; ok: boolean; result?: unknown; error?: { message: string } };
    const pending = this.pending.get(r.id);
    if (!pending) return;
    this.pending.delete(r.id);
    if (r.ok) pending.resolve(r.result);
    else pending.reject(new Error(r.error?.message ?? 'IPC error'));
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
