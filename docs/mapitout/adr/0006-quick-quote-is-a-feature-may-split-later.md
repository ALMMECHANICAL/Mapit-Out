# ADR 0006 - Map It Quick Quote is a feature in this codebase and may split later
Status: proposed      Date: 2026-10-04

## Context
The owner wants a voice-first flow: describe a job, add photos and measurements, get a quick diagram and quote,
review it, then send it to the client (manually or automatically). Electrical design comes first. Map It Out is a
developer tool today. One business structure is simpler while models and tools are shared.

## Decision
Treat Quick Quote as a feature that shares this codebase and tool contract. Keep it separable (its own folder,
its own events, no dependency from core code on it) so it can become its own product later. Nothing is built.

## Alternatives
- Separate product and repo now: deferred, not enough settled to justify two codebases.

## Consequences
- OPEN: voice stack (local vs hosted speech-to-text), pricing/rates source, where quotes are stored and sent from, measurement rules, client-facing format, automatic sending.
- Customer data and quotes must never enter the ledger. If a Quick Quote audit trail is needed, use the event model with a stricter, PII-free, server-side store (ledger design section 9).
