# ADR 0002 - Configure draw.io through `DRAWIO_CONFIG`; do not patch its core
Status: accepted      Date: 2026-10-04

## Context
This repo is a fork of draw.io (Apache 2.0). draw.io's own README says it does not take pull requests and
its AI layer is already configuration-driven (`aiConfigs`, `aiModels`, `aiActions`, `gptUrl`, `gptApiKey`).
Patching core files makes every upstream merge harder.

## Decision
Our behaviour lives in `src/main/webapp/mapitout/` and `mapitout.html`, applied through `DRAWIO_CONFIG`.
Upstream edits are limited to `js/PreConfig.js` (re-applies the config and warns if missing). `config.js` also
sets `DRAWIO_CONFIG` itself because draw.io's loader skips `PreConfig.js` on `*.draw.io` / `*.diagrams.net`.
Saved settings use their own namespace (`settingsName: 'mapitout'`) so a stock draw.io config on the same origin
cannot restore a cloud AI endpoint.

## Alternatives
- Patch `Editor.js` / `Dialogs.js`: rejected, merge pain and no benefit for what we need.
- Build a separate editor: rejected, we would lose draw.io's diagramming engine.

## Consequences
- Upstream updates stay easy to merge.
- Anything not exposed through config (window title, in-app logo) needs a deliberate, documented exception. Known gap, tracked in the design doc, required before any public release (draw.io trademark terms).
- Browser-delivered config is public: no real or shared API keys in it, ever.
