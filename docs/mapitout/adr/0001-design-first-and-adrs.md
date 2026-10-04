# ADR 0001 - Design first; decisions recorded as ADRs
Status: accepted      Date: 2026-10-04

## Context
The owner works across devices and chats, and context gets lost (memory skewed between devices, an asset
register lost). Code written before the design is settled was the main source of rework. The owner's
analogy: building work starts after the design and calculations are done, and everything is measured for
reliability, security and maintainability before it is installed.

## Decision
For anything non-trivial: architecture, SDLC/DevOps, APIs, agent/skill workflows and documentation are
designed and written first, with the quality attributes (reliability, security, maintainability, performance)
stated and, where possible, measured. Each decision gets an ADR in `docs/mapitout/adr/`. Undecided points
are marked **OPEN** in the design doc; nobody invents an answer to close them.

## Alternatives
- Code first, document after: rejected, that is how the current memory problems arose.
- A wiki or chat history as the record: rejected, not versioned with the code and not readable by every actor.

## Consequences
- Slightly slower to the first line of code; far less rework and drift.
- Every actor (human, Claude, local models) reads the same short records.
- The ledger (ADR 0004) records *that* and *when* a decision was made; the ADR holds the reasoning.
