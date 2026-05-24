# Workspace P2P Spike

Research spike for Workspace's P2P data + permissions layer. Outcome:
a `.workspace` portable bundle format, a `workspace://` URI scheme for
discovery, and a working implementation of the permissions layer that
sits underneath.

This spike has moved beyond its original "evaluate Hypercore" question.
The Hypercore answer was yes; the work since has been designing and
implementing the layers above it.

---

## The two concepts that matter

### `.workspace` — the folder is the unit

A `.workspace` is a folder (or an archive of one) that contains a
collection of files plus the metadata needed to sync them and enforce
access between peers. The folder *is* the workspace. Sharing is a
file-system operation: copy it to a USB stick, AirDrop it, drop it on
a NAS, attach it to an email.

What's on disk is already safe to share — public files appear in
plaintext, tier-gated content lives only as encrypted bytes inside
`_workspace/`, and per-recipient bootstrap envelopes are sealed to
their intended DIDs. Copy-paste sharing does not leak. No "export"
step is needed for safety.

### `workspace://` — the URI

The same workspace, addressable by URL. Encodes the bootstrap metadata
(workspace ID, root DID, Hyperswarm topic, attestation) compactly
enough to embed in a chat message, a QR code, or a webpage. Tap it on
any platform that has the Workspace app installed; the app opens,
validates the attestation, asks the user to confirm, joins the swarm.

This is the magnet-link analogue: tiny, URL-shareable, leaks nothing
sensitive, the actual content lives in the swarm.

Together, the folder form and the URI form are the two ways a
workspace gets distributed and discovered. They carry the same
underlying metadata; one is a file, one is a URL; both lead to the
same place.

See [`docs/workspace-format.md`](./docs/workspace-format.md) for the
full format spec.

---

## Status

| | |
|---|---|
| Phase 1 — Node runtime (Hypercore + Hyperswarm) | done |
| Phase 3a — JSON-RPC IPC over stdio | done |
| Phase 3b — macOS TurboModule (NSTask) | done |
| Permissions layer — wrap primitive | implemented |
| Permissions layer — UCAN delegation boundary | implemented |
| Permissions layer — root attestation | implemented |
| Permissions layer — bootstrap envelopes | implemented |
| Live key delivery log ([#9](https://github.com/workspace-sh/workspace-p2p-spike/issues/9)) | pending |
| Topic-layer authentication ([#10](https://github.com/workspace-sh/workspace-p2p-spike/issues/10)) | pending |
| Autobase wrapper ([#11](https://github.com/workspace-sh/workspace-p2p-spike/issues/11)) | pending |
| Mobile path ([#6](https://github.com/workspace-sh/workspace-p2p-spike/issues/6)) | separate workstream |

Permissions epic: [#5](https://github.com/workspace-sh/workspace-p2p-spike/issues/5).
Active development on [`feat/permissions-layer`](https://github.com/workspace-sh/workspace-p2p-spike/tree/feat/permissions-layer)
(PR #22). 65 tests green across three packages; typecheck clean.

---

## How the layers fit

```
┌─────────────────────────────────────────────────────────────────────┐
│  .workspace folder / workspace:// URI                               │  ← Portable / discoverable
├─────────────────────────────────────────────────────────────────────┤
│  Bootstrap envelopes + bundled manifest + root attestation          │  ← @workspace/portable-bootstrap
├─────────────────────────────────────────────────────────────────────┤
│  UCAN delegations (issue, validate, serialise, canIssue override)   │  ← @workspace/ucan-boundary
├─────────────────────────────────────────────────────────────────────┤
│  Wrap primitive + root attestation + did:key encode/decode          │  ← @workspace/p2p-runtime (crypto)
├─────────────────────────────────────────────────────────────────────┤
│  Hypercore logs + Hyperswarm topics + NSTask IPC                    │  ← @workspace/p2p-runtime (sync)
└─────────────────────────────────────────────────────────────────────┘
```

Each layer composes on the one below. Files in `.workspace/` are
self-contained at rest; the URI form is a pointer the app resolves.
The cryptographic substrate is the same regardless of how the
workspace was distributed.

---

## Repository layout

```
.
├── README.md                            ← you are here
├── PLAN.md                              ← original spike scope
├── FINDINGS.md                          ← Phase 1–3 verdict + extraction checklist
├── docs/
│   ├── workspace-format.md              ← .workspace format spec + workspace:// URI
│   ├── permissions-model.md             ← UCAN + Hypercore protocol design
│   ├── threat-model.md                  ← what Workspace protects (and doesn't)
│   ├── risks.md                         ← where this could fail and what we're doing
│   └── ucan-prior-research.md           ← UCAN library notes from earlier spike
├── packages/
│   ├── p2p-runtime/                     ← @workspace/p2p-runtime
│   │   └── src/
│   │       ├── types.ts                 ← P2PRuntime, Log, Did, TopicId, LogKey
│   │       ├── runtime.{node,ios,android,macos,web,windows}.ts
│   │       ├── did.ts                   ← did:key encode/decode (ed25519)
│   │       ├── wrap.ts                  ← X25519 ECDH sealed envelopes
│   │       └── attestation.ts           ← root attestation sign/verify
│   ├── ucan-boundary/                   ← @workspace/ucan-boundary
│   │   └── src/index.ts                 ← every ucanto call lives here
│   └── portable-bootstrap/              ← @workspace/portable-bootstrap
│       └── src/index.ts                 ← createBundle / consumeBundle
└── apps/
    ├── node/                            ← smoke harness over real Hyperswarm
    ├── macos/native/                    ← P2PRuntimeModule (Obj-C++ TurboModule)
    └── macos-probe/                     ← Swift probe validating the NSTask path
```

---

## Install + verify

```sh
npm install                                  # workspace install
npm run typecheck                            # tsc --noEmit across all packages
npm run test                                 # runs every package's tests
```

Smoke against the real Hyperswarm DHT (needs internet):

```sh
npm -w @workspace/p2p-spike-node run smoke
```

Spins up two `NodeRuntime` instances, joins them on a shared topic,
appends three blocks on peer A, reads them back on peer B. Last
verified replication: ~260 ms.

npm-only. Bun does not compose cleanly with `react-native-macos`.

---

## Documentation

The design lives in `docs/`:

- **[`workspace-format.md`](./docs/workspace-format.md)** — `.workspace`
  format spec, `workspace://` URI, on-disk shape, hidden schema
  entries, the workspace policy file, portability semantics
- **[`permissions-model.md`](./docs/permissions-model.md)** — UCAN +
  Hypercore + Autobase protocol design, two-carrier envelope delivery,
  revocation, scaling
- **[`threat-model.md`](./docs/threat-model.md)** — what Workspace
  protects, what it explicitly does not, forward-only revocation,
  cooperative-client policy, audit-trail-as-capability-chain
- **[`risks.md`](./docs/risks.md)** — seven failure modes assessed
  honestly, positions taken, residual unknowns
- **[`ucan-prior-research.md`](./docs/ucan-prior-research.md)** —
  UCAN library notes (library comparison, gotchas)

Start with `workspace-format.md` if you want to understand what's
being built. Then `threat-model.md` for the contract that bounds it,
`permissions-model.md` for the cryptographic protocol underneath, and
`risks.md` for an honest assessment of where this could fall down.

---

## Related repositories

- [`workspace-sh/workspace`](https://github.com/workspace-sh/workspace)
  — the consuming app
- [`workspace-sh/table-file-format`](https://github.com/workspace-sh/table-file-format)
  — the `.table` file format spec; see PR #26 for the
  permissions-side view
