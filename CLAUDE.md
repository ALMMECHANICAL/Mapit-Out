# CLAUDE.md - Mapit-Out

Fork of draw.io (Apache 2.0) rebranded as **Map It Out**: the diagram front end of
an AI mapping/estimating product, wired to local LLMs via LM Studio.

- Design first: see `docs/mapitout/DESIGN.md` before changing anything. Update it with the change.
- Our code lives in `src/main/webapp/mapitout/` and `src/main/webapp/mapitout.html`.
  Keep upstream draw.io edits minimal (currently one line in `js/PreConfig.js`).
- AI backend is configured only through `DRAWIO_CONFIG` (`aiConfigs`/`aiModels`), never by patching `Editor.js`.
- Do not use draw.io name/logo in our branding (see README Trademark section).
- API keys are config-only, never URL params (see comment in `Editor.js`).
- Verify: serve `src/main/webapp` statically, open `mapitout.html`, check `Editor.aiModels` in the console.
- Upstream docs for draw.io internals: `docs/claude/*.md`.
