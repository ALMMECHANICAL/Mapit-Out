#!/usr/bin/env node
// Shared activity ledger CLI. See docs/mapitout/ledger/DESIGN.md.
//
//   node tools/ledger/cli.mjs append --type note --summary "..." [--task T] [--ref kind:ref]... [--data '{"k":1}']
//   node tools/ledger/cli.mjs tail [--n 20] [--type T] [--actor A] [--task T] [--since 7d] [--json]
//   node tools/ledger/cli.mjs context [--since 14d] [--max-chars 6000]
//   node tools/ledger/cli.mjs tasks [--json]
//   node tools/ledger/cli.mjs verify
//   node tools/ledger/cli.mjs schema
//
// Identity comes from env (override per call with flags): LEDGER_ACTOR, LEDGER_KIND, LEDGER_MODEL,
// LEDGER_HOST, LEDGER_SESSION, LEDGER_PROJECT. Storage dir: LEDGER_DIR (default ./ledger).

import { parseArgs } from 'node:util';
import {
	EVENT_TYPES, append, buildContext, deriveTasks, filterEvents, readAll, schema, verify
} from './ledger.mjs';

const HELP = `usage: ledger <command> [options]

commands:
  append    --type <${EVENT_TYPES.join('|')}> --summary <text>
            [--task id] [--parent eventId] [--ref kind:ref]... [--data json]
            [--actor name] [--kind human|agent|model|system] [--model m] [--host h] [--session s] [--project p]
  tail      [--n 20] [--type t] [--actor a] [--task id] [--since 7d|ISO] [--json]
  context   [--since 14d] [--max-chars 6000] [--project p]    markdown digest for a model to read first
  tasks     [--json]                                           derived task state (owner, status, contested)
  verify                                                       check hashes, chains, schema, secrets
  schema                                                       print the JSON Schema for events
`;

function die(msg, code = 1) { console.error(msg); process.exit(code); }

const { values: v, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		type: { type: 'string' }, summary: { type: 'string' }, task: { type: 'string' }, parent: { type: 'string' },
		ref: { type: 'string', multiple: true }, data: { type: 'string' },
		actor: { type: 'string' }, kind: { type: 'string' }, model: { type: 'string' }, host: { type: 'string' },
		session: { type: 'string' }, project: { type: 'string' },
		n: { type: 'string' }, since: { type: 'string' }, 'max-chars': { type: 'string' }, json: { type: 'boolean' },
		help: { type: 'boolean', short: 'h' }
	}
});

const cmd = positionals[0];
if (!cmd || v.help || cmd === 'help') { process.stdout.write(HELP); process.exit(cmd || v.help ? 0 : 1); }

const fmt = (e) => `${e.ts.slice(0, 16).replace('T', ' ')} ${e.id.slice(-6)} [${e.type}] ${e.actor.name}${e.task ? ' #' + e.task : ''}: ${e.summary}`;

try {
	if (cmd === 'append') {
		if (!v.type || !v.summary) die('append needs --type and --summary\n\n' + HELP);
		const input = { type: v.type, summary: v.summary };
		if (v.task) input.task = v.task;
		if (v.parent) input.parent = v.parent;
		if (v.project) input.project = v.project;
		if (v.ref) input.refs = v.ref.map((r) => {
			const i = r.indexOf(':');
			if (i < 1) die(`--ref must look like kind:ref (got "${r}")`);
			return { kind: r.slice(0, i), ref: r.slice(i + 1) };
		});
		if (v.data) {
			try { input.data = JSON.parse(v.data); } catch { die('--data must be valid JSON'); }
		}
		const actor = {};
		for (const k of ['model', 'host', 'session', 'kind']) if (v[k]) actor[k] = v[k];
		if (v.actor) actor.name = v.actor;
		if (Object.keys(actor).length) input.actor = actor;
		const ev = await append(input);
		console.log(v.json ? JSON.stringify(ev) : `ok ${ev.id} ${ev.type}`);
	} else if (cmd === 'tail') {
		const all = await readAll();
		const rows = filterEvents(all, { type: v.type, actor: v.actor, task: v.task, project: v.project, since: v.since }).slice(-Number(v.n || 20));
		console.log(v.json ? JSON.stringify(rows, null, 2) : rows.map(fmt).join('\n') || '(no events)');
	} else if (cmd === 'context') {
		process.stdout.write(buildContext(await readAll(), { since: v.since || '14d', maxChars: Number(v['max-chars'] || 6000), project: v.project }));
	} else if (cmd === 'tasks') {
		const tasks = [...deriveTasks(await readAll()).values()];
		if (v.json) console.log(JSON.stringify(tasks, null, 2));
		else console.log(tasks.map((t) => `#${t.id} [${t.status}]${t.owner ? ' ' + t.owner : ''}${t.title ? ' - ' + t.title : ''}${t.contested.length ? ' CONTESTED by ' + t.contested.join(',') : ''}`).join('\n') || '(no tasks)');
	} else if (cmd === 'verify') {
		const r = await verify();
		console.log(`${r.ok ? 'OK' : 'FAILED'}: ${r.events} events in ${r.shards} shard(s)`);
		r.problems.forEach((p) => console.log('  ' + p));
		process.exit(r.ok ? 0 : 2);
	} else if (cmd === 'schema') {
		console.log(JSON.stringify(schema(), null, '\t'));
	} else {
		die(`unknown command "${cmd}"\n\n${HELP}`);
	}
} catch (e) {
	die(e.message);
}
