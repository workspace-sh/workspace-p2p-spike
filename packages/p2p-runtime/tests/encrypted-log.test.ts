// Tests for the transparent encrypted-log wrapper (`src/encrypted-log.ts`).
//
// Unit tests use an in-memory fake Log to exercise the wrapper logic in
// isolation. One integration test pairs two real NodeRuntime instances via
// the direct pipe to prove encryption survives actual Hypercore replication
// — and that the bytes on the underlying replica are ciphertext.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encryptedLog } from '../src/encrypted-log.ts';
import { NodeRuntime } from '../src/runtime.node.ts';
import type { Log, LogKey } from '../src/types.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

function freshKey(): Uint8Array {
  const k = new Uint8Array(32);
  crypto.getRandomValues(k);
  return k;
}

// Minimal in-memory Log for unit tests. Holds whatever bytes are appended;
// `raw()` exposes them so tests can assert the stored form is ciphertext.
function memoryLog(): Log & { raw(i: number): Uint8Array } {
  const blocks: Uint8Array[] = [];
  const listeners: Array<() => void> = [];
  return {
    key: 'mem' as LogKey,
    writable: true,
    get length() {
      return blocks.length;
    },
    async append(b: Uint8Array) {
      blocks.push(b);
      for (const l of listeners) l();
      return blocks.length;
    },
    async get(i: number) {
      return blocks[i]!;
    },
    on(_event: 'append', cb: () => void) {
      listeners.push(cb);
      return () => {};
    },
    async close() {},
    raw(i: number) {
      return blocks[i]!;
    },
  };
}

// ---------------------------------------------------------------------------
// Unit: wrapper logic
// ---------------------------------------------------------------------------

test('round-trip: append plaintext, get returns the same plaintext', async () => {
  const key = freshKey();
  const log = encryptedLog(memoryLog(), key);
  await log.append(enc.encode('hello workspace'));
  assert.equal(dec.decode(await log.get(0)), 'hello workspace');
});

test('underlying log holds ciphertext, not plaintext', async () => {
  const key = freshKey();
  const backing = memoryLog();
  const log = encryptedLog(backing, key);
  await log.append(enc.encode('secret'));

  const stored = backing.raw(0);
  // Stored bytes are longer than plaintext (nonce + MAC overhead) and don't
  // contain the plaintext.
  assert.ok(stored.length > 'secret'.length);
  assert.notEqual(dec.decode(stored), 'secret');
});

test('wrong key: a wrapper with a different key cannot read', async () => {
  const backing = memoryLog();
  const writer = encryptedLog(backing, freshKey());
  await writer.append(enc.encode('only the right key reads this'));

  const reader = encryptedLog(backing, freshKey()); // different key
  await assert.rejects(() => reader.get(0), /open failed/);
});

test('key length is validated', () => {
  assert.throws(() => encryptedLog(memoryLog(), new Uint8Array(16)), /must be 32 bytes/);
});

test('pass-through: key, writable, length reflect the underlying log', async () => {
  const key = freshKey();
  const backing = memoryLog();
  const log = encryptedLog(backing, key);
  assert.equal(log.key, 'mem');
  assert.equal(log.writable, true);
  assert.equal(log.length, 0);
  await log.append(enc.encode('x'));
  assert.equal(log.length, 1);
});

test('append events pass through', async () => {
  const key = freshKey();
  const log = encryptedLog(memoryLog(), key);
  let fired = 0;
  const off = log.on('append', () => {
    fired++;
  });
  await log.append(enc.encode('a'));
  await log.append(enc.encode('b'));
  off();
  assert.equal(fired, 2);
});

test('caller mutating the key buffer afterwards does not affect the wrapper', async () => {
  const key = freshKey();
  const log = encryptedLog(memoryLog(), key);
  await log.append(enc.encode('before mutation'));
  key.fill(0); // mutate the original buffer
  // The wrapper copied the key, so reads still work.
  assert.equal(dec.decode(await log.get(0)), 'before mutation');
});

// ---------------------------------------------------------------------------
// Integration: encryption survives real Hypercore replication
// ---------------------------------------------------------------------------

test('encrypted log replicates: B decrypts with the key, raw replica is ciphertext', async (t) => {
  const a = new NodeRuntime({ storage: ':memory:' });
  const b = new NodeRuntime({ storage: ':memory:' });
  await a.ready();
  await b.ready();
  const close = a.__pipeReplicate(b);
  t.after(async () => {
    await close();
    await a.close();
    await b.close();
  });

  const key = freshKey();

  const aRaw = await a.createLog();
  const aLog = encryptedLog(aRaw, key);
  await aLog.append(enc.encode('# Q2 retro'));
  await aLog.append(enc.encode('action: ship'));

  // B opens the same log by key, replicates the blocks.
  const bRaw = await b.openLog(aRaw.key);
  const start = Date.now();
  while (bRaw.length < 2 && Date.now() - start < 3000) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(bRaw.length, 2, 'both blocks should replicate to B');

  // B's raw replica holds ciphertext.
  const rawBlock = await bRaw.get(0);
  assert.notEqual(dec.decode(rawBlock), '# Q2 retro');

  // Wrapped with the key, B reads plaintext.
  const bLog = encryptedLog(bRaw, key);
  assert.equal(dec.decode(await bLog.get(0)), '# Q2 retro');
  assert.equal(dec.decode(await bLog.get(1)), 'action: ship');
});
