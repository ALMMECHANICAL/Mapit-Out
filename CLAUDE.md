# CLAUDE.md - Map It Out

Fork of draw.io (Apache 2.0) rebranded as **Map It Out**: the diagram front end of
an AI mapping/estimating product, wired to local LLMs via LM Studio.

- Design first: see `docs/mapitout/DESIGN.md` before changing anything. Update it with the change.
- Our code lives in `src/main/webapp/mapitout/` and `src/main/webapp/mapitout.html`.
  Keep upstream draw.io edits minimal (currently `js/PreConfig.js` only).
- AI backend is configured only through `DRAWIO_CONFIG` (`gptUrl`/`gptApiKey` and `aiModels` in `mapitout/config.js`), never by patching `Editor.js`.
- Do not use draw.io name/logo in our branding (see README Trademark section).
- API keys are config-only, never URL params (see comment in `Editor.js`).
- `DRAWIO_CONFIG`/`mapitout/*.js` are served to every visitor: never put a real or shared API key there. Shared credentials go behind a server-side proxy; the committed default key is a non-secret placeholder.
- Verify: serve `src/main/webapp` statically, open `mapitout.html`, check `Editor.aiModels` in the console.
- Upstream docs for draw.io internals: `docs/claude/*.md`.

## Product context (see `docs/mapitout/DESIGN.md` for detail)
- Now: developer tool. Planned: Map It Quick Quote feature (voice + photos/measurements
  -> quick diagram + quote -> client), electrical first. May split into its own product later.
- Built: shared activity ledger (`tools/ledger/`, data in `ledger/`). Planned, NOT built: the agent tool surface/MCP adapter, session hooks, and any way for LM Studio to write to the ledger (OPEN). Local and frontier models are meant to share one tool contract; headless-first.
- **At session start run `node tools/ledger/cli.mjs context`; end with a `handoff` event.** Rules: `ledger/README.md`. Never put secrets or customer data in events.
- Decisions are ADRs in `docs/mapitout/adr/`; write the ADR before the code.
- Design before code. Mark undecided points OPEN in the design doc; don't invent answers.
