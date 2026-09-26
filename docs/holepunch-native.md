# Holepunch-native storage and sync

**Status:** recommendation from a spike, 26 Sep 2026 (workspace-sh/workspace#612).
Measured on a Linux machine (4 cores, 8 GB) over a local HyperDHT testnet.
The phone worklet and macOS child are still to be measured. The scripts are
in [`spikes/holepunch-native/`](../spikes/holepunch-native/).

**Recommendation: go Holepunch-native.** Hyperdrive and Autobase with
Hyperbee, Hypercore's own encryption, and Localdrive/MirrorDrive give every
behaviour the issue asks for, and they remove the layer Workspace wrote above
Hypercore (`encryptedLog`, and `blobs.ts`'s chunking). What's still ours is
small, and is listed under [Divergences](#divergences-each-a-decision) as a
decision each.

The split: **Hypercore carries, UCAN decides.** Hypercore and its modules
store, replicate, order and encrypt. UCAN decides who may read (the connection
gate), who may write (Autobase's `apply`) and who receives new keys.

## What was measured

Versions: hyperdrive 13.3.4, autobase 7.28.2, hyperbee 2.27.3, corestore
7.12.6, hypercore 11.37.0, localdrive 2.2.1, mirror-drive 1.14.2, hyperdht
6.34.0.

| | Result |
|---|---|
| **Tree on join** (encrypted Hyperdrive, 1,000 files, 20 MB) | The whole tree listed in 0.55 s after downloading **178 KB**. At 10,000 files, 3.5 s and 1.8 MB: about 180 bytes of tree per file, fetched block by block (prefetching the tree core should shorten this). |
| **Contents on open** | One 20 KB file: 20 KB fetched, 3 ms. `has()` is false before and true after. |
| **Clear** | `clear(path)` frees the contents, and the entry stays listed. Re-opening fetches it again, byte for byte. |
| **No key** | A peer without the encryption key can't even list the tree. |
| **Tiers in one core** | A Hypercore encryption provider that keys each block by tier: an org-only reader replicates and verifies every block but reads only org blocks, an HR reader reads all, and a keyless peer holds ciphertext. |
| **Cost of many cores** | Syncing N small encrypted cores to a joining peer: 100 in 0.5 s, 500 in 2.0 s, 2,000 in 6.8 s. Memory grows about 0.2 MB per open core (2,000 ≈ 425 MB). |
| **Tree on disk with placeholders** | MirrorDrive with `filter` (only what's downloaded) and `ignore` (placeholders), plus our step that writes `name.sparse` stubs. After opening, the stub is replaced by the file. After `clear`, **our step must delete the file on disk too**, or no space is freed. |
| **Multi-writer** | Three devices on an encrypted Autobase with a Hyperbee view. A writer is added in `apply` only with a valid UCAN `/workspace/write` delegation from the root; a read-only token is refused on every re-apply, and that device can't append. Concurrent writes, including to one path, converge identically on all three. |

## The shape

- **The tree** is an Autobase whose view is a Hyperbee: path → size, content
  hash, and where the contents are. Every member downloads the view, so they
  see the whole tree at once.
- **Contents** go in Hyperblobs cores, one per writer, fetched on open or pin
  (`download`) and freed with `clear`. With one writer this is exactly a
  Hyperdrive. Hyperdrive itself is single-writer, and no multi-writer drive
  exists in the modules checked, so the multi-writer shape is these native
  parts assembled.
- **Encryption** is Hypercore's own. **Key periods rotate inside a core**, as
  Autobase already does: each block's padding carries a key id, and a new
  period appends new key material rather than starting a new core. That keeps
  the core count near one per writer (per tier, if tiers get their own cores),
  instead of multiplying by periods. With 50 people, 5 tiers and 12 departures
  a year, a fresh drive per period would reach thousands of cores once every
  writer has its own; the measured cost rules that out on a phone.
- **On disk,** Localdrive + MirrorDrive keep the folder in step in both
  directions, and placeholders stand in for what hasn't been fetched.

## Against what a user should experience

1. **Join and see everything:** measured, yes.
2. **Private parts of shared things:** yes for contents, through tier keys. A
   tier block's *existence and size* stay visible to members who can't read
   it; hiding existence needs a separate core for that tier.
3. **Someone leaves:** new writes use a new key period, and nobody
   re-downloads anything. Exclusion is only as strong as the delivery of the
   new period's key (divergence 2).
4. **Several people edit:** converges (measured). Same-path merges follow
   ADR 0002 in `apply`.
5. **A phone with a huge table:** not measured. The shape allows a peer to
   answer queries, since a Hyperbee is sparse and queries fetch only the
   nodes they touch.
6. **A browser through its server:** not measured. The engine is the same
   Node process the Linux app already runs as a child.

## Divergences, each a decision

1. **A tier-keyed encryption provider.** Hypercore's documented extension
   point (`core.setEncryption`, the same one Autobase uses), with our class
   choosing the key per block. The native alternative is a separate core per
   tier: stronger (it hides existence), but records spanning tiers become
   joins across cores.
2. **Sealing each new period's key to the remaining members.** Autobase
   derives period keys from the base's shared key, so a departed member who
   kept it could derive later keys if they obtained the new key material. Its
   key descriptor is versioned, and that's the place to carry key material
   sealed per member. UCAN says who the members are.
3. **Placeholders on disk** are our step after MirrorDrive. No module writes
   them. OS-native placeholders (File Provider, Cloud Files, FUSE) come later.
4. **Time inside `apply`.** Autobase re-applies history, so `apply` must be
   deterministic, and a UCAN's expiry can't be checked there against any
   device's clock. Expiry is checked at the connection gate. Inside `apply`,
   revocation is a node in the log.
5. **The multi-writer tree is assembled** from Autobase, Hyperbee and
   Hyperblobs, not a stock module.

What this removes: `encryptedLog`, `blobs.ts`'s chunking, and the whole-document
entries that every device downloads.

## Still open

- **Runtime:** Hyperdrive, Autobase and MirrorDrive in the phone's Bare
  worklet and the macOS child, and the app-side interface they need (tree,
  get, put, has, download, clear, change events).
- **Migration:** pre-alpha, so existing workspaces are recreated.
