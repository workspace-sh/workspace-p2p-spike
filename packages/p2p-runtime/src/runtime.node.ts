// Node implementation. Used directly by:
//   - the Phase 1 standalone replication smoke test
//   - the spawned Node child process on the macOS path (Phase 3)
//
// THIS FILE IS A STUB. Phase 1 fills in the body using:
//   import Hypercore from 'hypercore';
//   import Corestore from 'corestore';
//   import Hyperswarm from 'hyperswarm';
// …with discovery-key-hashed topics and per-log replication.
//
// Deliberately not pulling those deps in until Phase 1 actually runs them, so
// `npm install` at the repo root stays light until the spike begins.

import type {
  CreateRuntimeOptions,
  Did,
  Log,
  LogKey,
  P2PRuntime,
  TopicId,
} from './types.ts';

class NotImplementedRuntime implements P2PRuntime {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_opts: CreateRuntimeOptions) {}

  async ready(): Promise<void> {
    notYet('ready');
  }
  did(): Did {
    notYet('did');
  }
  async createLog(): Promise<Log> {
    notYet('createLog');
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async openLog(_key: LogKey): Promise<Log> {
    notYet('openLog');
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async joinTopic(_topic: TopicId): Promise<void> {
    notYet('joinTopic');
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async leaveTopic(_topic: TopicId): Promise<void> {
    notYet('leaveTopic');
  }
  async close(): Promise<void> {
    notYet('close');
  }
}

function notYet(method: string): never {
  throw new Error(
    `[@workspace/p2p-runtime/node] ${method}() is not implemented yet — Phase 1 of PLAN.md`,
  );
}

export async function createRuntime(opts: CreateRuntimeOptions = {}): Promise<P2PRuntime> {
  return new NotImplementedRuntime(opts);
}

export type { P2PRuntime, Log, Did, TopicId, LogKey, CreateRuntimeOptions } from './types.ts';
