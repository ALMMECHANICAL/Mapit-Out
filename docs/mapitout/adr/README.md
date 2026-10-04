# Architecture Decision Records - Map It Out

Decisions are written **before** the code that depends on them. One file per decision, numbered, never
deleted: a changed decision gets a new ADR that supersedes the old one.

| # | Decision | Status |
|---|---|---|
| [0001](0001-design-first-and-adrs.md) | Design first; decisions recorded as ADRs | accepted |
| [0002](0002-configure-drawio-do-not-patch.md) | Configure draw.io through `DRAWIO_CONFIG`; do not patch its core | accepted |
| [0003](0003-model-and-agent-agnostic-tool-contract.md) | Model- and agent-agnostic tool contract | accepted (backend built, tool surface designed) |
| [0004](0004-shared-activity-ledger-jsonl-sharded-by-writer.md) | Shared activity ledger: append-only JSONL, one file per writer, in git | accepted (core built) |
| [0005](0005-diagram-design-stays-a-separate-skill.md) | `diagram-design` stays a separate skill, not vendored | accepted |
| [0006](0006-quick-quote-is-a-feature-may-split-later.md) | Map It Quick Quote is a feature in this codebase and may split later | proposed |
| [0007](0007-session-memory-in-a-separate-private-repo.md) | Cross-device session memory lives in a separate private repo of per-session notes | accepted (phase 1 built) |
| [0008](0008-mcp-adapter-for-the-ledger.md) | MCP adapter for the ledger: zero-dependency stdio server, identity from the environment | accepted (built) |

## Template

```
# ADR NNNN - Title
Status: proposed | accepted | superseded by NNNN      Date: YYYY-MM-DD
## Context        what forces the decision
## Decision       what we chose, in one or two sentences
## Alternatives   what else was considered and why not
## Consequences   what gets easier, what gets harder, what is now OPEN
```
