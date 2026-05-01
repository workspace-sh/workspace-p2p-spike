// Web implementation — STUB.
//
// Vanilla browser cannot run Hypercore: sodium-native and udx-native are C++
// addons. Two plausible long-term answers:
//   1. A WebSocket relay that fronts a server-side runtime (browser → relay → swarm).
//   2. A WASM port of the relevant primitives (large undertaking, not on holepunch's
//      roadmap as of April 2026).
//
// For now the web runtime resolves but every method throws. This lets the TS
// interface compile in the browser and tools that import the package don't break;
// running anything fails loudly.

import type {
  CreateRuntimeOptions,
  Did,
  Log,
  LogKey,
  P2PRuntime,
  TopicId,
} from './types.ts';

export async function createRuntime(_opts: CreateRuntimeOptions = {}): Promise<P2PRuntime> {
  return {
    async ready() { unsupported('ready'); },
    did() { unsupported('did'); },
    async createLog() { unsupported('createLog'); },
    async openLog(_key: LogKey) { unsupported('openLog'); },
    async joinTopic(_topic: TopicId) { unsupported('joinTopic'); },
    async leaveTopic(_topic: TopicId) { unsupported('leaveTopic'); },
    async close() { /* no-op */ },
  };
}

function unsupported(method: string): never {
  throw new Error(
    `[@workspace/p2p-runtime/web] ${method}() not supported in browser. ` +
      'See PLAN.md — running the runtime in-browser would need a WebSocket relay or a WASM port.',
  );
}

// referenced by other type files
export type { P2PRuntime, Log, Did, TopicId, LogKey, CreateRuntimeOptions } from './types.ts';
