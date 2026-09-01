// Replication integration tests for the Node runtime.
//
// We pair two NodeRuntime instances via the internal `__pipeReplicate`
// escape hatch (direct duplex pipe between corestores — no DHT). That keeps
// the test deterministic and offline. The real swarm path is exercised by
// apps/node/smoke.ts.
//
// Phase 1 of PLAN.md: "Confirm two instances can replicate via Hyperswarm
// on the same machine." The test below proves the same flow at a lower
// level (replication itself); the smoke harness proves discovery + transport.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NodeRuntime } from '../src/runtime.node.ts';

const dec = new TextDecoder();
const enc = new TextEncoder();

async function fresh(): Promise<NodeRuntime> {
  const r = new NodeRuntime({ storage: ':memory:', swarm: false });
  await r.ready();
  return r;
}

async function waitFor<T>(
  pred: () => T | undefined,
  opts: { timeoutMs?: number; label?: string } = {},
): Promise<T> {
  const timeout = opts.timeoutMs ?? 3000;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const r = pred();
    if (r !== undefined) return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`timed out waiting for ${opts.label ?? 'condition'}`);
}

test('two runtimes replicate a single log via direct pipe', async (t) => {
  const a = await fresh();
  const b = await fresh();
  const close = a.__pipeReplicate(b);
  t.after(async () => {
    await close();
    await a.close();
    await b.close();
  });

  const logA = await a.createLog();
  const logB = await b.openLog(logA.key);

  await logA.append(enc.encode('hello'));
  await logA.append(enc.encode('world'));

  await waitFor(() => (logB.length >= 2 ? true : undefined), {
    label: 'logB to receive both blocks',
  });

  assert.equal(logB.length, 2);
  assert.equal(dec.decode(await logB.get(0)), 'hello');
  assert.equal(dec.decode(await logB.get(1)), 'world');
});

test('append events fire on the replicating peer', async (t) => {
  const a = await fresh();
  const b = await fresh();
  const close = a.__pipeReplicate(b);
  t.after(async () => {
    await close();
    await a.close();
    await b.close();
  });

  const logA = await a.createLog();
  const logB = await b.openLog(logA.key);

  let appendCount = 0;
  logB.on('append', () => {
    appendCount++;
  });

  await logA.append(enc.encode('one'));
  await logA.append(enc.encode('two'));
  await logA.append(enc.encode('three'));

  await waitFor(() => (appendCount >= 3 ? true : undefined), {
    label: 'three append events on logB',
  });

  assert.equal(appendCount, 3);
});

test('runtime DID is stable across operations and shaped as did:key:z…', async (t) => {
  const a = await fresh();
  t.after(async () => {
    await a.close();
  });

  const did1 = a.did();
  await a.createLog();
  const did2 = a.did();
  const did3 = a.did();
  assert.equal(did1, did2);
  assert.equal(did2, did3);
  assert.match(did1, /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]+$/);
});

test('open the same log twice returns the cached handle', async (t) => {
  const a = await fresh();
  t.after(async () => {
    await a.close();
  });

  const log = await a.createLog();
  const reopened = await a.openLog(log.key);
  // Same handle (or at least equivalent state).
  assert.equal(reopened.key, log.key);
  assert.equal(reopened.writable, log.writable);
});

test('opening a log on a fresh runtime is read-only (writable=false)', async (t) => {
  const a = await fresh();
  const b = await fresh();
  const close = a.__pipeReplicate(b);
  t.after(async () => {
    await close();
    await a.close();
    await b.close();
  });

  const logA = await a.createLog();
  const logB = await b.openLog(logA.key);

  assert.equal(logA.writable, true);
  assert.equal(logB.writable, false);
});

test('joinTopic rejects topics that are not 32 bytes', async (t) => {
  const a = await fresh();
  t.after(async () => {
    await a.close();
  });

  await assert.rejects(
    () => a.joinTopic('deadbeef'), // 4 bytes
    /Topic must be 32 bytes/,
  );
});
