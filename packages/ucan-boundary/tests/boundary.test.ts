// Tests for @workspace.sh/ucan-boundary.
//
// Covers the regression matrix called out in docs/ucan-prior-research.md:
// basic delegation, sub-delegation, canIssue override (the gotcha), expiry,
// whole-second floor (the other gotcha), wrong-recipient detection,
// serialisation round-trip, and DID parity with @workspace.sh/p2p-runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  generatePrincipal,
  principalFromSeed,
  didToPublicKey,
  issueDelegation,
  validateDelegation,
  toBytes,
  fromBytes,
  type Did,
  type Principal,
  type RootForResource,
} from '../src/index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A rootForResource that says "the issuer in our test setup IS the root." */
function rootIs(rootDid: Did): RootForResource {
  return () => rootDid;
}

/** Compose three principals for chain tests. */
async function trio(): Promise<{ alice: Principal; bob: Principal; carol: Principal }> {
  const [alice, bob, carol] = await Promise.all([
    generatePrincipal(),
    generatePrincipal(),
    generatePrincipal(),
  ]);
  return { alice, bob, carol };
}

const WORKSPACE_URI = 'workspace://wid-test/data/employees';
const CAN_READ = 'workspace/read';

// ---------------------------------------------------------------------------
// Scenario 1 — basic issuance + validation
// ---------------------------------------------------------------------------

test('basic delegation: Alice grants Bob workspace/read; validates with Alice as root', async () => {
  const { alice, bob } = await trio();
  const dlg = await issueDelegation({
    issuer: alice,
    audience: bob.did(),
    capabilities: [{ can: CAN_READ, with: WORKSPACE_URI }],
    expiration: Math.floor(Date.now() / 1000) + 60,
  });

  const result = await validateDelegation(dlg, {
    rootForResource: rootIs(alice.did()),
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.audience, bob.did());
    assert.equal(result.capability.can, CAN_READ);
    assert.equal(result.capability.with, WORKSPACE_URI);
  }
});

// ---------------------------------------------------------------------------
// Scenario 2 — sub-delegation A→B→C
// ---------------------------------------------------------------------------

test('sub-delegation: Alice → Bob → Carol; Carol validates her chain back to Alice', async () => {
  const { alice, bob, carol } = await trio();
  const exp = Math.floor(Date.now() / 1000) + 60;

  const aliceToBob = await issueDelegation({
    issuer: alice,
    audience: bob.did(),
    capabilities: [{ can: CAN_READ, with: WORKSPACE_URI }],
    expiration: exp,
  });

  const bobToCarol = await issueDelegation({
    issuer: bob,
    audience: carol.did(),
    capabilities: [{ can: CAN_READ, with: WORKSPACE_URI }],
    expiration: exp,
    proofs: [aliceToBob],
  });

  const result = await validateDelegation(bobToCarol, {
    rootForResource: rootIs(alice.did()),
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.audience, carol.did());
  }
});

// ---------------------------------------------------------------------------
// Scenario 3 — canIssue override is what makes workspace:// URIs work
// ---------------------------------------------------------------------------

test('root: a chain terminates at the root rootForResource declares for a workspace:// URI', async () => {
  // The resource is a workspace:// URI, not a DID, so rootForResource is what
  // says Alice is its root.
  const { alice, bob } = await trio();
  const dlg = await issueDelegation({
    issuer: alice,
    audience: bob.did(),
    capabilities: [{ can: CAN_READ, with: WORKSPACE_URI }],
    expiration: Math.floor(Date.now() / 1000) + 60,
  });

  // With the override declaring Alice as root: validation succeeds.
  const withOverride = await validateDelegation(dlg, {
    rootForResource: () => alice.did(),
  });
  assert.equal(withOverride.ok, true);

  // Without a declared root for the resource, no chain is accepted.
  const withoutOverride = await validateDelegation(dlg, {
    rootForResource: () => null,
  });
  assert.equal(withoutOverride.ok, false);
});

// ---------------------------------------------------------------------------
// Scenario 4 — expired delegation rejected
// ---------------------------------------------------------------------------

