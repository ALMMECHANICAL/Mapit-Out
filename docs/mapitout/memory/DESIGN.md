# Cross-device session memory - design (v0.1, proposed)

Status: **phase 1 built (manual workflow); hooks, curator and read cursor are designed only.** How to use it: [PROMPTS.md](PROMPTS.md). Code: `tools/memory/`. Decision record: [ADR 0007](../adr/0007-session-memory-in-a-separate-private-repo.md).
Related: [shared activity ledger](../ledger/DESIGN.md) (facts), this document (narrative).

## 1. Problem

The owner works from several machines (a main dev workstation, a personal Mac used mostly for media with a
separate dev account planned, a Windows laptop with a discrete GPU for local models, a NAS, and spare hardware)
and from three kinds of session: terminal, desktop app and cloud. Each session has its own memory. Off-the-cuff ideas,
decisions and context given in one session are invisible to the next, the memory drifts, and things get lost
(the asset register already was). The ledger fixes *facts about project work*; it is deliberately not a place for
free-form ideas, so something else must hold the narrative.

## 2. Goals and non-goals

| Goals | Non-goals (for now) |
|---|---|
| Every session ends by leaving a short note that any other session, on any device, can read | Replace each tool's own built-in memory; this store is the portable, tool-neutral one |
| Works for terminal, desktop and cloud sessions and for local models | A search engine or vector index (can be added later over the same files) |
| No write conflicts across devices; plain files in git | Real-time sync |
| Private by default; no secrets | Holding customer data (OPEN, see 8) |
| Cheap to read at session start | Automatic summarising with no human check |

## 3. Two layers

| Layer | Holds | Written by | Where |
|---|---|---|---|
| Ledger | Facts: tasks, claims, decisions, artifacts, hand-offs, as small structured events | tools and agents | per project repo, `ledger/` |
| Memory | Narrative: ideas, reasoning, open questions, device and asset registers, per-project "state of play" | agents at session end, a curator pass, the owner | one separate **private** repo |

Rule of thumb: if it is a fact someone might act on or query, it is a ledger event; if it is thinking, it is a memory note.
A note may reference ledger event ids and ADRs.

## 4. Repository layout (the private memory repo)

```
inbox/YYYY/MM/<date>-<HHMMSS>-<device>-<project>-<random>.md   raw end-of-session notes; one file per session (never edited; the time and random part keep independently synced clones from colliding)
projects/<project>/README.md                 current state per project: goal, status, next actions, links
notes/<topic>.md                             curated, de-duplicated knowledge
registers/                                   asset register and similar lists (rebuilt from events where possible)
devices/README.md                            device roles and capabilities (private)
index.md                                     generated table of contents
```

## 5. The session note

One Markdown file per session, small (target under about 2 KB):

```
---
date: 2026-10-04
device: <device role or name>
surface: terminal | desktop | cloud | local-model
actor: <tool or model name>
project: <project or "general">
---
## Decisions        (what was decided and why; link ADRs and ledger ids)
## Ideas            (unfiltered; mark half-formed ones)
## Open questions
## Next actions
## Links
```

## 6. Flow

1. **Session start:** pull the memory repo; read the newest inbox notes for the project, the project README and the ledger digest.
2. **Session end:** write the note, commit, push. If the push fails (offline, no permission), keep the file and say so; the next session retries first.
3. **Curator pass** (on demand or weekly, by an agent, approved by the owner): fold inbox notes into `projects/` and `notes/`, flag contradictions, link duplicates. Inbox notes are archived, never deleted.
4. **Backup:** mirror the repo to a second location the owner controls (for example the NAS).

How each surface does step 1 and 2:

| Surface | Mechanism | State |
|---|---|---|
| Claude Code terminal/desktop | SessionStart and Stop hooks (the Stop hook already exists to insist on pushing) | designed |
| Cloud session | The memory repo must be attached to the session at start (or added mid-session) and the GitHub app needs write access to it. This session could not push until that was fixed. | designed; known constraint |
| Local model (LM Studio) | Cannot push by itself: an MCP tool or wrapper writes the note | OPEN (same question as ledger design section 6) |
| Owner by hand | Paste a prompt at the end of any chat, copy the note, file it with `memnote save` (checks the note, rejects secrets, commits, pushes). `memnote latest` prints the newest notes to paste at the next session start. | **built** ([PROMPTS.md](PROMPTS.md)) |

### Phasing

| Phase | Scope | State |
|---|---|---|
| 1 | Note template, `memnote` (init, template, check, save, latest, index), prompts, tests, CI | **built** |
| 2 | Claude Code SessionStart and Stop hooks that pull and push notes; local-model MCP tool | designed |
| 3 | Read cursor; curator pass; secret scan as a pre-commit hook in the memory repo | designed |

## 7. The "cookie" idea, evaluated

Browser cookies are a poor *store*: about 4 KB, tied to one browser and site, sent with every request, easily
cleared, and unreadable from a terminal or by a local model.

The useful part of the idea is a **read cursor**: a tiny local token saying "this device has already read up to
event X and note Y", so a session loads only what is new instead of re-reading everything.

- Proposed form: `~/.config/mapitout/cursor.json` per device and project, `{ledgerEventId, lastNoteDate}`.
- Proposed use: `ledger context --since-cursor` and the same for notes. Not built.
- For the product web app (Quick Quote), an ordinary session cookie holding an opaque id is normal and fine, but the
  memory itself stays server-side.

## 8. Risks and open decisions

- **Privacy.** The repo must be private. It will hold unfiltered thinking and eventually business detail. Secrets never go in
  (reuse the ledger's secret scanner as a pre-commit check; not built).
- **Customer data.** Whether Quick Quote or client details may ever appear here is OPEN; default is no.
- **Drift and bloat.** Inbox grows forever; the curator pass and archiving keep reads cheap. A size budget for the session-start digest applies, as in the ledger.
- **Unreviewed summaries.** Agent-written notes can be wrong; the curator pass is approved by the owner before it changes `projects/` or `notes/`.
- **Single point of access.** If the GitHub app loses permission, sessions cannot push. Mirror plus the keep-and-retry rule limit the damage.
- **Host names.** Notes may name devices because the repo is private. The ledger records the machine name in event files, so if the project repo is public, set `LEDGER_HOST` to a role alias (for example `workstation`) instead of the real host name.
- OPEN: repo name (suggested `memory`, created and made private by the owner); whether notes are also written as ledger events; curator cadence; whether the ledger lives in this repo, the memory repo, or both.

## 9. Parked ideas (not scheduled)

- Local-model roles per device (which machine runs which model, which one serves media or compute) belong in the private `devices/` register.
- A decoy machine to attract and log hostile traffic: possible later, defensive only (detect and alert, never retaliate), on an isolated network segment, with its own design and ADR first.
