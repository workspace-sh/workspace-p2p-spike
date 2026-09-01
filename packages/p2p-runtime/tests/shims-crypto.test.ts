// The crypto shim substitutes for Node's `crypto` inside the Bare worklet,
// where no such module exists (#243). It is reached only through bare-pack's
// --imports override, so nothing else in the test suite would catch a
// regression in it — and a wrong digest here would silently corrupt UCAN
// CIDs rather than fail loudly.
//
// The contract is equivalence with Node's createHash, so that is what these
// assert, against Node's own implementation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash as nodeCreateHash } from 'node:crypto';

import { createHash } from '../src/shims/crypto.ts';

const VECTORS = ['', 'a', 'hello from bare', 'workspace://z6MkpKpf2nFiC5h9qDPgJrkBbYBaThkAEcVCgGuBHkXqK4Vc'];

for (const algorithm of ['sha256', 'sha512'] as const) {
  test(`${algorithm}: matches node:crypto for representative inputs`, () => {
    for (const input of VECTORS) {
      const expected = nodeCreateHash(algorithm).update(input).digest();
      const actual = createHash(algorithm).update(input).digest() as Uint8Array;
      assert.deepEqual(
        Buffer.from(actual),
        expected,
        `${algorithm} mismatch for ${JSON.stringify(input)}`,
      );
    }
  });

  test(`${algorithm}: chunked update matches a single update`, () => {
    // multiformats calls update() once, but Node's contract allows many and
    // the shim buffers rather than streaming — worth pinning.
    const whole = createHash(algorithm).update('hello from bare').digest() as Uint8Array;
    const chunked = createHash(algorithm)
      .update('hello ')
      .update('from ')
      .update('bare')
      .digest() as Uint8Array;
    assert.deepEqual(Buffer.from(chunked), Buffer.from(whole));
  });

  test(`${algorithm}: hex encoding matches node:crypto`, () => {
    const expected = nodeCreateHash(algorithm).update('hello from bare').digest('hex');
    const actual = createHash(algorithm).update('hello from bare').digest('hex');
    assert.equal(actual, expected);
  });
}

test('an unsupported algorithm throws rather than returning wrong bytes', () => {
  // sodium omits SHA-1 deliberately. Failing loudly is the point: a silent
  // fallback would produce a plausible digest that is not a SHA-1.
  assert.throws(() => createHash('sha1'), /unsupported algorithm 'sha1'/);
  assert.throws(() => createHash('md5'), /unsupported algorithm 'md5'/);
});