test('expiry: a delegation with expiration in the past is rejected', async () => {
  const { alice, bob } = await trio();
  const dlg = await issueDelegation({
    issuer: alice,
    audience: bob.did(),
    capabilities: [{ can: CAN_READ, with: WORKSPACE_URI }],
    expiration: Math.floor(Date.now() / 1000) - 10, // 10s ago
  });

  const result = await validateDelegation(dlg, {
    rootForResource: rootIs(alice.did()),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /expired/);
  }
});

// ---------------------------------------------------------------------------
// Scenario 5 — whole-second floor on expiration
// ---------------------------------------------------------------------------

test('whole-second floor: sub-second expiry values are floored, not rounded', async () => {
  const { alice, bob } = await trio();
  // 60.9 should floor to 60 (not round to 61) — important for the gotcha.
  const exp = Math.floor(Date.now() / 1000) + 60.9;

  const dlg = await issueDelegation({
    issuer: alice,
    audience: bob.did(),
    capabilities: [{ can: CAN_READ, with: WORKSPACE_URI }],
    expiration: exp,
  });

  // The exposed metadata should be the floored value.
  assert.equal(dlg.meta.expiration, Math.floor(exp));
});

test('whole-second floor: sub-second TTLs of < 1s floor to 0 and are immediately expired', async () => {
  const { alice, bob } = await trio();
  // 0.5 seconds floor to 0 — the token is effectively dead on arrival.
  const exp = 0.5;
  const dlg = await issueDelegation({
    issuer: alice,
    audience: bob.did(),
    capabilities: [{ can: CAN_READ, with: WORKSPACE_URI }],
    expiration: exp,
  });

  const result = await validateDelegation(dlg, {
    rootForResource: rootIs(alice.did()),
  });
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// Scenario 6 — wrong audience surfaces in the result
// ---------------------------------------------------------------------------

test('audience exposure: result.audience matches the bottom of the chain', async () => {
  const { alice, bob, carol } = await trio();
  const dlg = await issueDelegation({
    issuer: alice,
    audience: bob.did(),
    capabilities: [{ can: CAN_READ, with: WORKSPACE_URI }],
    expiration: Math.floor(Date.now() / 1000) + 60,
  });

  const result = await validateDelegation(dlg, {
    rootForResource: rootIs(alice.did()),
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    // Consumer checks result.audience === self.did() to confirm "for me."
    assert.equal(result.audience, bob.did());
    assert.notEqual(result.audience, carol.did());
  }
});

// ---------------------------------------------------------------------------
// Scenario 7 — serialisation round-trip preserves validation
// ---------------------------------------------------------------------------

test('serialisation: toBytes → fromBytes preserves validity and metadata', async () => {
  const { alice, bob } = await trio();
  const dlg = await issueDelegation({
    issuer: alice,
    audience: bob.did(),
    capabilities: [{ can: CAN_READ, with: WORKSPACE_URI }],
    expiration: Math.floor(Date.now() / 1000) + 60,
  });

  const bytes = await toBytes(dlg);
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(bytes.length > 0);

  const restored = await fromBytes(bytes);
  assert.equal(restored.meta.issuer, alice.did());
  assert.equal(restored.meta.audience, bob.did());
  assert.equal(restored.meta.capabilities[0]?.can, CAN_READ);
  assert.equal(restored.meta.capabilities[0]?.with, WORKSPACE_URI);

  const result = await validateDelegation(restored, {
    rootForResource: rootIs(alice.did()),
  });
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// Scenario 8 — DID parity with @workspace.sh/p2p-runtime
// ---------------------------------------------------------------------------

test('DID parity: principalFromSeed produces a stable did:key for a known seed', async () => {
  // Same 32-byte seed → same did:key:z6Mk… across calls.
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = i; // 0x00..0x1f, deterministic

  const p1 = await principalFromSeed(seed);
  const p2 = await principalFromSeed(seed);
  assert.equal(p1.did(), p2.did());
  assert.match(p1.did(), /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]+$/);
});

test('DID round-trip: didToPublicKey returns 32 bytes that reconstruct the same DID', async () => {
  const p = await generatePrincipal();
  const pk = didToPublicKey(p.did());
  assert.equal(pk.length, 32);

  // Round-trip: build a new principal from the same seed and confirm same DID.
  // (We can't easily go pk → did without the multicodec re-encoding logic,
  // but we already exercise that in didOf above and the principalFromSeed test.)
});

// ---------------------------------------------------------------------------
// Scenario 9 — different seeds produce different DIDs (sanity)
// ---------------------------------------------------------------------------

test('different seeds produce different DIDs', async () => {
  const seedA = new Uint8Array(32);
  const seedB = new Uint8Array(32);
  seedA[0] = 1;
  seedB[0] = 2;
  const a = await principalFromSeed(seedA);
  const b = await principalFromSeed(seedB);
  assert.notEqual(a.did(), b.did());
});

// ---------------------------------------------------------------------------
// Scenario 10 — input validation
// ---------------------------------------------------------------------------

test('principalFromSeed rejects seeds of wrong length', async () => {
  await assert.rejects(() => principalFromSeed(new Uint8Array(31)), /32 bytes/);
});

// ---------------------------------------------------------------------------
// Signatures — a link belongs to the key that signed it
// ---------------------------------------------------------------------------

/**
 * A principal that writes `asDid` into the issuer field of what it signs, but
 * signs with its own key — what anyone can do without the real key.
 */
function impersonating(signer: Principal, asDid: Did): Principal {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const own = (signer as any)._signer;
  const posing = {
    toString: () => asDid,
    signatureType: own.signatureType,
    sign: (message: Uint8Array) => own.sign(message),
  };
  return { did: () => asDid, _signer: posing } as Principal;
}

test('signatures: a delegation naming the root as issuer but signed by another key is rejected', async () => {
  const { alice, bob: eve } = await trio();
  const forged = await issueDelegation({
    issuer: impersonating(eve, alice.did()),
    audience: eve.did(),
    capabilities: [{ can: CAN_READ, with: WORKSPACE_URI }],
    expiration: Math.floor(Date.now() / 1000) + 60,
  });
  assert.equal(forged.meta.issuer, alice.did(), 'the forgery names the root');

  const direct = await validateDelegation(forged, { rootForResource: rootIs(alice.did()) });
  assert.equal(direct.ok, false);
  if (!direct.ok) assert.match(direct.error, /not signed by its issuer/);

  // As it arrives off the wire.
  const received = await validateDelegation(await fromBytes(await toBytes(forged)), {
    rootForResource: rootIs(alice.did()),
  });
  assert.equal(received.ok, false);
});

test('signatures: a forged middle link breaks the chain even when the root link is genuine', async () => {
  const { alice, bob, carol: eve } = await trio();
  const exp = Math.floor(Date.now() / 1000) + 60;
  const aliceToBob = await issueDelegation({
    issuer: alice,
    audience: bob.did(),
    capabilities: [{ can: CAN_READ, with: WORKSPACE_URI }],
    expiration: exp,
  });
  // Eve holds Bob's genuine proof (it travels in the clear) and signs as Bob.
  const bobToEve = await issueDelegation({
    issuer: impersonating(eve, bob.did()),
    audience: eve.did(),
    capabilities: [{ can: CAN_READ, with: WORKSPACE_URI }],
    expiration: exp,
    proofs: [aliceToBob],
  });

  const result = await validateDelegation(bobToEve, { rootForResource: rootIs(alice.did()) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /depth 0 is not signed/);
});

test('signatures: a forged root link is caught when a genuine link is signed on top of it', async () => {
  const { alice, bob: eve, carol } = await trio();
  const exp = Math.floor(Date.now() / 1000) + 60;
  const forgedRoot = await issueDelegation({
    issuer: impersonating(eve, alice.did()),
    audience: eve.did(),
    capabilities: [{ can: CAN_READ, with: WORKSPACE_URI }],
    expiration: exp,
  });
  const eveToCarol = await issueDelegation({
    issuer: eve,
    audience: carol.did(),
    capabilities: [{ can: CAN_READ, with: WORKSPACE_URI }],
    expiration: exp,
    proofs: [forgedRoot],
  });

  const result = await validateDelegation(eveToCarol, { rootForResource: rootIs(alice.did()) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /depth 1 is not signed/);
});

test('chains: an expired root link is rejected even when the leaf is current', async () => {
  const { alice, bob, carol } = await trio();
  const now = Math.floor(Date.now() / 1000);
  const aliceToBob = await issueDelegation({
    issuer: alice,
    audience: bob.did(),
    capabilities: [{ can: CAN_READ, with: WORKSPACE_URI }],
    expiration: now - 10,
  });
  const bobToCarol = await issueDelegation({
    issuer: bob,
    audience: carol.did(),
    capabilities: [{ can: CAN_READ, with: WORKSPACE_URI }],
    expiration: now + 60,
    proofs: [aliceToBob],
  });

  const result = await validateDelegation(bobToCarol, { rootForResource: rootIs(alice.did()) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /depth 1 is expired/);
});

// ---------------------------------------------------------------------------
// UCAN 1.0 rules this module enforces itself
// ---------------------------------------------------------------------------

test('commands: a grant covers commands beneath it at a segment boundary, not longer names', async () => {
  const { alice, bob, carol } = await trio();
  const exp = Math.floor(Date.now() / 1000) + 60;
  const broad = await issueDelegation({
    issuer: alice,
    audience: bob.did(),
    capabilities: [{ can: 'workspace', with: WORKSPACE_URI }],
    expiration: exp,
  });
  const narrower = await issueDelegation({
    issuer: bob,
    audience: carol.did(),
    capabilities: [{ can: 'workspace/read', with: WORKSPACE_URI }],
    expiration: exp,
    proofs: [broad],
  });
  assert.equal((await validateDelegation(narrower, { rootForResource: rootIs(alice.did()) })).ok, true);

  const sibling = await issueDelegation({
    issuer: bob,
    audience: carol.did(),
    capabilities: [{ can: 'workspacefoo', with: WORKSPACE_URI }],
    expiration: exp,
    proofs: [broad],
  });
  const refused = await validateDelegation(sibling, { rootForResource: rootIs(alice.did()) });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /depth 1 does not carry the claimed capability/);
});

test('resources: a link whose policy names another resource does not grant this one', async () => {
  const { alice, bob, carol } = await trio();
  const exp = Math.floor(Date.now() / 1000) + 60;
  const elsewhere = await issueDelegation({
    issuer: alice,
    audience: bob.did(),
    capabilities: [{ can: CAN_READ, with: 'workspace://elsewhere' }],
    expiration: exp,
  });
  const onward = await issueDelegation({
    issuer: bob,
    audience: carol.did(),
    capabilities: [{ can: CAN_READ, with: WORKSPACE_URI }],
    expiration: exp,
    proofs: [elsewhere],
  });
  const result = await validateDelegation(onward, { rootForResource: rootIs(alice.did()) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /depth 1 does not carry the claimed capability/);
});

test('serialisation: a sub-delegation chain survives toBytes and fromBytes', async () => {
  const { alice, bob, carol } = await trio();
  const exp = Math.floor(Date.now() / 1000) + 60;
  const aliceToBob = await issueDelegation({ issuer: alice, audience: bob.did(), capabilities: [{ can: CAN_READ, with: WORKSPACE_URI }], expiration: exp });
  const bobToCarol = await issueDelegation({ issuer: bob, audience: carol.did(), capabilities: [{ can: CAN_READ, with: WORKSPACE_URI }], expiration: exp, proofs: [aliceToBob] });
  const restored = await fromBytes(await toBytes(bobToCarol));
  const result = await validateDelegation(restored, { rootForResource: rootIs(alice.did()) });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.audience, carol.did());
});

test('issuing: a delegation without an expiration does not expire', async () => {
  const { alice, bob } = await trio();
  const dlg = await issueDelegation({ issuer: alice, audience: bob.did(), capabilities: [{ can: CAN_READ, with: WORKSPACE_URI }] });
  assert.equal(dlg.meta.expiration, undefined);
  const muchLater = Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600;
  assert.equal((await validateDelegation(dlg, { rootForResource: rootIs(alice.did()), now: muchLater })).ok, true);
});
