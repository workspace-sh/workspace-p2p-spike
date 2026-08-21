# P2P Spike Findings

**Verdict: Go.**

Hypercore is a viable P2P data layer for Workspace across Node, macOS,
and (by extension) mobile. The permissions, addressing, and discovery
layers on top are designed and partially implemented.

---

## What was proven

### Node runtime
Hypercore + Hyperswarm run cleanly under Node 22.6+ (we use `--experimental-strip-types` for TypeScript execution without a transpile step, which needs that version). Two runtimes on the same machine replicated a log in ~260ms via the real DHT. Corestore v7 requires a filesystem path (RocksDB-backed); `:memory:` is a test shim over a temp directory.

### IPC — spawned Node child
A parent process drives a `NodeRuntime` in a child process over line-delimited JSON-RPC on stdin/stdout. Full round-trip: `init → createLog → append → get → events → shutdown`. 8 integration tests, all green. The protocol is platform-neutral — the child code is unchanged regardless of who spawns it.

### macOS — NSTask path
Swift's `Process` (= NSTask) spawns the Node child and speaks the same protocol without modification. The Obj-C++ TurboModule (`P2PRuntimeModule.mm`) is written and ready to drop into any RN-macOS project. The Swift probe passed all checks cold.

Bonus: Hypercore's append events crossed the NSTask boundary unprompted. The "zero-cost change signal" from issue #1 — a peer learning a log grew without fetching the payload — works out of the box. No extra wiring required.

---

## What was built (implemented, in PR #22)

### `@workspace.sh/p2p-runtime` crypto additions

- `wrap.ts` — X25519 ECDH sealed envelopes for symmetric key delivery
- `seal.ts` — XSalsa20-Poly1305 symmetric AEAD (`seal` / `open`) for content under a workspace/tier key
- `encrypted-log.ts` — `encryptedLog(log, key)` wraps any `Log` so blocks seal on append / open on get; tier-gated content rides the same replication path as ciphertext
- `attestation.ts` — root attestation sign/verify (ed25519)
- `did.ts` extensions — `did:key:z6Mk…` encode + decode (bidirectional)

### `@workspace.sh/ucan-boundary`

UCAN delegation boundary module — every ucanto call confined to one file so a future library swap stays a small change. Surface: `issueDelegation`, `validateDelegation` (with the `canIssue` override for `workspace://` URIs), `toBytes` / `fromBytes` for transport, `WHOLE_SECOND_FLOOR` named constant for the expiry gotcha.

### `@workspace.sh/portable-bootstrap`

Two-carrier permissions delivery, sharing one envelope atom:

