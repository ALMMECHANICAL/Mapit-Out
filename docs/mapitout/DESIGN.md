# Map It Out - AI backend design (v0.1)

## Purpose
Map It Out is the diagramming/mapping front end of an AI-assisted mapping and
estimating product. This repo is a fork of draw.io (Apache 2.0). We use it as a
tool: users describe or attach a diagram and a **local LLM** (LM Studio) creates
or updates it. Later: agents drive it (see Roadmap).

## Architecture
```
Browser (mapitout.html)
  mapitout/config.js  -> window.MAPITOUT_CONFIG
  js/PreConfig.js     -> DRAWIO_CONFIG = MAPITOUT_CONFIG   (draw.io's override hook)
  Editor.configure()  -> aiConfigs / aiModels / enableAi
  AI chat dialog  --POST /v1/chat/completions-->  LM Studio (localhost:1234)
```
- Request/response shape is OpenAI-compatible (draw.io's built-in `gpt` config slot,
  response path `$.choices[0].message.content`). `config.js` overrides: `gptUrl`,
  `gptApiKey` (placeholder), `aiModels`, `aiActions`, `enableAi` (true, since AI is
  otherwise only on draw.io's own domains) and `settingsName`.
- `createPublic` is removed from `aiActions`, and cloud models are removed from
  `aiModels`, so no prompt or diagram leaves the machine by default.
- Zero edits to draw.io core, except `js/PreConfig.js` (hands config over, warns if missing).
- Deploy overrides go in `mapitout/env.js` (committed empty; no secrets, it is public to visitors).
- **Model id must match LM Studio**: `local-model` is a placeholder; set the real id from `GET /v1/models` in `env.js` (console warning otherwise).

## Config (`window.MAPITOUT_LLM`, set in `mapitout/env.js`)
| key | default | note |
|---|---|---|
| baseUrl | `http://localhost:1234/v1` | LM Studio server |
| models | `[{name, model}]` | `model` = id from `GET {baseUrl}/models` |
| apiKey | `lm-studio` | placeholder; draw.io hides models with no key |

## Agent-agnostic principle (decided)
Map It Out is a tool any LLM or agent can use - LM Studio models, Claude, others -
not a feature tied to one provider. Two integration surfaces, one tool contract:
1. **Model backend** (built): `aiConfigs`/`aiModels` - the in-app chat calls any
   OpenAI-compatible endpoint. Add a model = add an entry.
2. **Agent tool surface** (design, not built): draw.io's embed message API
   (`EditorUi.js` handles `load`, `merge`, `export`, `layout`, `template`, `dialog`,
   `status` actions via postMessage) lets an agent read/write the live canvas
   in the app, no model API needed. Plan: one thin tool contract
   (`get_diagram`, `apply_xml`/`merge`, `layout`, `export`) exposed as
   (a) window postMessage, (b) an MCP server bridge for Claude Code and others.
   Product-side API comes later and wraps the same contract.

## Related work: diagram-design (cathrynlavery/diagram-design, MIT)
Skill/plugin that generates presentation-grade static HTML/SVG diagrams (47 types)
and redraws draw.io/Mermaid/Excalidraw files. Decision: **do not vendor into this
fork**. It outputs read-only artifacts, not editable draw.io XML, and is large
(screenshots, icon vendor dir, ~40 verify scripts). Use it as a separate installed
skill for agents; revisit a thin "export to editorial" action later. MIT permits
reuse with the copyright notice kept.

## Product context and direction (from owner, 2026-10-04)
Captured as stated; items marked **OPEN** are not decided.

**Positioning.** Today Map It Out is a **developer tool**: flow diagrams, architecture
maps, design-first documentation for building the wider product set. It is intended to
grow a separate **design/estimating feature** that comes from the *Map It Quick Quote*
idea. Whether that becomes its own product later is **OPEN**; for now it is one
codebase/business structure (an add-on), kept easy to split.

**Map It Quick Quote (feature concept, not built).**
- Voice-first: the user talks through a job; the system drafts a quick diagram plus quote.
- Photos and measurements the user adds feed the drawing and the estimate.
- Output is shown to the user first, then passed to their client (manual send, or
  automatic send as an option - **OPEN**).
- Early target trade: electrical design (circuits, sockets, rooms/floorplan layouts).
  draw.io room/floorplan shapes and socket symbols cover the drawing side.
- **OPEN**: voice stack (local STT vs hosted), pricing/rates source, where quotes are
  stored and sent from, measurement units/accuracy rules, client-facing format.

**Multi-model, shared-context orchestration (design intent).**
- Local models (LM Studio) and frontier models (Claude, Gemini, others) all work against
  the same tool contract (see Agent-agnostic principle) and the same project record.
- An orchestrator agent (Claude is the intended one, **OPEN**) delegates to local
  models/agents. Frontier models run on separate, scoped tasks, not mixed into one thread.
- Every participant must see what the others did: a shared **activity/context ledger**
  (who, which model, which task, inputs, outputs, diagram version) that any agent can
  read before acting. This includes work done in LM Studio, so LM Studio sessions need
  to write to (or be readable by) the ledger. Mechanism **OPEN** (file/db in repo,
  MCP server, or LM Studio's API/logs).
- **Headless-first**: the tool contract works with no UI; UIs sit on top. Candidate
  front ends: this editor, Open WebUI (**OPEN**). Gemini is a candidate for Google
  Workspace tasks only. Using fewer frontier models is fine; add one only when a
  use case justifies it.

**Design-first rule (owner).** Architecture, SDLC/DevOps, APIs, agent/skill workflows and
documentation are designed and written before code, with reliability, security and
maintainability measured up front. New features land as design docs/ADRs first.

## Constraints / risks
- **CORS**: LM Studio server must have CORS enabled when the page is served from
  another origin. **Mixed content**: an https-hosted page cannot call http://localhost
  in some browsers - serve over http locally or put a TLS reverse proxy in front.
- **Saved-config isolation**: `settingsName: 'mapitout'` moves browser-saved config/settings to `.mapitout-*` keys, so a stock draw.io `.configuration` on the same origin cannot restore a cloud AI endpoint/key/model. Verified with a hostile saved config.
- **Key handling**: the key slot is shared with draw.io's `gpt` config, so a real
  OpenAI key set via `gptApiKey` would be sent to the LM Studio URL. Keep it a placeholder.
- **Trademark**: README forbids using/modifying the draw.io name or logo for our
  product. `mapitout.html` and `mapitout/logo.svg` replace branding on the entry
  page only. **Known gap**: the in-app logo (`images/drawlogo*`, `EditorUi.js`,
  `HomeDialog.js`) and window title suffix "draw.io app" are not yet rebranded.
  Required before any public release.
- Logo is a placeholder; replace `mapitout/logo.svg` with the real mark.

## Roadmap (not built)
1. Full rebrand pass (logo, titles, about/help links, manifest, favicon).
2. Estimating layer: quantity/cost attributes on shapes, export to estimate sheet.
3. Agents/skills calling the same LM Studio endpoint (or an agent gateway) headlessly.
4. Tests: config-contract test (Playwright) in CI.

## Run locally
```
cd src/main/webapp && python3 -m http.server 8080
# open http://localhost:8080/mapitout.html ; start LM Studio server (port 1234)
```
