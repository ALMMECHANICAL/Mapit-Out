# ADR 0005 - `diagram-design` stays a separate skill, not vendored
Status: accepted      Date: 2026-10-04

## Context
`cathrynlavery/diagram-design` (MIT) generates presentation-grade, read-only HTML/SVG diagrams in 47 styles and
can redraw draw.io, Mermaid and Excalidraw files. It is large (screenshots, an icon vendor folder, about 40
verification scripts). Map It Out needs *editable* draw.io diagrams as its working canvas.

## Decision
Do not copy it into this repo. Agents install it as a separate skill when they need presentation output.
A thin "export to editorial diagram" action in the app may be revisited later.

## Alternatives
- Vendor it: rejected, it adds weight and a second source of truth for something we use occasionally. MIT would allow it with the notice kept.

## Consequences
Smaller repo, nothing to keep in sync. Output of that skill is not editable in draw.io.
