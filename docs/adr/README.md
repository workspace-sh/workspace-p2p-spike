# Architecture Decision Records

Short, dated records of decisions with long shadows — the ones a future
contributor (or a future us) would otherwise reverse-engineer from the
code and get wrong. Each ADR states the decision, what was considered,
the consequences, and explicit triggers for revisiting.

Format is lightweight on purpose (loosely [MADR](https://adr.github.io/madr/)).
One page each. The deeper background usually lives in a `docs/` doc; the
ADR is just the decision.

| ADR | Decision | Status |
|---|---|---|
| [0001](./0001-ucan-library.md) | UCAN library: ucanto (not iso-ucan) | Accepted |
| [0002](./0002-autobase-merge-strategy.md) | Multi-writer merge: per-format LWW over Autobase | Accepted (design) |