- **Bundle (offline first-contact)** — `createBundle` / `consumeBundle` compose wrap + ucan + attestation into the `.workspace` envelope flow, plus `writeBundleFolder` / `readBundleFolder` for disk round-trip. A recipient validates the attestation, unwraps the keys, joins.
- **Live key delivery log (#9, steady-state)** — `publishDelivery` / `scanDeliveries` over a replicated Hypercore: an admin appends a sealed envelope addressed to a peer who joined *after* creation; that peer scans from a cursor, validates the UCAN against the workspace root, and unwraps. Same `createEnvelope` / `consumeEnvelope` as the bundle.
- **Topic-layer membership auth (#10)** — `verifyMembership` binds a presented UCAN to the connection's authenticated Noise key, checks revocation, and validates the chain to the workspace root. Wired into the runtime via `CreateRuntimeOptions.auth` (gate replication behind a proof exchange) + `identitySeed` (Noise key == DID). Verified live: members replicate, a wrong-root peer is rejected at connect.

### `@workspace.sh/workspace` — app-facing SDK facade

The surface the Workspace app is built against. One object composes everything: `Workspace.create` (identity, K0_org, logs, bundle, topic, auth gate — one call), `.open` (attestation + envelope + K0_org recovery + gate + replication), `.invite` (sealed envelope to both carriers), `.write` / `.entries` (transparent encrypted log), `.on('change')`. Platform-agnostic — the runtime is injected, so the package is native-dep-free and unit-testable. v1 is single-writer; Autobase multi-writer (#11), the document/section model, and `workspace://` join are deferred behind the same API. The `demo:workspace` runs the Acme flow end-to-end over a private swarm in ~10 lines (vs ~200 hand-wired).

### Tests

**110 tests green across the four packages**, typecheck clean.

### DID identity

`did:key:z6Mk…` derivation from Corestore's `primaryKey` is now **implemented** (`packages/p2p-runtime/src/did.ts`). The format matches what ucanto expects in delegation chains. One keypair, one identity, no translation layer.

---

## What was designed (specs locked, implementation pending)

Nine design docs in `docs/`, all consistent and cross-referenced:

| Doc | Role |
|---|---|
| `workspace-format.md` | `.workspace` on-disk format, policy.json, hidden fields, external-edits watcher |
| `uri-scheme.md` | `workspace://` URI scheme, path namespaces, locator alphabets per format |
| `discovery.md` | DNS TXT + `.well-known/workspace` for domain-based discovery |
| `discovery-layers.md` | Local-first / LAN / WAN peer-discovery hierarchy |
| `lighthouse.md` | Trusted always-on node a workspace opts into for availability |
| `permissions-model.md` | UCAN + Hypercore protocol, two-carrier envelope delivery, revocation, scaling |
| `threat-model.md` | What Workspace protects / doesn't, forward-only revocation, cooperative-client policy, audit-trail = capability-chain |
| `risks.md` | Failure modes, mitigations, identity-fusion migration cost, successor-chain |
| `ucan-prior-research.md` | UCAN library notes, gotchas, library comparison |

Validated as workable; every cryptographic component is either in production today (Autobase, ucanto, Hypercore/Hyperswarm, sodium-universal) or has a well-trodden standards-based answer (MLS / RFC 9420 for enterprise scale). No research-grade cryptography required.

The consumer-facing view of the permissions model lives in [`table-file-format/docs/PERMISSIONS.md`](https://github.com/workspace-sh/table-file-format/blob/develop/docs/PERMISSIONS.md).

---

## Architecture that follows

```
React Native JS
  └── @workspace.sh/p2p-runtime (runtime.macos.ts)
        └── SpawnedRuntime  ←  MacOSTransport
                                  └── P2PRuntimeModule (Obj-C++ TurboModule)
                                        └── NSTask → node child-bin.ts
                                                        └── NodeRuntime
                                                              └── Corestore + Hyperswarm
```

Per-platform JS surface (`P2PRuntime` interface) is identical. Only the spawning mechanism changes per platform.

On top of the runtime sits the permissions layer (wrap + UCAN + attestation + portable bootstrap), the URI addressing scheme (`workspace://`), and optional discovery (DNS TXT + `.well-known`).

---

## Open work (tracked on the project board)

- ~~**Live key delivery log** ([#9](https://github.com/workspace-sh/workspace-p2p-spike/issues/9))~~ — **implemented**; remaining: scan-efficiency tuning + GC of superseded blocks
- ~~**Topic-layer authentication** ([#10](https://github.com/workspace-sh/workspace-p2p-spike/issues/10))~~ — **implemented**: connection-time membership gate (Noise key bound to DID, UCAN verified to root before replication); remaining: topic rotation on departure
- **Autobase wrapper** ([#11](https://github.com/workspace-sh/workspace-p2p-spike/issues/11)) + **merge strategy** ([#12](https://github.com/workspace-sh/workspace-p2p-spike/issues/12)) — multi-writer document API
- **Identity recovery / device linking** ([#17](https://github.com/workspace-sh/workspace-p2p-spike/issues/17))
- **MLS upgrade-path placeholder** ([#18](https://github.com/workspace-sh/workspace-p2p-spike/issues/18))
- **UCAN library choice ADR** ([#19](https://github.com/workspace-sh/workspace-p2p-spike/issues/19))
- **`.workspace` folder + archive shape** ([#24](https://github.com/workspace-sh/workspace-p2p-spike/issues/24))
- **DNS discovery design** ([#25](https://github.com/workspace-sh/workspace-p2p-spike/issues/25)) — doc done; implementation pending
- **LAN discovery via mDNS** — designed in [`docs/discovery-layers.md`](./docs/discovery-layers.md); implementation deferred (~200 lines on top of Holepunch's `multicast-dns`)
- **PAN discovery (Bluetooth / Wi-Fi Direct / AWDL)** — backlogged; revisit when mobile is in scope
- **Mobile path** ([#6](https://github.com/workspace-sh/workspace-p2p-spike/issues/6)) — separate workstream

Project board: https://github.com/orgs/workspace-sh/projects/6

---

## Open questions (not blockers)

- **Node binary on macOS** — development uses the system `node`; a production RN-macOS app needs a bundled static binary or an assumption that Node is present. Either is tractable.
- ~~**Corestore persistence**~~ — **resolved** ([ADR 0003](./docs/adr/0003-store-dual-form.md)): the store has two forms. The RocksDB working store lives in app-private storage (macOS Application Support; mobile app containers); `.workspace/store/` carries an append-only serialised transport form, flushed on close/share and hydrated on open. Normative detail in [`workspace-format.md`](./docs/workspace-format.md) § `store/`; app-side implementation tracked in workspace#249.

---

## Extraction checklist (main monorepo)

1. Copy `packages/p2p-runtime` → Workspace monorepo as `@workspace.sh/p2p-runtime`.
2. Copy `packages/ucan-boundary` → `@workspace.sh/ucan-boundary`.
3. Copy `packages/portable-bootstrap` → `@workspace.sh/portable-bootstrap`.
4. Add `apps/macos/native/P2PRuntimeModule.h` + `.mm` to the macOS Xcode target.
5. Wire `runtime.macos.ts` export in the package — Metro resolves `.macos.ts` automatically.
6. Set `childScriptPath` + `nodeBin` in the macOS app bootstrap.
7. The mobile path is a separate spike — `react-native-bare-kit` replaces the NSTask path on iOS/Android.
8. Lift the nine design docs into the main monorepo (or keep them in the spike repo with cross-references).
