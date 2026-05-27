# Discovery

You've heard about a workspace your team uses. You know your company's
domain — `acme.com`. You'd like to open the workspace by typing the
domain in the Workspace app, the way you might open a link.

This document describes how that works. The Workspace app supports two
ways for organisations to publish a workspace against their own domain,
so anyone with the Workspace app can find a workspace just by knowing
the domain. Both are entirely optional. Workspaces work fine without
either — you can always share a workspace by handing someone a URL
or a `.workspace` folder directly. Discovery is a convenience for
organisations that already have a domain and want low-friction
first-contact for their team.

To be clear about scope: discovery is about *finding* a workspace,
not *getting in*. Once an app has found the workspace, whether you
can read what's inside is decided by the permission model, which
operates entirely separately. See
[`permissions-model.md`](./permissions-model.md) for that side of
the story.

**Status:** design — implementation pending. Tracked in
[issue #25](https://github.com/workspace-sh/workspace-p2p-spike/issues/25).

---

## Why bother

By default, joining a workspace requires someone to share the URI or
the `.workspace` folder. That works fine for small groups — a Slack
message with a link, an AirDrop in the office — but gets awkward at
organisational scale. A new employee shouldn't need to chase an admin
for a link before they can find the company's workspace.

Discovery closes that gap: if an organisation publishes a small DNS
record (or a JSON document at a well-known URL on their website),
anyone with the Workspace app can find the workspace by typing
`acme.com` — the same way you'd type a URL into a browser. The app
resolves the domain to the workspace's canonical URI and proceeds with
the normal join flow.

---

## Two methods, evaluated in order

### 1. DNS TXT record (preferred)

A TXT record on the org's domain pointing to the workspace's URI:

```
_workspace.acme.com.  3600  IN  TXT  "v=1; uri=workspace://v1/z6MkpKpf2nFiC5h9qDPgJrkBbYBaThkAEcVCgGuBHkXqK4Vc"
```

**Record details:**

- **Name:** `_workspace.<domain>` — the `_workspace` subdomain is
  reserved for this purpose. Underscore prefix matches the convention
  of similar protocol-discovery records (`_dmarc`, `_acme-challenge`,
  `_smtp.tls`, etc.); prevents collision with subdomain hosts.
- **Type:** TXT. Carries arbitrary text.
- **Format:** semi-structured `key=value; key=value; …` per RFC 6376
  ("DKIM-Signature" style), familiar from DKIM/SPF/DMARC.

**Required fields:**

| Field | Meaning |
|---|---|
| `v=1` | Discovery record version; lets us evolve the format without breaking older parsers |
| `uri=<workspace://…>` | Canonical workspace URI; the destination |

**Optional fields:**

| Field | Meaning |
|---|---|
| `name=<friendly>` | Human-readable name for the workspace, shown in UI lists |
| `relay=<host>` | Recommended relay for cold-start bootstrap; matches the URI's `relays=` query parameter convention |
| `priority=<n>` | When multiple workspaces are advertised under one domain, controls display order (lower = higher priority) |

**Multiple workspaces under one domain** — common for orgs with several
workspaces (e.g. "Main", "Engineering", "HR"). Two ways to express
this:

Multiple TXT records under the same name:

```
_workspace.acme.com.  3600  IN  TXT  "v=1; name=Main; uri=workspace://v1/zMain…"
_workspace.acme.com.  3600  IN  TXT  "v=1; name=Engineering; uri=workspace://v1/zEng…"
_workspace.acme.com.  3600  IN  TXT  "v=1; name=HR; priority=10; uri=workspace://v1/zHR…"
```

Or via subdomain (cleaner when teams have their own:

```
_workspace.eng.acme.com.  3600  IN  TXT  "v=1; name=Engineering; uri=workspace://v1/zEng…"
_workspace.hr.acme.com.   3600  IN  TXT  "v=1; name=HR;          uri=workspace://v1/zHR…"
```

App resolves `acme.com` → finds multiple records → presents a chooser.
Resolves `eng.acme.com` → finds the engineering workspace directly.

---

### 2. `.well-known/workspace` (HTTP fallback)

For orgs that already have a web presence and prefer HTTP-based
discovery. Lives at the standard `.well-known/` location per RFC 8615:

```
GET https://acme.com/.well-known/workspace
Content-Type: application/json
```

Response body:

```json
{
  "version": 1,
  "workspaces": [
    {
      "name": "Main",
      "uri": "workspace://v1/zMain…"
    },
    {
      "name": "Engineering",
      "uri": "workspace://v1/zEng…",
      "relay": "relay.acme.com",
      "priority": 1
    },
    {
      "name": "HR",
      "uri": "workspace://v1/zHR…",
      "priority": 10
    }
  ]
}
```

**Required fields per workspace:**

| Field | Meaning |
|---|---|
| `uri` | Canonical workspace URI |

**Optional fields:**

| Field | Meaning |
|---|---|
| `name` | Friendly name |
| `relay` | Recommended relay for cold-start |
| `priority` | Display order (lower = higher) |
| `description` | One-line description (not in DNS due to length; allowed here) |

The HTTP path carries more metadata than DNS comfortably can, useful
for orgs with many workspaces or wanting richer presentation.

---

## Resolution order — app side

When a user types a domain in the "join workspace" UI:

1. **DNS TXT lookup** on `_workspace.<domain>` — fast, no HTTP setup
   needed on the org's side, works behind firewalls that block HTTP
2. **HTTPS fetch** of `https://<domain>/.well-known/workspace` — falls
   back if no DNS record is found
3. **Manual entry** — if neither resolves, the user enters the URI or
   loads a `.workspace` folder manually

Resolution stops at the first method that returns workspaces.

App caches successful resolutions for the TTL of the underlying record
(DNS TTL or HTTP `Cache-Control`). User can refresh if needed.

---

## What discovery is NOT

- **Not authentication.** The URI a discovery record produces is the
  workspace's canonical identifier. Joining still requires the usual
  invite/envelope flow; discovery just gets you to the bootstrap step.
  See [`permissions-model.md`](./permissions-model.md).
- **Not part of the workspace's identity.** A workspace's identity is
  its root pubkey, fixed at creation. The DNS record is a *pointer* to
  that identity. Changing the DNS record changes only how the workspace
  is discovered, not what it is.
- **Not required.** Workspaces work fine without DNS or `.well-known`
  records. Discovery is purely an entry-point convenience.

---

## Security considerations

### DNS hijacking and trust

DNS responses can be spoofed by an on-path attacker, compromised
recursive resolvers, or hijacked authoritative servers. An attacker
who modifies the TXT record could point users at a *fake* workspace
(a workspace they control, masquerading as the legitimate one).

Mitigations stacked:

- **The workspace's root attestation is the ground truth.** Even if a
  malicious actor points users at a fake URI, the fake workspace's
  pubkey is different from the legitimate one. The user's app shows
  the workspace's pubkey before joining; a user comparing against a
  known-good pubkey (out-of-band fingerprint) catches the swap.
- **DNSSEC** signs DNS records; recommended for orgs that care.
  Significantly raises the bar for spoofing.
- **DNS-over-HTTPS / DNS-over-TLS** protects the recursive-resolver
  hop; protects against on-path attackers between user and resolver.
- **The `.well-known` path requires HTTPS** by spec, so TLS protects
  the HTTP fallback. Domain ownership is verified via the TLS
  certificate.

The attack surface here is the same as any DNS-based discovery —
DKIM, SPF, ACME, DMARC, MTA-STS all share it. Workspace's mitigations
mirror what those protocols recommend.

### Spoofing a legitimate org's workspace

A bad actor cannot make a fake workspace appear under `acme.com`
without controlling `acme.com`'s DNS — but they can advertise a
workspace from a domain they DO control (`a-cme.com`,
`acme-org.com`, etc.) and rely on user confusion.

This is the same risk every domain-based system has (phishing
domains, look-alikes). Not unique to Workspace; standard mitigations
apply (user vigilance, brand recognition, certificate transparency
logs).

For high-stakes workspaces, the canonical advice is: don't rely on
domain-based discovery alone for the first contact; verify the
workspace's pubkey out-of-band with someone you trust.

### Discovery records leak workspace existence

A public DNS TXT record at `_workspace.acme.com` reveals that Acme has
a Workspace deployment. For most orgs, that's fine — it's a marketing
signal as much as a technical one. For orgs that want to keep the
existence of their workspaces private, don't publish discovery records;
fall back to manual URI sharing.

`.well-known` has the same property — public HTTPS endpoint, publicly
visible.

---

## Implementation status

Currently designed, not implemented. Tracked in the GitHub issues for
the spike repo.

The implementation work is small:

- App-side: DNS TXT resolver + HTTPS fallback (~few hundred lines, no
  new dependencies beyond standard DNS/HTTP libraries)
- Server-side: orgs add their own DNS records and/or
  `.well-known/workspace` JSON. No software runs on the server side
  beyond what they already have.

---

## Cross-references

- [`uri-scheme.md`](./uri-scheme.md) — the `workspace://` URI scheme
  that discovery resolves to
- [`workspace-format.md`](./workspace-format.md) — the on-disk
  workspace format that holds the workspace this URI identifies
- [`permissions-model.md`](./permissions-model.md) — the access-
  control layer that takes over once the user has the URI
- [`threat-model.md`](./threat-model.md) — what Workspace's security
  guarantees do and don't cover, including the "fraudulent identity
  claim" risk relevant to DNS spoofing
- [`lighthouse.md`](./lighthouse.md) — what an org's recommended
  cold-start peer actually is once discovery resolves
