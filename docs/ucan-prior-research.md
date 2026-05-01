# UCAN + Hypercore prior research (April 2026)

Notes from a parallel exploration that ran briefly before this spike's scope was clarified. The work is **out of scope here** (PLAN.md explicitly defers UCAN to a later spike) but the findings are preserved for whoever picks up the UCAN integration thread later.

The exploration built three in-process peer nodes, gave them ed25519 / did:key identities, used [@ucanto/core](https://www.npmjs.com/package/@ucanto/core) for capability minting + chain validation, and ran a 10-scenario integration test covering role grants, sub-delegation, revocation cascade, and expiry. **All 10 scenarios passed.**

## headline

UCAN + Hypercore can deliver offline-verifiable role-based permissions across peer nodes with no central authority. Sub-delegation and revocation work as expected. The gap between "spike works" and "production-ready" is mostly in the p2p substrate (Autobase for conflict resolution, on-device runtime), not in UCAN itself.

## library choice — ucanto, not iso-ucan

Three JS UCAN libraries worth considering:

- **`@ucanto/core` 10.4.6 (Storacha)** — used. Mature, ~5k weekly downloads, runs in production at web3.storage. Wire format is a DAG-CBOR dialect that **predates ucan-wg v1.0.0-rc.1**. Has a real revocation hook. Pure ESM. Ran fine on Node 20.
- **`iso-ucan` 0.4.2 (Hugo Dias)** — only JS lib tracking ucan-wg v1.0.0-rc.1 envelopes today. ~200 weekly downloads. **Revocation module not yet exported.** Closer to the spec, further from production.
- **`@ipld/dag-ucan` 3.4.5** — pure codec. Targets v0.9.1. Used as a dependency by ucanto. Not a full solution alone.
- The old JWT-based `ucans`/`ts-ucan` line is dead. Don't.

For a real Workspace integration the choice is between **(a) ship faster on ucanto** and accept that wire-format interop with rs-ucan/go-ucan is one-way, or **(b) wait/build on iso-ucan** for ucan-wg v1.0 fidelity at the cost of building revocation yourself. The boundary module pattern (every ucanto call confined to one file) makes a future swap a 1–2 day job; the real cost is the capability-model rewrite (ucanto's `with`+`can` → ucan-wg's `sub`+`cmd`+`pol` policy predicates).

## what surprised me

1. **ucanto's authority termination assumed DID-as-resource.** Default `canIssue` checks `capability.with === issuer.did()` — Storacha's `store/add` etc. all use the service's own DID as the resource URI. Workspace-style URIs (`workspace://folderId/path/`) never satisfy this, so chains never terminate. Fix is one-line: pass a custom `canIssue` that says "the folder's root DID can self-issue any capability on this folder." Trivial once you read the validator source. **Not obvious from the README.**
2. **Self-signed root delegations don't help.** First instinct (mint a `carl→carl` delegation as the chain root) is rejected by ucanto's `access()`. Use the `canIssue` override above instead.
3. **UCAN sub-delegation just works.** A holder of Editor on `Novoda/` can issue Viewer on `Novoda/strategy/` to an external DID without asking root. Chain validates back to the root authority. The `capability/delegate` ability becomes a soft UI marker, not a hard check — UCAN's "if you hold it you can re-delegate it" semantic is in the protocol.
4. **Revocation per-edge cascades for free.** Revoking Leslie's delegation kills every chain that passes through it — including the external reviewer she sub-delegated to. Cheap to implement: walk the chain CIDs, reject if any is in the local revocation set.
5. **Ucanto expiry is whole seconds.** Sub-second TTLs `Math.floor` to zero. Use seconds.

## production caveats — read before resuming

1. **Per-peer feed + last-writer-wins projection.** The spike used one Hypercore feed per peer per folder, with each peer rebuilding its in-memory projection on every read. Concurrent writes to the same path are last-writer-wins. **Autobase is the right answer** for the eventual Workspace integration; budget a week to port.
2. **Wire format is one-way.** ucanto cannot interop with rs-ucan/go-ucan. If Workspace ever needs to integrate a non-ucanto UCAN service, this becomes a real blocker.
3. **Trust-on-first-use root.** The spike took `FolderMeta.rootDid` on faith. Production needs root to sign an attestation over `(folderId, createdAt)` so peers receiving the meta can verify the creator's claim.
4. **No identity recovery.** Ed25519 keys were per-process. Productionisation needs device-linking, rotation, and recovery UX.
5. **Storage growth.** Append-only feeds never shrink. Hypercore supports snapshots/truncation but using them in a multi-peer replicated context is non-trivial.
6. **The ucan-wg v1.0 policy model matters long-term.** New `cmd`+`pol` model expresses constraints like "write file X only if size < N" — not possible in ucanto's `with`+`can`. If Workspace needs fine-grained caveats beyond resource+ability, iso-ucan becomes more attractive.

## ecosystem notes

- The ucan-wg v1.0.0-rc.1 work is real and active. Spec + invocation actively edited in early 2026; delegation + revocation quiet since mid-2025 (likely settled, not abandoned).
- Modular now: `spec` (envelope) + `delegation` + `invocation` + `revocation` + `promise` + `container` + `receipt`, each its own repo under `ucan-wg/`.
- IPLD-native (DAG-CBOR + Varsig). `did:key` mandatory. Ed25519 preferred; P-256 + secp256k1 also required.
- Capability model entirely changed from 0.x: `{can, with}` pair → `sub` + `cmd` + `pol` policy predicates. Bigger semantic shift than the encoding change.

## what to do when this thread resumes

1. **Pick a UCAN library deliberately**, in light of where iso-ucan's revocation story has landed by then. If still no revocation module: ucanto.
2. **Write a boundary module first** (`@workspace/ucan-boundary` or similar, single file, every UCAN call lives there). The spike's experience was that confining ucanto to one file made the design clearer and the future swap viable.
3. **Use Autobase, not per-peer feeds.** Skip the spike's last-writer-wins shortcut.
4. **Implement the root attestation.** Don't ship trust-on-first-use.
5. **Run the same 10 scenarios** as a regression suite.
