// The module must not need globals that Bare does not have.
//
// `Workspace` packs into a Bare worklet on iOS and Android via bare-pack, and
// Bare provides a much smaller global surface than Node or Hermes. Code that
// works in every test here and still throws on a phone is the failure mode
// this file exists to catch — it happened: opening a workspace on Android died
// with `Property 'crypto' doesn't exist`, from one call that had not followed
// the rule the module's own header states.
//
// Deleting the global and exercising the paths that need randomness is a
// cheaper approximation than packing a worklet, and it fails for the same
// reason a phone would.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRuntime } from '@workspace.sh/p2p-runtime/node';
import type { CreateRuntimeOptions } from '@workspace.sh/p2p-runtime';
import { Workspace } from '../src/index.ts';

const ROOT_SEED = new Uint8Array(32).fill(7);

// `swarm: false` for the reason transport.test.ts gives: an empty bootstrap
// still builds a Hyperswarm whose UDP socket survives destroy() (#254).
function offlineRuntime(base: string, name: string) {
  return (opts: CreateRuntimeOptions) =>
    createRuntime({ ...opts, storage: join(base, name), swarm: false });
}

test('creating a workspace needs no `crypto` global', async () => {
  const base = await mkdtemp(join(tmpdir(), 'bare-globals-'));
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  // Bare has no `crypto`. Reading it there throws rather than returning
  // undefined, so make the absence loud here too.
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    get() {
      throw new Error("Property 'crypto' doesn't exist");
    },
  });
  try {
    const ws = await Workspace.create({
      createRuntime: offlineRuntime(base, 'store'),
      folder: join(base, 'acme.workspace'),
      rootSeed: ROOT_SEED,
    });
    // A workspace id is derived from randomness, so reaching this proves the
    // random path ran without the global.
    assert.ok(ws.id.length > 0, "workspace id derives from randomness");
    await ws.close();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'crypto', saved);
    else delete (globalThis as { crypto?: unknown }).crypto;
    // `close()` awaits the flush, but the capture replica it opens can still
    // be closing its own RocksDB handles a tick later, so a single rm races it
    // with ENOTEMPTY. Retry briefly rather than sleep a fixed amount.
    for (let i = 0; i < 20; i++) {
      try {
        await rm(base, { recursive: true, force: true });
        break;
      } catch {
        await new Promise(r => setTimeout(r, 25));
      }
    }
  }
});
