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

### `@workspace/p2p-runtime` crypto additions

- `wrap.ts` — X25519 ECDH sealed envelopes for symmetric key delivery
- `attestation.ts` — root attestation sign/verify (ed25519)
- `did.ts` extensions — `did:key:z6Mk…` encode + decode (bidirectional)

### `@workspace/ucan-boundary`

UCAN delegation boundary module — every ucanto call confined to one file so a future library swap stays a small change. Surface: `issueDelegation`, `validateDelegation` (with the `canIssue` override for `workspace://` URIs), `toBytes` / `fromBytes` for transport, `WHOLE_SECOND_FLOOR` named constant for the expiry gotcha.

### `@workspace/portable-bootstrap`

Bundle creation and consumption — composes wrap + ucan + attestation into the offline `.workspace` envelope flow. Two peers, one issues a sealed envelope to the other's DID, the recipient validates the attestation, unwraps the keys, and joins. End-to-end demonstrated.

### Tests

**65 tests green across the three packages**, typecheck clean.

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
  └── @workspace/p2p-runtime (runtime.macos.ts)
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

- **Live key delivery log** ([#9](https://github.com/workspace-sh/workspace-p2p-spike/issues/9)) — the live-swarm carrier counterpart to bundled envelopes
- **Topic-layer authentication** ([#10](https://github.com/workspace-sh/workspace-p2p-spike/issues/10)) — UCAN check at the noise handshake; the second revocation lever
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
- **Corestore persistence** — `:memory:` is a temp directory under the hood. Production storage path needs to be wired to the app's sandbox container.

---

## Extraction checklist (main monorepo)

1. Copy `packages/p2p-runtime` → Workspace monorepo as `@workspace/p2p-runtime`.
2. Copy `packages/ucan-boundary` → `@workspace/ucan-boundary`.
3. Copy `packages/portable-bootstrap` → `@workspace/portable-bootstrap`.
4. Add `apps/macos/native/P2PRuntimeModule.h` + `.mm` to the macOS Xcode target.
5. Wire `runtime.macos.ts` export in the package — Metro resolves `.macos.ts` automatically.
6. Set `childScriptPath` + `nodeBin` in the macOS app bootstrap.
7. The mobile path is a separate spike — `react-native-bare-kit` replaces the NSTask path on iOS/Android.
8. Lift the nine design docs into the main monorepo (or keep them in the spike repo with cross-references).
