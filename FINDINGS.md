# P2P Spike Findings

**Verdict: Go.**

Hypercore is a viable P2P data layer for Workspace across Node, macOS, and (by extension) mobile. The open questions from PLAN.md are answered.

---

## What Was Proven

### Node (Phase 1)
Hypercore + Hyperswarm run cleanly under Node 20+. Two runtimes on the same machine replicated a log in ~260ms via the real DHT. Corestore v7 requires a filesystem path (RocksDB-backed); `:memory:` is a test shim over a temp directory.

### IPC — spawned Node child (Phase 3a)
A parent process drives a `NodeRuntime` in a child process over line-delimited JSON-RPC on stdin/stdout. Full round-trip: `init → createLog → append → get → events → shutdown`. 8 integration tests, all green. The protocol is platform-neutral — the child code is unchanged regardless of who spawns it.

### macOS — NSTask path (Phase 3b)
Swift's `Process` (= NSTask) spawns the Node child and speaks the same protocol without modification. The Obj-C++ TurboModule (`P2PRuntimeModule.mm`) is written and ready to drop into any RN-macOS project. The Swift probe passed all checks cold.

Bonus: Hypercore's append events crossed the NSTask boundary unprompted. The "zero-cost change signal" from issue #1 — a peer learning a log grew without fetching the payload — works out of the box. No extra wiring required.

---

## Architecture That Follows

```
React Native JS
  └── @workspace/p2p-runtime (runtime.macos.ts)
        └── SpawnedRuntime  ←  MacOSTransport
                                  └── P2PRuntimeModule (Obj-C++ TurboModule)
                                        └── NSTask → node child-bin.ts
                                                        └── NodeRuntime
                                                              └── Corestore + Hyperswarm
```

The JS surface (`P2PRuntime` interface) is identical across all platforms. Only the spawning mechanism changes per platform.

---

## What Was Designed (not yet implemented)

### Permissions model (`docs/permissions-model.md`)

A full design for tiered access control on Hypercore logs using UCAN
delegation, symmetric encryption per tier, Autobase for multi-writer
collaboration, and a key delivery channel that itself rides on
Hypercore. Includes a worked example (54-person org), revocation
levers (encryption layer + topic layer), and a scaling story (simple
model to ~500 peers, MLS as the upgrade path beyond 10k).

Validated as workable; every component is either in production today
(Autobase, ucanto) or has a well-trodden standards-based answer
(MLS / RFC 9420). No research-grade cryptography required.

The consumer-facing view of the same model lives in
[`table-file-format/docs/PERMISSIONS.md`](https://github.com/workspace-sh/table-file-format/blob/develop/docs/PERMISSIONS.md).

### DID identity

`did:key:z6Mk…` derivation from Corestore's `primaryKey` is now
**implemented** (`packages/p2p-runtime/src/did.ts`). The format matches
what ucanto expects in delegation chains. One keypair, one identity,
no translation layer.

---

## Open Questions (not blockers)

- **Mobile (Phase 2)** — react-native-bare-kit is the likely path for iOS/Android. Not spiked; treat as a separate workstream. ([#6](https://github.com/workspace-sh/workspace-p2p-spike/issues/6))
- **Node binary on macOS** — development uses the system `node`; a production RN-macOS app needs a bundled static binary or an assumption that Node is present. Either is tractable.
- **Corestore persistence** — `:memory:` is a temp directory under the hood. Production storage path needs to be wired to the app's sandbox container.
- **Permissions implementation** — design is complete; implementation is the next major piece. Key pieces: UCAN delegation via ucanto, Autobase for multi-writer, key delivery Hypercore log, Hyperswarm topic-layer authentication. ([#5](https://github.com/workspace-sh/workspace-p2p-spike/issues/5))

---

## Extraction Checklist (main monorepo)

1. Copy `packages/p2p-runtime` → Workspace monorepo as `@workspace/p2p-runtime`.
2. Add `apps/macos/native/P2PRuntimeModule.h` + `.mm` to the macOS Xcode target.
3. Wire `runtime.macos.ts` export in the package — Metro resolves `.macos.ts` automatically.
4. Set `childScriptPath` + `nodeBin` in the macOS app bootstrap.
5. Phase 2 (mobile) is a separate spike — `react-native-bare-kit` replaces the NSTask path on iOS/Android.
