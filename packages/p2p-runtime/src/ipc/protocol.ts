// Wire types for parent <-> child IPC.
//
// Three message kinds:
//   - Request:  parent → child. Has an `id`. Expects a Response.
//   - Response: child → parent. Echoes the `id`.
//   - Event:    child → parent. No `id`. Asynchronous notification.
//
// All messages are JSON, one per line ("\n" terminator). See ipc/framing.ts.
//
// This protocol is identical between the pure-Node parent (used in tests +
// the apps/node-spawned smoke harness) and the eventual macOS TurboModule
// parent (Phase 3b). The child never knows or cares which spawned it.

export type Hex = string;

export interface Request {
  id: number;
  method: Method;
  params: Params;
}

export type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { message: string } };

export type Event = AppendEvent;
export interface AppendEvent {
  event: 'append';
  key: Hex;        // log key
  length: number;  // new length after the append landed
}

export type ChildToParent = Response | Event;
export type ParentToChild = Request;

// ----------------------------------------------------------------------------
// Method registry — one entry per RPC method
// ----------------------------------------------------------------------------

export type Method =
  | 'init'
  | 'did'
  | 'createLog'
  | 'openLog'
  | 'closeLog'
  | 'appendBlock'
  | 'getBlock'
  | 'joinTopic'
  | 'leaveTopic'
  | 'shutdown';

// Params are intentionally an object per method. Easier to evolve than positional args.
// Per-method shapes:
export type Params =
  | { method: 'init'; storage: string | null }
  | { method: 'did' }
  | { method: 'createLog' }
  | { method: 'openLog'; key: Hex }
  | { method: 'closeLog'; key: Hex }
  | { method: 'appendBlock'; key: Hex; blockHex: Hex }
  | { method: 'getBlock'; key: Hex; index: number }
  | { method: 'joinTopic'; topic: Hex }
  | { method: 'leaveTopic'; topic: Hex }
  | { method: 'shutdown' };

// Per-method response result shape.
export interface InitResult { did: string }
export interface DidResult { did: string }
export interface LogHandleResult {
  key: Hex;
  writable: boolean;
  length: number;
}
export interface AppendBlockResult { length: number }
export interface GetBlockResult { blockHex: Hex }
export interface OkResult { ok: true }
