# ADR 0007 - Cross-device session memory lives in a separate private repo of per-session notes
Status: accepted (phase 1 built: manual workflow)      Date: 2026-10-04

## Context
Sessions run on several devices and three surfaces (terminal, desktop, cloud). Each has its own memory, so ideas and
context from off-the-cuff conversations are stranded and the memory drifts. The ledger (ADR 0004) records project
facts but is not meant for free-form thinking. Details: `docs/mapitout/memory/DESIGN.md`.

## Decision
Keep narrative memory in one **separate private repository** of Markdown files. Every session ends by writing one small
note into `inbox/` (one file per session, named with the date, time and a random suffix so two devices never write the same path) and pushing it; every session starts by pulling and
reading the newest notes. A curator pass, approved by the owner, folds inbox notes into `projects/` and `notes/`.
Facts stay in the ledger. A per-device read cursor (not a cookie store) limits what each session re-reads.

## Alternatives
- Rely on each tool's built-in memory: rejected, split per device and tool, not portable.
- Put it in the project repo: rejected, mixes private thinking with code that may be public.
- Browser cookies or local storage as the store: rejected, tiny, per-browser, unreadable by terminals and local models.
- A database or vector store now: deferred, plain files in git are enough and can be indexed later.
- One shared memory file the models rewrite: rejected, rewriting loses history.

## Consequences
- Private repo required; secrets never allowed; customer data excluded by default (OPEN).
- Cloud sessions need the repo attached and the GitHub app to have write access.
- Local models need an MCP tool or wrapper to write notes (OPEN).
- The owner chose to start with a manual workflow (paste a prompt at the end of a chat, copy the note, file it with `tools/memory/memnote.mjs`) and to create the private repo personally. Hooks, the read cursor and the curator are future work.
