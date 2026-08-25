# Many workspaces, one runtime

How a device holds more than one workspace open, and why that costs almost
nothing.

This is implementation detail that turned out to be design: the cost model
below is what decides whether workspaces can be live by default, and it is not
obvious from the outside.

## The shape

One device runs **one runtime**: one Corestore, one Hyperswarm, one identity.
Every workspace it has open lives inside that runtime.

```
device
└── runtime                       one corestore, one swarm, one peer identity
    ├── workspace A               data log, key-delivery log, blob log
    ├── workspace B               data log, key-delivery log, blob log
    └── workspace C               …
```

A workspace is **not** a process, a connection, or a swarm. It is a set of
logs, a topic, and a manifest. That is what makes holding several of them
cheap.

## The cost model

This is the part worth internalising, because it inverts the intuition that
more workspaces means more connections.

| resource | scales with |
|---|---|
| Corestore | **one per device** |
| Swarm | **one per device** |
| Peer identity | **one per device** |
| DHT topic announcement | one per workspace |
| **Connection** | **one per PEER** — not per workspace |
| Logs | three per workspace (data, key delivery, blobs) |

The connection row is the important one. `store.replicate(connection)`
multiplexes **every core the store holds** over a single stream. So if you and
another person share ten workspaces, you have **one** connection carrying ten
workspaces' worth of cores — not ten connections.

Adding a workspace therefore costs a topic announcement and some logs. It does
not cost a connection, a process, or a peer identity.

## What this means

- **Live by default is affordable.** Keeping every known workspace open is
  proportional to the number of *people* you collaborate with, not the number
  of workspaces you have.
- **Opening a workspace is a local operation.** Its logs open from the local
  store immediately; the topic announcement happens in the background and may
  never land on a restricted network. See
  [network-conditions.md](./network-conditions.md) — the announce has been
  measured at 40 seconds where opening the store takes 73 ms.
- **A workspace closing is not a process ending.** The runtime outlives any
  individual workspace and is torn down with the app.

## Consequences for an implementation

Three rules follow, each of which was learned by getting it wrong first.

**The runtime is shared, so nothing that belongs to one workspace may be scoped
to it.** Request ids on a shared IPC channel are the sharp case: numbering them
per workspace is correct until two workspaces share a channel, at which point
each resolves on the other's replies — silently, with the wrong data. Ids must
be unique across the runtime, not within a workspace.

**A workspace's own state stays with the workspace.** Its folded documents, its
watcher, its reconcile latch. A single "active workspace" holding any of these
means opening a second one evicts the first — a constraint invented by the
implementation, not by the format.

**Which workspace owns a path is decided by the deepest containing folder.** A
workspace nested inside another owns its own documents; the enclosing folder
does not claim them. Containment compares against the folder plus a path
separator, or `/a/Docs` contains `/a/Docs-old/note.md` and a file in an
unrelated folder is claimed by a workspace that never held it.

## What is deliberately not decided here

- **Whether known workspaces open automatically.** Affordable is not the same
  as wanted: opening announces on the DHT, which is a choice about visibility
  and about someone's data allowance, not only about cost.
- **Per-workspace network policy.** Whether an individual workspace can be held
  local-only while others sync. The cost model permits it; nothing specifies
  it yet.

Refs: workspace#314, workspace#332, workspace#333
