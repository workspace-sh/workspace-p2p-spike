# Permissions prior art: WNFS, UCAN 1.0 and Keyhive

**Status:** research note, 14 Sep 2026. Input to [`join-by-link.md`](./join-by-link.md) Decide 4
(one permission model for private and public). Not a decision.

What Brooklyn Zelenka's work (WNFS at Fission; UCAN; Keyhive, BeeKEM and Beelay at
Ink & Switch) teaches the existing design in [`permissions-model.md`](./permissions-model.md),
[`workspace-format.md`](./workspace-format.md) § Permission semantics, and the table format's
`docs/PERMISSIONS.md`.

**Legend:** **[R]** read in the linked primary source. **[I]** inference.

**Not read:** `guide.fission.codes` and `fission.codes` no longer resolve (the Fission farewell
post was read through the Wayback Machine); no talk videos; the Cryptree paper only as cited by
WNFS and Keyhive.

---

## 1. WNFS structure

**Partitions**
- **[R]** The WNFS spec is v0.2.0-alpha and carries a "Work-in-Progress" banner. It claims a state-based CRDT merge and says "service providers can validate writes without reading the contents" ([README](https://github.com/wnfs-wg/spec/blob/main/README.md)).
- **[R]** The **public** partition is plain DAG-CBOR nodes:
  - `wnfs/pub/dir` maps entry names to CIDs or IPNS symlinks.
  - `wnfs/pub/file` points to a UnixFS content CID.
  - Both carry `previous` history links and merge as a semilattice ([public-wnfs.md](https://github.com/wnfs-wg/spec/blob/main/spec/public-wnfs.md)).
- **[R]** An **exchange** partition sits at the root, "next to `public` and `private`". It is a public directory of each device's exchange keys ([shared-private-data.md §2](https://github.com/wnfs-wg/spec/blob/main/spec/shared-private-data.md)). It was moved out of `/public/.well-known/` so that write access to it can be controlled by its own UCAN capability ([rationale](https://github.com/wnfs-wg/spec/blob/main/rationale/shared-private-data.md)).
- **[R]** Older root layouts:
  - The ODD SDK root had `public`, `p` (pretty), `private`, `privateLog`, `shared`, `sharedCounter` and `version` ([path/index.ts](https://github.com/oddsdk/ts-odd/blob/main/src/path/index.ts)).
  - The Fission whitepaper root was `pretty/public/private/revoked` ([root.md](https://github.com/fission-codes/whitepaper/blob/master/file-system/partitions/root.md)).
  - The whitepaper also defined "unlisted" files: cleartext public nodes stored inside the private forest ([unlisted](https://github.com/fission-codes/whitepaper/blob/master/file-system/partitions/unlisted-directories.md)).
- **[I]** Public and private are separate top-level trees, and I found no per-node "public" flag inside a private tree in v0.2. Making something public means writing it into the public partition.

**Private partition: what is stored where** ([private-wnfs.md](https://github.com/wnfs-wg/spec/blob/main/spec/private-wnfs.md))
- **[R]** The **encrypted layer** is a flat, Merklized HAMT called the `PrivateForest`:
  - Node degree is 16.
  - Keys ("labels") are hashes of `NameAccumulator`s.
  - Values are sets of raw CIDs of ciphertext blocks. Several CIDs under one label are concurrent writes to the same path and revision.
  - The forest root stores the RSA accumulator modulus and generator.
  - One forest "MAY represent a whole forest of … completely unrelated" trees (the "dark forest").
  - Blocks SHOULD be under 256 KiB, which also blurs file-size distribution (§2, §2.1).
- **[R]** The **decrypted layer**:
  - `PrivateNodeHeader {ratchet, inumber, name}` is deterministically encrypted (AES-KWP).
  - `PrivateDirectory` and `PrivateFile` are encrypted with XChaCha20-Poly1305.
  - A directory maps entry names to `PrivateRef {label, contentCid, snapshotKey, temporalKey (wrapped)}`.
  - Files are either inline or "externalized". Externalized content uses a random content key, and each block's label is derived from `baseName` and its block index (§3.1, §3.1.4, §4.4). Cipher choices are in [rationale/encryption.md](https://github.com/wnfs-wg/spec/blob/main/rationale/encryption.md).
- **[R]** **Name accumulators**:
  - A label is an RSA-2048 accumulator over the random prime i-numbers of every path segment, plus a revision segment derived from the ratchet (§4.1, [nameaccumulator.md](https://github.com/wnfs-wg/spec/blob/main/spec/nameaccumulator.md)).
  - The representation must not leak path nodes, must not be correlatable across paths, and must not reveal segment count (§4).
  - They replaced the earlier **namefilters**: Bloom filters with 2048 bits, 30 hashes and about 47 elements. Namefilters had an element limit, and proving membership revealed the element ([rationale/write-verification.md](https://github.com/wnfs-wg/spec/blob/main/rationale/write-verification.md)).
- **[R]** Merge is additive and set-union at the HAMT level. A third party with no read access can do it ("blind merge"). Readers tie-break conflicting values (§4.5).

## 2. WNFS private key hierarchy

- **[R] Skip ratchet.**
  - It has three hash digits (large, medium, small) plus a salt, and steps forward only.
  - Keys come from BLAKE3 `derive_key` with domain separation ([skip-ratchet.md](https://github.com/wnfs-wg/spec/blob/main/spec/skip-ratchet.md)).
  - Paper: Zelenka, "Skip Ratchet: A Hierarchical Hash System" ([eprint 2022/1078](https://eprint.iacr.org/2022/1078)).
- **[R] Temporal and snapshot keys.**
  - A temporal key is derived from a node's ratchet. It grants that revision, all later revisions, and descendants (§3.1.6.1, §3.1.7.2).
  - A snapshot key is `derive_key(temporal key)` and grants only one revision plus the children in that snapshot (§3.1.6.2).
  - A directory stores each child's snapshot key in the clear. It stores the child's temporal key wrapped under the directory's own temporal key, so a snapshot-only reader cannot get revision access (§3.1.6.1).
- **[R] Hierarchy (Cryptree-style).** "Access granted to a single node … implies access to all of its child nodes (and no others)", never parents or siblings (§3.1.7). The whitepaper names Cryptree as the technique ([keys-and-pointers](https://github.com/fission-codes/whitepaper/blob/master/access-control/query-and-read/keys-and-pointers.md)).
- **[R] Time direction.** The abstract calls this a "backward secret mechanism": a grant is "from that time forward — but never access to the past" ([private-wnfs.md §0](https://github.com/wnfs-wg/spec/blob/main/spec/private-wnfs.md)). A reader finds later revisions by stepping the ratchet forward, using exponential search (§4.2).
- **[R] Sharing a subtree.**
  1. Build a share pointer: `{label, cid, temporalKey | snapshotKey}`.
  2. RSAES-OAEP-encrypt it to each of the recipient's device exchange keys.
  3. Store it in the sender's forest at `accumulate(senderRootDID, recipientExchangeKey, counter)`.
  4. The recipient scans counters upward from 0 until the first missing label.
  - To share several nodes, create a directory and share that ([shared-private-data.md §3–7](https://github.com/wnfs-wg/spec/blob/main/spec/shared-private-data.md)).
- **Revoking and rotating.**
  - **[R]** I found no revocation algorithm in the v0.2 spec.
  - **[R]** rs-wnfs rotates keys in `prepare_key_rotation`: new i-number, reset ratchet, name re-parented under the destination. `update_ancestry` applies this recursively over the subtree, and it runs on `attach`, which `basic_mv` and `cp` call ([directory.rs](https://github.com/wnfs-wg/rs-wnfs/blob/main/wnfs/src/private/directory.rs), [node.rs](https://github.com/wnfs-wg/rs-wnfs/blob/main/wnfs/src/private/node/node.rs)).
  - **[R]** The whitepaper says revocation means changing the address and/or key. Holders of copies keep access, and remaining users must be re-granted ([revocation.md](https://github.com/fission-codes/whitepaper/blob/master/access-control/query-and-read/revocation.md)).
  - **[I]** Anyone holding a temporal key can derive every future revision of that ratchet. Removing a reader therefore means re-seeding the whole subtree, at a cost proportional to subtree size. What WNFS gives is "backward secrecy" (a new grantee cannot read the past). It is not forward secrecy, and removal secrecy needs re-keying.
- **What an outsider sees.**
  - **[R] Hidden, by design:** file-system structure, path segments, the `previous` links (encrypted "to protect from metadata leakage"), and recency. The authors avoided splay trees for exactly this reason ([rationale/hamt.md](https://github.com/wnfs-wg/spec/blob/main/rationale/hamt.md)).
  - **[I] Still visible:**
    - Total block count and ciphertext volume.
    - Which labels change between two root CIDs, and when.
    - Inline-content block sizes.
    - Equal header ciphertexts from concurrent writers (header encryption is deterministic).
    - The full-size block pattern of externalized files.
    - Share labels. They are computable from public data (sender DID, recipient exchange key, counter), so an observer can count shares between a given pair.
    - For write-proof verifiers: which signed accumulator (delegated subtree) each change falls under.

## 3. How WNFS uses UCAN

- **Write authorisation (v0.2).**
  - **[R]** The owner signs a "certificate" containing the delegate's public key and the accumulator of the directory being delegated.
  - **[R]** The writer proves each changed label extends that accumulator, using batched PoKE* proofs. A persistence service checks the proofs without read access (§4.2–4.4). There is a runnable example in [write_proofs.rs](https://github.com/wnfs-wg/rs-wnfs/blob/main/wnfs/examples/write_proofs.rs).
  - **[R]** The accumulator setup is a "per-WNFS trusted setup by the root owner" ([write-verification rationale](https://github.com/wnfs-wg/spec/blob/main/rationale/write-verification.md)).
- **Write authorisation (Fission production).**
  - **[R]** The UCAN resource type was `wnfs`, rooted at a DNSLink.
  - **[R]** Public paths matched by prefix, with a trailing slash inferred so `foo/bar` does not match `foo/barbaz`.
  - **[R]** Private paths were given as "bare" namefilters.
  - **[R]** Abilities were monotone: `CREATE` < `REVISE` < `SOFT_DELETE` < `OVERWRITE` < `SUPER_USER` ([webnative-attenuation.md](https://github.com/fission-codes/whitepaper/blob/master/access-control/ucan/webnative-attenuation.md)).
  - **[R]** The ODD SDK tokens used pre-standard `rsc`/`ptc` fields ([ucan/types.ts](https://github.com/oddsdk/ts-odd/blob/main/src/ucan/types.ts)).
- **Read access is keys, not capabilities.**
  - **[R]** "Query access is mediated entirely by references and cryptographic keys" ([keys-and-pointers](https://github.com/fission-codes/whitepaper/blob/master/access-control/query-and-read/keys-and-pointers.md)).
  - **[R]** In the ODD SDK, the auth lobby returned `ucans` **plus** a `readKey` and `bareNameFilter` for each private path ([capabilities.ts](https://github.com/oddsdk/ts-odd/blob/main/src/capabilities.ts), [fission-lobby.ts](https://github.com/oddsdk/ts-odd/blob/main/src/components/capabilities/implementation/fission-lobby.ts)).
- **Share flows.**
  - **[R]** Share payloads carry "secrets giving read access and/or UCANs giving write access" ([shared-private-data §0](https://github.com/wnfs-wg/spec/blob/main/spec/shared-private-data.md)).
  - **[R]** Sender authentication is left to UCAN ([rationale](https://github.com/wnfs-wg/spec/blob/main/rationale/shared-private-data.md)).
  - **[R]** Keys also travelled over WebRTC pubsub and "directly in query parameters", and "anyone with read access can also grant the same access to others without alerting the owner" ([keys-and-pointers](https://github.com/fission-codes/whitepaper/blob/master/access-control/query-and-read/keys-and-pointers.md)).
- **UCAN revocation inside the file system.**
  - **[R]** The whitepaper put revocations at `/revoke/*` as a grow-only trie, and validators had to check non-inclusion ([revoke.md](https://github.com/fission-codes/whitepaper/blob/master/file-system/partitions/revoke.md)).
  - **[R]** UCAN 0.10 cites WNFS keeping revoked CIDs at a well-known path ([v0.10.0 §6.6](https://github.com/ucan-wg/spec/blob/v0.10.0/README.md)).

## 4. UCAN 1.0

**Status and shape**
- **[R]** The spec, delegation and invocation documents were bumped to **v1.0.0** on 2026-07-08 ([spec](https://github.com/ucan-wg/spec), [delegation](https://github.com/ucan-wg/delegation), [invocation](https://github.com/ucan-wg/invocation)). [Revocation](https://github.com/ucan-wg/revocation) is still **v1.0.0-rc.1**. (Our `ucan-prior-research.md` still says rc.1 for all of them.)
- **[R]** A capability is `subject × command × policy`. The Subject is a DID, and "unless explicitly stated, the Resource … MUST be the Subject". External resources SHOULD appear as a `uri` inside the policy ([delegation §Resource](https://github.com/ucan-wg/delegation)).
- **[R]** Commands:
  - They are slash paths, and a shorter one proves longer ones: `/crypto` proves `/crypto/sign` but not `/cryptocurrency`.
  - `/` means everything.
  - `/ucan/*` is reserved ([spec §Command](https://github.com/ucan-wg/spec)).
- **[R]** Policy is a jq-like predicate language:
  - Operators: `==`, `!=`, `<`/`>`, `like` (only `*` globs), `and`/`or`/`not`, `all`/`any`.
  - An invocation's `args` "MUST pass validation of the Policies on all of the Delegations" in its proofs ([invocation §Arguments](https://github.com/ucan-wg/invocation)).
- **[R]** Other rules:
  - The delegation payload has **no `prf` field**. Proof chains are assembled in the invocation.
  - `nonce` is required.
  - The envelope is DAG-CBOR with a Varsig header, and CIDs are DAG-CBOR SHA-256 (`zdpu…`) ([spec §Envelope](https://github.com/ucan-wg/spec)).

**Per-resource read/edit/publish on a path prefix** (**[I]** a mapping of the rules above):
```js
{ iss: adminDID, aud: memberDID, sub: workspaceRootDID,
  cmd: "/document/edit",                              // "/document" would also prove read and publish
  pol: [["any", ".ancestors", ["==", ".", "scope:9f3c"]]], nonce, exp }
// invocation (or gate check) args: { scope: "scope:1a2b", ancestors: ["scope:0000","scope:9f3c","scope:1a2b"] }
```
- Glob paths (`["like", ".path", "/finance/*"]`) also work. But `*` crosses `/`, and paths change on rename, so stable scope IDs fit better. That is WNFS's i-number lesson (§2).
- Our current resource pattern needs a `canIssue` override in ucanto. In 1.0 it is native: root delegations require `iss == sub` ([revocation §Path Witness](https://github.com/ucan-wg/revocation)).

**Attenuation**
- **[R]** Each delegation MUST restate or narrow its authority.
- **[R]** Every `aud` must match the next `iss` (principal alignment), and all time bounds must be valid.
- **[R]** Powerline (`sub: null`) delegates all future authority from the issuer, whatever the subject. The subject is substituted at validation time, and powerline may not be used as a root delegation ([delegation §Powerline](https://github.com/ucan-wg/delegation)).
- **[R]** UCAN gives no confinement: delegates can always sub-delegate ([spec §Security](https://github.com/ucan-wg/spec)).

**Public / "anyone"**
- **[R]** There is no wildcard or array audience. Brooklyn Zelenka: "There is no array of audiences in UCAN" ([spec#143](https://github.com/ucan-wg/spec/issues/143)).
- **[R]** The invocation spec has a "Public Resources" section: an executor "MAY accept Invocations without having a 'closed-loop' proof chain, but this SHOULD NOT be the default" ([invocation](https://github.com/ucan-wg/invocation)).
- **[I]** Public access is therefore expected outside UCAN, or through a well-known principal. Keyhive does the latter (§7.1).

**Revocation (rc.1)** ([revocation](https://github.com/ucan-wg/revocation))
- **[R]** Any issuer in a chain may revoke that delegation, including transitively, using a `/ucan/revoke` invocation with the revoked CID and an optional `path` witness.
- **[R]** Revocations are immutable and form a growing set.
- **[R]** Accept revocations that arrive before the delegation they target.
- **[R]** Evict a revocation once its delegation expires.
- **[R]** Revoking one delegation does not block another valid chain.
- **[R]** For CRDTs, keep the revocation store "directly inside the resource".

**ucanto (0.9-era) vs 1.0**

| | ucanto / `@ipld/dag-ucan` | UCAN 1.0 |
|---|---|---|
| Version and encoding | Targets **UCAN v0.9.1**. DAG-CBOR primary, raw-JWT fallback, formattable as JWT **[R]** ([dag-ucan](https://github.com/ipld/js-dag-ucan)) | Varsig envelope, `ucan/dlg@1.0.0` **[R]** |
| Capability | `{with, can, nb}`. Default `derives`: `with` prefix only if the delegated value ends in `*`; `nb` equality; `ucan:*` resource **[R]** ([capability.js](https://github.com/storacha/ucanto/blob/main/packages/validator/src/capability.js)) | `sub` + `cmd` + `pol` predicates |
| All-device delegation | `ucan:*` ([v0.10 §4.1](https://github.com/ucan-wg/spec/blob/v0.10.0/README.md)) | Powerline `sub: null` |
| Proofs | Inside each token | Only in invocations |
| Revocation | `validateAuthorization` hook **[R]** ([lib.js](https://github.com/storacha/ucanto/blob/main/packages/validator/src/lib.js)). v0.10 used a JSON `{iss, revoke, challenge}` message **[R]** | `/ucan/revoke` invocation |

- **[R]** Current npm versions: `@ucanto/core` 10.4.6 (2025-10-27), `@ucanto/validator` 10.0.1, `@ucanto/principal` 9.0.3. We are on validator 9.
- **[R]** `iso-ucan` 0.5.0 (2026-04-19) still has no revocation module ([iso-repo](https://github.com/hugomrdias/iso-repo/tree/main/packages/iso-ucan)).

## 5. What is alive

| Project | Status |
|---|---|
| WNFS spec | WIP banner, last commit 2024-04-11 **[R]** ([repo](https://github.com/wnfs-wg/spec)) |
| rs-wnfs | "isn't actively developed at the moment, but we do have some maintainers" **[R]**. `wnfs` 0.3.0 released 2025-10-21 ([crates.io](https://crates.io/crates/wnfs)). Last commit 2026-06-15 was a dependency fix **[R]** ([repo](https://github.com/wnfs-wg/rs-wnfs)) |
| ODD SDK (ts-odd) | Last push 2023-10-16 **[R]** ([repo](https://github.com/oddsdk/ts-odd)) |
| Fission | Wound down by end of May 2024. UCAN, WNFS and IPVM moved to working-group orgs **[R]** ([farewell, Wayback](https://web.archive.org/web/20241013011438/https://fission.codes/blog/farewell-from-fission/)). IPVM's Homestar last pushed 2024-09-26 **[R]** ([repo](https://github.com/ipvm-wg/homestar)) |
| UCAN | Spec final 1.0.0 (revocation rc.1). [go-ucan](https://github.com/ucan-wg/go-ucan) pushed 2026-09-12, [rs-ucan](https://github.com/ucan-wg/rs-ucan) 2026-06-22, ts-ucan last 2024-03 **[R]** |
| Brooklyn Zelenka | GitHub company `@inkandswitch` **[R]** ([profile](https://github.com/expede)). UCAN spec lists her as editor at "Witchcraft Software" **[R]** |
| Keyhive / Subduction | Active, pre-alpha (see §7) |

## 6. Mapping WNFS ideas onto Hypercore

**Holepunch facts this rests on**
- **[R]** To replicate a core you must know its key. Each side sends a capability `hash(role, core key, Noise handshakeHash)`, and a wrong one is rejected ([caps.js](https://github.com/holepunchto/hypercore/blob/main/lib/caps.js)).
- **[R]** Corestore "does not exchange Hypercore keys". It auto-attaches any locally stored core when a remote opens that core's discovery key, and has no per-connection authorisation hook ([README](https://github.com/holepunchto/corestore), [index.js `_attachMaybe`](https://github.com/holepunchto/corestore/blob/main/index.js)).
- **[R]** Hyperswarm's `firewall` works per remote public key only ([README](https://github.com/holepunchto/hyperswarm)).
- **[R]** Discovery keys can be announced without leaking the core key. Core info exposes `length` and `byteLength`. The manifest lists the signers. Encryption is separate from the core key ([hypercore README](https://github.com/holepunchto/hypercore)).
- **[R]** `hypercore-encryption` looks keys up by id, which supports key epochs ([README](https://github.com/holepunchto/hypercore-encryption)).
- **[R]** Autobase:
  - `apply` must be fully deterministic.
  - There is one base-wide `encryptionKey`.
  - Order can change until `signedLength`, which needs an indexer quorum.
  - `host.addWriter` / `removeWriter` run inside apply.
  - Source: [README](https://github.com/holepunchto/autobase). Internally `lib/encryption.js` keeps keys by id, but I found no documented rotation API ([encryption.js](https://github.com/holepunchto/autobase/blob/main/lib/encryption.js)).

**Maps cleanly** (all **[I]**)
- WNFS pointer + key maps to core key + scope key.
- Cryptree key bags map to key records in a scope's log.
- A UCAN write check maps to a UCAN check in Autobase `apply`.
- Share payloads map to the existing key-delivery log.
- Blind merge maps to Autobase linearisation.
- Knowing the core key is a native per-core read gate.

**Does not map** (all **[I]**)
- WNFS gets unlinkability by putting everything in one content-addressed HAMT under random labels. Hypercore's unit is a named, append-only log with visible length and signers.
- WNFS's forward-only ratchet lets a grantee *skip the past*. An Autobase view must be replayed from all history, the same constraint Keyhive states for CRDTs ([design README](https://github.com/inkandswitch/keyhive/blob/main/design/README.md)).
- Re-keying a WNFS subtree rewrites nodes. Hypercore history cannot be re-encrypted.

**Concrete adaptation sketch** (all **[I]**)
1. **Scope** = a stable scope ID (file, folder, or the whole workspace). Each scope has epoch keys `K_s^e`.
   - A scope's key record, delivered through the existing key-delivery log, contains its children's current keys (Cryptree) and the previous epoch key (Keyhive causal keys).
   - A grant on a folder then means one sealed delivery that opens its subtree and its history.
2. **Replication domain** = one or more cores/Autobases per *coarse* unit: the workspace, plus any sensitive folder.
   - The connection gate attaches a core to a connection only if that peer's UCAN grants at least `relay` on a scope in that domain. This is Subduction's `filter_authorized_fetch(peer, ids)` (§7.3), and it replaces Corestore's all-to-all attach.
   - Inside a domain, finer scopes are separated by keys only. Today's tier model already works this way ([PERMISSIONS.md](https://github.com/workspace-sh/table-file-format/blob/develop/docs/PERMISSIONS.md): "A peer without K2 replicates all blocks").
3. **Entries** = a plaintext envelope `{scopeId, author, ucanProofCid}` plus a ciphertext body. `apply` checks `document/edit` against the envelope, so indexers and peers without the scope key still compute the same view. This is WNFS's "validate writes without reading" goal.
4. **Publish** = a `document/publish` write that creates a *new* public scope: a snapshot copy with a fresh core and key, whose key goes into the link or listing. It does not publish the private scope's live key.
5. **Removal** = a new epoch for the scope and every descendant the removed member could reach, with keys re-delivered to the remaining holders. Optionally rotate the topic too, as permissions-model already plans.

**Pitfalls** (all **[I]**, built on the **[R]** facts above)
- **Metadata from separate cores.** Separate cores expose scope count, size, growth, timing and per-scope writers. Announcing each core on the DHT ties IP addresses to scopes. A connected peer who once knew a discovery key can probe for it. Mitigations: announce only the workspace topic, keep per-scope cores to "existence is sensitive" cases, and gate attaching per core.
- **Revoked members keep core keys.** A revoked member still knows old core keys and can replicate new ciphertext from any peer that does not filter per core. Rotating encryption keys does not change the core key.
- **Rotation cost.** Each removal is O(descendant scopes) new key records plus O(remaining holders) seals, including narrower grantees further down. WNFS pays a similar subtree cost (rs-wnfs `update_ancestry`).
- **Publishing a live key leaks history.** With causal keys, publishing a live scope key exposes its whole history, and the Cryptree hierarchy exposes every child key, including private subfolders. So a public folder must not key-link to private children. It may list them, similar to the `hiddenFields` pattern.
- **Wall-clock time in `apply` breaks determinism.** UCAN `exp`/`nbf` checked against the current time inside `apply` makes views diverge. Check them at ingestion or against causal position.
- **Autobase ordering.** An edit concurrent with a revocation can flip between applied and not applied until `signedLength` settles. Keyhive notes "back-dating operations is always possible" ([notebook 01](https://www.inkandswitch.com/keyhive/notebook/01/)).
- **Autobase has one base key.** Per-scope readability needs app-layer payload encryption, and views must hold ciphertext (or there must be per-scope bases). Otherwise anyone with the base key reads the view.
- **Field-level tiers cannot be replication-gated.** A `.table` row mixes tiers in one log. Decide 4's "never receives the ciphertext" can hold for folder and file scopes, not for fields.

## 7. Ink & Switch

### 7.1 Keyhive
- **Principals.** **[R]**
  - Individuals are immutable Ed25519 keys.
  - Groups contain individuals or groups. People are modelled as groups of their devices.
  - Documents are groups too, so a "folder" is a document that has other documents as members ([notebook 05](https://www.inkandswitch.com/keyhive/notebook/05/), [group_membership.md](https://github.com/inkandswitch/keyhive/blob/main/design/group_membership.md)).
- **Access ladder.** **[R]** `Relay < Read < Edit < Admin`:
  - `Relay` can fetch bytes but not decrypt.
  - `Admin` can "revoke any members … not just those that they have causal seniority over" ([access.rs](https://github.com/inkandswitch/keyhive/blob/main/keyhive_core/src/access.rs)).
  - Notebook 01 calls the lowest level "pull" and explains it as defence in depth.
- **Convergent capabilities.** **[R]**
  - A CRDT of delegations and revocations, sitting "between" object capabilities and certificate capabilities.
  - Expressing their revocation semantics as certificate capabilities would need "significantly (often exponential) more certificates".
  - Operations from later-revoked authors stay in the history but pass through a visibility index, "because revocation cascades can revoke the revoker" ([design README](https://github.com/inkandswitch/keyhive/blob/main/design/README.md)).
  - Auth ops record `doc_heads`, which locks them after content. Re-adds must causally follow the revocation. Restricting sub-delegation "MUST NOT be permitted" ([group_membership.md](https://github.com/inkandswitch/keyhive/blob/main/design/group_membership.md)).
  - They avoid consensus, to keep Automerge's consistency level ([notebook 01](https://www.inkandswitch.com/keyhive/notebook/01/)).
- **Public.** **[R]** A well-known `Public` agent has all-zero Ed25519 and X25519 keys. Adding it as a member "is equivalent to setting a document to 'public' by using a pre-leaked key … made temporarily public and later revoked" ([public.rs](https://github.com/inkandswitch/keyhive/blob/main/keyhive_core/src/principal/public.rs)). Tests allow adding Public at Read, Edit or Admin, and `best_access_for_doc` then yields at least that level for anyone ([tests/public.rs](https://github.com/inkandswitch/keyhive/blob/main/keyhive_core/tests/public.rs)).
- **Read access and encryption keys.** **[R]**
  - The capability graph decides who is in the key agreement group.
  - Each encrypted chunk contains its causal predecessors' keys (Cryptree-like). This gives up forward secrecy but keeps post-compromise security.
  - Ranges of changes are compressed, then encrypted ([notebook 01](https://www.inkandswitch.com/keyhive/notebook/01/), [causal_encryption.md](https://github.com/inkandswitch/keyhive/blob/main/design/causal_encryption.md)).
- **Relation to UCAN.** **[R]** UCAN and WNFS are listed as inspirations ([notebook 00](https://www.inkandswitch.com/keyhive/notebook/00/)). Certificate capabilities are partition-tolerant but stateless, and revocation needs state anyway ([01](https://www.inkandswitch.com/keyhive/notebook/01/)). **[I]** I saw no UCAN token format in `keyhive_core`.
- **Code and maturity.** **[R]**
  - Rust, Apache-2.0: `keyhive_core`, `keyhive_crypto`, `beekem`, `keyhive_wasm`.
  - "DO NOT use this release in production", not audited.
  - Commits as recent as 2026-09-11. `keyhive-wasm` 0.1.0-alpha.8 (2026-08-18).
  - `design/threat_model.md` is empty and `convergent_capabilities.md` is mostly a stub ([repo](https://github.com/inkandswitch/keyhive)).
  - The project page lists 2024–2026 ([project](https://www.inkandswitch.com/project/keyhive/)).

### 7.2 BeeKEM
- **Structure.** **[R]**
  - A TreeKEM-style tree. Leaves hold members' Diffie-Hellman public keys.
  - Remove and Add blank the path to the root. The next Update restores the root secret.
  - A removed member's concurrent update does not survive.
  - Concurrent updates keep "conflict keys" at a node until a later update resolves them.
  - Cost: O(log n) usually, linear worst case, n log n space worst case.
  - Uses X25519 and BLAKE3 only ([notebook 02](https://www.inkandswitch.com/keyhive/notebook/02/)).
- **Compared with MLS.** **[R]**
  - TreeKEM needs a central server to order operations and pick winners.
  - DCGKA is linear (about 100 members).
  - Causal TreeKEM needs commutative cryptography such as BLS ([02](https://www.inkandswitch.com/keyhive/notebook/02/)).
  - RFC 9420 itself: "Applications MUST have an established way to resolve conflicting Commit messages for the same epoch" ([RFC 9420 §14](https://www.rfc-editor.org/rfc/rfc9420#section-14)).
- **Formal security.** **[R]** Security is formalised as "cross-fork security" with parameter κ. The implementation sets κ=∞, so there is no standard forward secrecy ([notebook 06](https://www.inkandswitch.com/keyhive/notebook/06/)).
- **Relevance.** **[I]** BeeKEM rotates a group secret on removal without a sequencer, in O(log n). Our MLS upgrade path ("everything else stays the same") would need Autobase's `signedLength` to act as MLS's commit sequencer, or would need BeeKEM.

### 7.3 Beelay → Subduction
- **Beelay.** **[R]**
  - Messages are signed, with an audience (a public key or the hash of a URL) and a timestamp.
  - Sync order: membership graph (RIBLT set reconciliation), then documents as `(docID, hash(heads, cgka ops))`, then key agreement ops and sedimentree chunks.
  - What a relay sees: membership ops, document IDs, and Automerge commit-graph heads ("kept … outside of the encryption envelope"), plus chunk sizes ([notebook 05](https://www.inkandswitch.com/keyhive/notebook/05/)).
- **Subduction.** **[R]**
  - Beelay was removed from the Keyhive workspace on 2025-10-08.
  - [Subduction](https://github.com/inkandswitch/subduction) (active, "DO NOT use for production") has `subduction_keyhive_policy` and `StoragePolicy::filter_authorized_fetch`.
  - On revocation "the server simply stops forwarding" ([subscriptions.md](https://github.com/inkandswitch/subduction/blob/main/design/sync/subscriptions.md)).
  - Its threat model accepts size and timing inference ([threats.md T8](https://github.com/inkandswitch/subduction/blob/main/design/security/threats.md)).
  - **[I]** It appears to succeed Beelay, but I found no sentence saying so.

### 7.4 Automerge and essays
- **[R]** By default, "you can write into any Automerge document that you know the document ID for" ([notebook 00](https://www.inkandswitch.com/keyhive/notebook/00/)).
- **[R]** `@automerge/automerge-repo-keyhive` is alpha. It gives documents relay/read/edit/admin member lists, and servers relay ciphertext ([repo](https://github.com/automerge/automerge-repo-keyhive)).
- **[R]** The local-first essay: a user with a copy "cannot be prevented from locally modifying it … what does it mean to 'stop sharing'?" ([essay](https://www.inkandswitch.com/essay/local-first/)).
- **[R]** Upwelling argues for private drafts that are shared deliberately ([Upwelling](https://www.inkandswitch.com/upwelling/)). **[I]** This bears on "confirm before publishing".

---

## Recommendations for Workspace (relative to the existing design)

**Adopt**
1. **Add `relay` below read/edit/admin** (Keyhive). Lighthouses and blind peers get `relay`: the gate lets them replicate, but they never appear in key deliveries. This makes the Lighthouse doc's "holds bytes, not access" a real grant.
2. **Model "anyone" as a well-known principal, allowed for `document/read` only.** Use a published `did:key`, following Keyhive's `Public`, rather than inventing a UCAN wildcard audience that the spec rejects (#143). Forbid edit and admin for it, because signatures from a public key identify nobody. Admin control over publishing then becomes "who may delegate to Public".
3. **Cryptree key records** (WNFS §3.1.7). A folder's key record carries its children's keys, so one delivery on the existing key-delivery log grants a subtree. This avoids O(scopes × members) envelopes.
4. **Stable scope IDs, not path strings** (WNFS i-numbers). When an item moves, re-key it and let it inherit the destination's grants, as rs-wnfs `prepare_key_rotation` does.
5. **Publish a snapshot, not the live scope** (WNFS snapshot vs temporal keys). A publish creates a fresh public scope, so private history and later private edits stay private.
6. **Authorisation readable without decryption** (WNFS §4, Keyhive relays). Keep an opaque scope ID, author and proof in the clear on every Autobase entry, so `apply` and indexers never need the scope key to validate edits.
7. **Per-core, per-connection fetch policy** (Subduction `filter_authorized_fetch`) instead of Corestore's all-to-all attach. This is #47.
8. **Revocations inside the replicated resource.** The revocation block is already planned; align its fields with `/ucan/revoke` (the revoked CID plus a path witness), and wire ucanto's `validateAuthorization` for `isRevoked` (#433).

**Adapt**
1. **Causal epoch keys instead of the skip ratchet.** New members need the full log to replay Autobase, so each epoch's key record should include the previous epoch key (Keyhive). Tag blocks with `hypercore-encryption` key ids.
2. **Design capabilities in UCAN 1.0 shape now** (`sub` = workspace root DID, `cmd` = `/document/{read,edit,publish}`, `pol` over `{scope, ancestors}`), but encode them in ucanto behind the existing boundary module. UCAN 1.0 is final. Revocation is still rc.1, and iso-ucan still lacks revocation, so ucanto remains the pragmatic choice.
3. **Grant to people, not devices** (Powerline or Keyhive groups), so adding or removing a device does not require re-granting every scope. Keys are still sealed per device.
4. **Add a caveat to the MLS upgrade path.** RFC 9420 §14 needs a commit sequencer. Either use Autobase `signedLength` or track BeeKEM, which is pre-alpha and unaudited, so study it rather than depend on it.
5. **Coarse replication, fine keys.** Use separate cores/topics only where existence is sensitive, matching permissions-model's advice. Also reconcile PERMISSIONS.md ("replicates all blocks") with Decide 4 ("never receives the ciphertext"). The two statements conflict.
6. **Stop leaking the ACL through the key-delivery log.** Its plaintext `recipient` and `resource` fields reveal the grant list to every member. WNFS share labels have a similar leak. Consider sealing the resource and blinding the recipient.

**Avoid**
1. **RSA accumulators and name-accumulator write proofs.** They need a trusted setup and only pay off for an untrusted store that must not learn the hierarchy. Our validators are members or relays.
2. **The IPLD HAMT forest as storage.** It duplicates what Autobase does and fights append-only logs.
3. **"No access to the past" for op-log content.** It breaks replay.
4. **RSA-OAEP exchange keys.** They were a browser WebCrypto constraint; our X25519 sealing already works.
5. **Wall-clock UCAN expiry checks inside `apply`.**
6. **Treating publish control as leak control.** UCAN gives no confinement, and readers can always re-share keys. Keep that honest in the UI.

## Open questions
1. What is the replication unit? Which scopes get their own cores or Autobases, and can a connection that carries several workspaces (#47) be gated per core?
2. Can a revoked writer back-date Autobase nodes before its revocation, and does `signedLength` bound that?
3. Who are the indexers of a base with private scopes: admins only, or every editor?
4. After a publish, how do later edits reach the public copy: republish a new snapshot, or a live public scope?
5. Does a public scope's topic stay separate from the member topic, and how does the gate admit anonymous connections for those cores only?
6. How much does the rotation cascade cost at real folder depths and grant counts, compared with a group key agreement per scope?
7. How do folder scopes (per-core) and field tiers (per-key) compose in one `.table`?
8. Should Workspace ever allow Public at edit, as Keyhive does "with caution"?