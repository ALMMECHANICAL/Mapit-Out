# ledger/

Shared activity log for humans, agents and models. **Append only; write through the tool, never by hand.**
Design: [`docs/mapitout/ledger/DESIGN.md`](../docs/mapitout/ledger/DESIGN.md) · Decision: [ADR 0004](../docs/mapitout/adr/0004-shared-activity-ledger-jsonl-sharded-by-writer.md)

```
events/YYYY-MM/<actor>.<host>.<session>.jsonl   one file per writer (no merge conflicts)
schema/event.v1.schema.json                     generated: node tools/ledger/cli.mjs schema
```

## Use (Node 18+, no install)

```bash
# who am I (set once per session; host defaults to the machine name)
export LEDGER_ACTOR=claude-code LEDGER_KIND=agent LEDGER_SESSION=my-session

L="node tools/ledger/cli.mjs"
$L context                       # READ THIS FIRST: open tasks, handoffs, decisions, recent activity
$L append --type task.claimed --task my-task --summary "taking it"
$L append --type decision --summary "chose X because Y" --ref adr:0007
$L append --type handoff --summary "next actor should know ..."
$L tasks            # derived task state     $L tail --n 20     $L verify
```

Identity variables: `LEDGER_ACTOR`, `LEDGER_KIND` (human|agent|model|system), `LEDGER_MODEL`, `LEDGER_HOST`,
`LEDGER_SESSION`, `LEDGER_PROJECT`; storage dir `LEDGER_DIR` (default `./ledger`).

## Rules
1. Write facts, one sentence: what and why. Link to files, commits, PRs, ADRs instead of pasting content.
2. **Never** put keys, tokens, passwords, customer names, addresses or prices in an event. Secrets are rejected on write; that is a safety net, not permission.
3. Do not edit or delete event files. A mistake is corrected by a new event. `verify` fails if history is changed.
4. Start every session with `context`; end with a `handoff`.
5. Claim a task before working on it; release it if you stop.

Tests: `cd tools/ledger && node --test`.
