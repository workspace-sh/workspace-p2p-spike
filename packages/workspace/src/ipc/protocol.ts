// Wire types for the Workspace-level parent <-> child IPC.
//
// A distinct, higher-level protocol from @workspace.sh/p2p-runtime's own
// Log-level IPC (createLog/appendBlock/etc). Reuses that package's transport
// + framing primitives (@workspace.sh/p2p-runtime/ipc) but speaks its own
// method registry, because the Workspace facade does real work — fs, sodium,
// ucanto, node:crypto — that only runs inside the child process; the parent
// (RN/Hermes) never runs Workspace logic directly, only proxies calls to it.
//
// One child process can host multiple open Workspace instances, each
// identified by an opaque `handle` returned from wsCreate/wsOpen.

export type Hex = string;

export interface Request {
  id: number;
  method: Method;
  params: Params;
}

export type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { message: string } };

export type Event = ChangeEvent | WorkingTreeEvent;
export interface ChangeEvent {
  event: 'change';
  handle: string;
  length: number;
}

/**
 * An external edit to the working tree settled. `bytesHex` is null when the
 * path no longer exists (deleted, or the temp half of an atomic save).
 */
export interface WorkingTreeEvent {
  event: 'workingTree';
  handle: string;
  path: string;
  bytesHex: Hex | null;
}

export type ChildToParent = Response | Event;
export type ParentToChild = Request;

// ----------------------------------------------------------------------------
// Method registry
// ----------------------------------------------------------------------------

export type Method =
  | 'wsCreate'
  | 'wsOpen'
  | 'wsInvite'
  | 'wsWrite'
  | 'wsEntries'
  | 'wsFlush'
  | 'wsWatch'
  | 'wsList'
  | 'wsClose';

export interface BootstrapNode {
  host: string;
  port: number;
}

export type Params =
  | {
      method: 'wsCreate';
      folder: string;
      name?: string;
      rootSeedHex?: Hex;
      /**
       * The CREATOR's device identity — distinct from the workspace's root
       * identity, which `rootSeedHex` fixes. Optional so an omitted value
       * falls back to the root seed, preserving the pre-#317 shape for any
       * caller that has not been updated.
       */
      identitySeedHex?: Hex;
      /** Required — no invariant-4-violating default at this layer. Caller
       *  (native/app code) must compute an app-container path. */
      storage: string;
      /** Private DHT bootstrap nodes. Omit for the public DHT (production). */
      bootstrap?: BootstrapNode[];
    }
  | {
      method: 'wsOpen';
      folder: string;
      identitySeedHex: Hex;
      storage: string;
      bootstrap?: BootstrapNode[];
    }
  | { method: 'wsInvite'; handle: string; recipientDid: string }
  | { method: 'wsWrite'; handle: string; entryHex: Hex }
  | { method: 'wsEntries'; handle: string }
  | { method: 'wsFlush'; handle: string }
  | { method: 'wsWatch'; handle: string; enabled: boolean }
  | { method: 'wsList'; handle: string; extensions?: string[] }
  | { method: 'wsClose'; handle: string };

// Per-method response result shapes.
export interface WsInfoResult {
  handle: string;
  id: string;
  did: string;
  rootDid: string;
  isAdmin: boolean;
  length: number;
}
export interface WsInviteResult {
  ok: true;
}
export interface WsWriteResult {
  ok: true;
}
export interface WsEntriesResult {
  entriesHex: Hex[];
}
export interface WsWatchResult {
  watching: boolean;
}
/**
 * One pass over the working tree. Hex-encoded for the same reason entries are:
 * this protocol is newline-delimited JSON, so bytes cannot travel raw.
 */
export interface WsListResult {
  files: { path: string; bytesHex: Hex }[];
}

export interface WsFlushResult {
  /** Transport-form files written, or null on a runtime without a corestore. */
  written: number | null;
}

export interface WsCloseResult {
  ok: true;
}
