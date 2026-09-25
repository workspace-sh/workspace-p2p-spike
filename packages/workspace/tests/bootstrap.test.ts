// WORKSPACE_P2P_BOOTSTRAP: which DHT a child uses when a request names none.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { BOOTSTRAP_ENV, parseBootstrap } from '../src/ipc/bootstrap.ts';

test('unset means the public DHT, and "none" means no DHT', () => {
  assert.equal(parseBootstrap(undefined), undefined);
  assert.deepEqual(parseBootstrap('none'), []);
  assert.deepEqual(parseBootstrap(' none '), []);
});

test('host:port nodes, IPv4, names and bracketed IPv6', () => {
  assert.deepEqual(parseBootstrap('127.0.0.1:49737'), [{ host: '127.0.0.1', port: 49737 }]);
  assert.deepEqual(parseBootstrap('192.0.2.10:49737, dht.example:4000'), [
    { host: '192.0.2.10', port: 49737 },
    { host: 'dht.example', port: 4000 },
  ]);
  assert.deepEqual(parseBootstrap('[::1]:49737'), [{ host: '::1', port: 49737 }]);
});

test('anything else is refused rather than falling back to the public DHT', () => {
  for (const value of ['', '   ', 'localhost', '127.0.0.1:', ':49737', '127.0.0.1:0', '127.0.0.1:70000', '127.0.0.1:12ab', '::1:49737', 'a:1,,b:2']) {
    assert.throws(() => parseBootstrap(value), new RegExp(BOOTSTRAP_ENV), JSON.stringify(value));
  }
});

test('the child reads it from the environment it inherits', async () => {
  const script = fileURLToPath(new URL('../src/ipc/child-bin.ts', import.meta.url));
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', script], {
    env: { ...process.env, [BOOTSTRAP_ENV]: '127.0.0.1:49737' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  // Give it the moment it needs to start, then close stdin, which ends it.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  child.stdin.end();
  const code = await exited;

  assert.equal(code, 0);
  assert.match(stderr, /\[ws-child\] DHT: 127\.0\.0\.1:49737/);
});

test('a child given an invalid value exits instead of starting', async () => {
  const script = fileURLToPath(new URL('../src/ipc/child-bin.ts', import.meta.url));
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', script], {
    env: { ...process.env, [BOOTSTRAP_ENV]: 'localhost' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /is not host:port/);
});
