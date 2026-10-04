# ADR 0003 - Model- and agent-agnostic tool contract
Status: accepted (model backend built; agent tool surface designed, not built)      Date: 2026-10-04

## Context
Map It Out is used with local models (LM Studio), Claude and possibly other frontier models. It must not be
tied to one provider, and an agent should be able to work in the app itself, not only through a model API.

## Decision
Two integration surfaces behind one tool contract:
1. **Model backend (built):** the in-app chat calls any OpenAI-compatible endpoint. Adding a model is one config entry.
2. **Agent tool surface (designed):** draw.io's embed message API (`load`, `merge`, `export`, `layout`, `template`, `dialog`, `status`) lets an agent read and write the live canvas. A thin contract (`get_diagram`, `apply_xml`, `layout`, `export`) will be exposed as window messages and as an MCP server.
The product API, when it exists, wraps the same contract.

## Alternatives
- One provider's SDK: rejected, lock-in.
- Only an HTTP API: rejected, forces every agent through a server we do not need yet.

## Consequences
- Headless-first: UIs (this editor, Open WebUI) sit on top.
- Frontier models run on separate, scoped tasks and share state through the ledger (ADR 0004), not through one thread.
- OPEN: which agent orchestrates the local models; the exact tool signatures.
