// IPC integration tests for the spawned-Node-child runtime.
//
// Validates that a SpawnedRuntime (parent process) can drive a NodeRuntime
// running in a separate Node child process, via line-delimited JSON-RPC over
// stdin/stdout. The wire protocol is identical to the one the macOS
// TurboModule will use in Phase 3b — so when the macOS half lands, only the
// "spawn" step changes; the protocol + child code are unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SpawnedRuntime } from '../src/ipc/parent.ts';

const dec = new TextDecoder();
const enc = new TextEncoder();

async function fresh(): Promise<SpawnedRuntime> {
  const r = new SpawnedRuntime({ storage: ':memory:' });
  await r.ready();
  return r;
}

test('spawn → init → did (round-trip)', async (t) => {
  const r = await fresh();
  t.after(async () => {
    await r.close();
  });
  const did = r.did();
  assert.match(did, /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]+$/);
});

test('createLog returns a writable log handle with length 0', async (t) => {
  const r = await fresh();
  t.after(async () => {
    await r.close();
  });
  const log = await r.createLog();
  assert.match(log.key, /^[0-9a-f]+$/);
  assert.equal(log.writable, true);
  assert.equal(log.length, 0);
});

test('append + get round-trip across the IPC boundary', async (t) => {
  const r = await fresh();
  t.after(async () => {
    await r.close();
  });
  const log = await r.createLog();
  const len1 = await log.append(enc.encode('hello'));
  assert.equal(len1, 1);
  const len2 = await log.append(enc.encode('world'));
  assert.equal(len2, 2);

  assert.equal(dec.decode(await log.get(0)), 'hello');
  assert.equal(dec.decode(await log.get(1)), 'world');
});

test('local length cache updates after append() resolves', async (t) => {
  const r = await fresh();
  t.after(async () => {
    await r.close();
  });
  const log = await r.createLog();
  await log.append(enc.encode('a'));
  await log.append(enc.encode('b'));
  await log.append(enc.encode('c'));
  assert.equal(log.length, 3);
});

test('append events fire on the parent when the child appends', async (t) => {
  const r = await fresh();
  t.after(async () => {
    await r.close();
  });
  const log = await r.createLog();

  let count = 0;
  const off = log.on('append', () => {
    count++;
  });

  await log.append(enc.encode('one'));
  await log.append(enc.encode('two'));
  // Events flow asynchronously — give them a tick.
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(count, 2);

  off();
  await log.append(enc.encode('three'));
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(count, 2, 'unsubscribed listener must not fire');
});

test('openLog on a key the child already knows returns matching state', async (t) => {
  const r = await fresh();
  t.after(async () => {
    await r.close();
  });
  const a = await r.createLog();
  await a.append(enc.encode('first'));
  await a.append(enc.encode('second'));
  const b = await r.openLog(a.key);
  assert.equal(b.key, a.key);
  assert.equal(b.length, 2);
});

test('IPC error surfaces as a rejected promise (unknown log)', async (t) => {
  const r = await fresh();
  t.after(async () => {
    await r.close();
  });
  // Manually craft an RPC that the runtime API would never produce.
  await assert.rejects(
    () => r.__rpc({ method: 'getBlock', key: 'deadbeef'.repeat(8), index: 0 }),
    /unknown log/,
  );
});

test('topic length is validated by the child (parity with NodeRuntime)', async (t) => {
  const r = await fresh();
  t.after(async () => {
    await r.close();
  });
  await assert.rejects(() => r.joinTopic('cafe'), /Topic must be 32 bytes/);
});

test('close → child exits → subsequent calls reject', async (t) => {
  const r = await fresh();
  await r.close();
  await assert.rejects(() => r.createLog(), /not ready/);
});
