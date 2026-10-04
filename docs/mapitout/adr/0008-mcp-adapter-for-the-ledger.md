# ADR 0008 - MCP adapter for the ledger: zero-dependency stdio server, identity from the environment
Status: accepted (built)      Date: 2026-10-04

## Context
ADR 0003 wants one tool contract for every model; ADR 0004 left open how LM Studio and other clients write to the
ledger. MCP is the common client protocol (Claude Code, Claude Desktop, LM Studio versions that support MCP, others).
The ledger library is already the single write path (validate, secret scan, lock, chain).

## Decision
Add `tools/ledger/mcp.mjs`: a stdio MCP server (newline-delimited JSON-RPC 2.0, hand-written, **no dependencies**)
exposing five tools that wrap the library: `ledger_context`, `ledger_tasks`, `ledger_tail`, `ledger_append`,
`ledger_verify`. Design: `docs/mapitout/ledger/MCP.md`.

Rules:
1. **Identity comes from the server's environment** (`LEDGER_ACTOR`, `LEDGER_KIND`, `LEDGER_MODEL`, `LEDGER_HOST`,
   `LEDGER_SESSION`), never from tool arguments, so a model cannot write as someone else. If `LEDGER_ACTOR` is unset,
   the actor name is the MCP client's `clientInfo.name`.
2. The adapter adds no new write path: every append goes through `append()`, so validation, the secret scanner, locks
   and task rules apply unchanged.
3. Tool output that contains ledger text is **untrusted data**; tool descriptions and the digest header say so.
4. Errors are tool results with `isError: true` (the model can read and retry), protocol errors are JSON-RPC errors.
5. stdout carries only protocol messages; diagnostics go to stderr.

## Alternatives
- Official MCP SDK: rejected for now, adds a dependency and a supply-chain surface for a protocol subset of about 150 lines; revisit if we need more of the spec (resources, prompts, HTTP transport).
- HTTP/SSE server: rejected, needs a port, auth and CORS before there is a need; stdio is what local clients spawn.
- Let the model pass its own actor name: rejected, allows impersonation and corrupts task ownership.
- Logging proxy in front of LM Studio instead: not an alternative but the complement (design section 6, option B); it records activity, MCP lets the model record intent. Deferred by the owner until the product is further developed.

## Consequences
- Any MCP client can read the digest and write events; local models get the same contract as frontier models.
- A weak local model may call tools badly: validation errors are returned verbatim so it can correct itself. Tool-calling quality in LM Studio models varies, to be tested by the owner (OPEN).
- Supports the protocol revisions 2025-06-18, 2025-03-26, 2024-11-05 by version echo; it implements tools only. Resources/prompts are not offered.
- Not yet verified against a real LM Studio build (not available in the build sandbox): verified with a protocol-level test client only.
