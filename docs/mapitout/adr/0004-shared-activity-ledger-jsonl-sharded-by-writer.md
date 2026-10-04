# ADR 0004 - Shared activity ledger: append-only JSONL, one file per writer, in git
Status: accepted (core built)      Date: 2026-10-04

## Context
Several actors on several devices need to see what the others did. No server exists, work happens in cloud
sessions, terminals and local models, and the owner wants everything in repos. Details: `docs/mapitout/ledger/DESIGN.md`.

## Decision
Events are small JSON objects appended to JSONL files under `ledger/events/YYYY-MM/`, **one file per writer**
(`actor.host.session`), so devices never write the same file. Each file has a SHA-256 hash chain. Writes go
through a library that validates, scans for secrets, locks and appends. Task state and the context digest are
**derived** by replaying events. Zero dependencies (Node 18+). A JSON Schema is generated from the same constants.

## Alternatives
- SQLite file in git: rejected, binary merges conflict and diffs are unreadable.
- A hosted database or queue: rejected for now, adds a server, cost and an attack surface before the need is proven.
- One shared JSONL file: rejected, guaranteed merge conflicts across devices.
- Markdown journal: rejected, not machine-checkable and models would edit it freely.
- A single "memory file" the models rewrite: rejected, rewriting loses history and invites drift.

## Consequences
- Conflict-free sync via plain `git pull`/`push`; the history is auditable.
- Tamper-evident, not tamper-proof (a writer can rewrite their own shard); git history is the anchor.
- Reads are a full scan: measured fine at 20k events; snapshots needed past ~100k.
- Offline double-claims cannot be refused; they are flagged CONTESTED after sync.
- LM Studio cannot write by itself: an MCP adapter, a logging proxy or a wrapper is needed (OPEN, design section 6).
