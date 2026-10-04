// Shared activity ledger - core library. Zero dependencies (Node >= 18).
// Design: docs/mapitout/ledger/DESIGN.md, decision: docs/mapitout/adr/0004-*.md
//
// Append-only JSONL events, one file per writer (actor + host + session + month) so
// devices never write the same file (no git merge conflicts). Each event carries a
// per-file hash chain for tamper/accident detection. Secrets are rejected on write.

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

export const SCHEMA_VERSION = 1;

export const ACTOR_KINDS = ['human', 'agent', 'model', 'system'];

export const EVENT_TYPES = [
	'session.started', 'session.ended',
	'note', 'decision', 'error', 'handoff',
	'task.created', 'task.claimed', 'task.progress', 'task.blocked', 'task.released', 'task.completed',
	'artifact.created', 'artifact.changed', 'diagram.changed',
	'tool.call', 'asset.registered'
];

export const REF_KINDS = ['file', 'commit', 'pr', 'issue', 'url', 'diagram', 'adr', 'asset', 'event'];

export const LIMITS = { summary: 500, name: 80, dataBytes: 4096, refs: 20, refText: 300, task: 80, project: 60 };

export const TOP_KEYS = ['v', 'id', 'ts', 'project', 'type', 'summary', 'actor', 'task', 'parent', 'refs', 'data', 'prev', 'hash'];
const ACTOR_KEYS = ['kind', 'name', 'model', 'host', 'session'];
const REF_KEYS = ['kind', 'ref', 'note'];

// Exactly the format Date#toISOString writes, and a real calendar date (Date.parse alone accepts 2026-02-31).
function isIsoUtc(ts) {
	if (typeof ts !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(ts)) return false;
	const t = Date.parse(ts); // NaN for month 13 etc.; toISOString would throw on that, and validate must never throw
	return !Number.isNaN(t) && new Date(t).toISOString() === ts;
}

const ID_RE = /^[0-9a-f]{12}-[0-9a-f]{10}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;

// Patterns for credentials that must never be written to a repo. Deliberately broad:
// a false positive costs a re-worded summary, a false negative leaks a key.
export const SECRET_PATTERNS = [
	['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
	['OpenAI/Anthropic-style key', /\bsk-[A-Za-z0-9_-]{16,}/],
	['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/],
	['AWS access key id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
	['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
	['Google API key', /\bAIza[0-9A-Za-z_-]{30,}/],
	['bearer token', /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i],
	['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
	['credential assignment', /\b(?:api[_-]?key|secret|token|passwd|password|client[_-]?secret)\b["']?\s*[:=]\s*["']?[^\s"',;]{8,}/i]
];

export function findSecrets(text) {
	const hits = [];
	for (const [label, re] of SECRET_PATTERNS) {
		if (re.test(text)) hits.push(label);
	}
	return hits;
}

// ---------------------------------------------------------------- helpers

export function slug(value, fallback = 'unknown') {
	const s = String(value ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '').slice(0, 60);
	return s || fallback;
}

// id = 12 hex of epoch-ms, '-', 4 hex per-process counter, 6 hex random. The counter makes ids
// strictly increase within a process even inside one millisecond, so replay order equals write
// order (a random tiebreak scrambled same-ms events). Across processes/devices the order of
// same-ms events is arbitrary but stable; per-writer true order is always the shard's hash chain.
let lastMs = -1, counter = 0;
export function newId(now = Date.now()) {
	if (now === lastMs) counter = (counter + 1) & 0xffff; else { lastMs = now; counter = 0; }
	return now.toString(16).padStart(12, '0') + '-' + counter.toString(16).padStart(4, '0') + randomBytes(3).toString('hex');
}

// Canonical JSON: keys sorted recursively so the hash does not depend on key order.
export function canonical(value) {
	if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
	if (value && typeof value === 'object') {
		return '{' + Object.keys(value).sort().filter((k) => value[k] !== undefined)
			.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
	}
	return JSON.stringify(value);
}

export function hashEvent(event) {
	const { hash, ...rest } = event;
	return createHash('sha256').update(canonical(rest)).digest('hex');
}

// ---------------------------------------------------------------- validation

// Returns a list of problems; empty list = valid. Authoritative validator; the JSON Schema
// file is generated from the same constants (see schema()).
export function validate(event) {
	const errs = [];
	const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

	if (!event || typeof event !== 'object' || Array.isArray(event)) return ['event must be an object'];
	if (event.v !== SCHEMA_VERSION) errs.push(`v must be ${SCHEMA_VERSION}`);
	if (!ID_RE.test(event.id ?? '')) errs.push('id malformed');
	if (!isIsoUtc(event.ts)) errs.push('ts must be a real ISO-8601 UTC timestamp like 2026-10-04T10:00:00.000Z');
	for (const k of Object.keys(event)) if (!TOP_KEYS.includes(k)) errs.push(`unknown field "${k}"`);
	if (!isStr(event.project, LIMITS.project)) errs.push('project required');
	if (!EVENT_TYPES.includes(event.type)) errs.push(`type must be one of: ${EVENT_TYPES.join(', ')}`);
	if (!isStr(event.summary, LIMITS.summary)) errs.push(`summary required (1-${LIMITS.summary} chars)`);

	const a = event.actor;
	if (!a || typeof a !== 'object') errs.push('actor required');
	else {
		for (const k of Object.keys(a)) if (!ACTOR_KEYS.includes(k)) errs.push(`unknown actor field "${k}"`);
		if (!ACTOR_KINDS.includes(a.kind)) errs.push(`actor.kind must be one of: ${ACTOR_KINDS.join(', ')}`);
		if (!isStr(a.name, LIMITS.name)) errs.push('actor.name required');
		for (const k of ['model', 'host', 'session']) {
			if (a[k] !== undefined && !isStr(a[k], LIMITS.name)) errs.push(`actor.${k} must be a short string`);
		}
	}

	if (event.task !== undefined && !isStr(event.task, LIMITS.task)) errs.push('task must be a short string');
	if (event.parent !== undefined && !ID_RE.test(event.parent)) errs.push('parent must be an event id');

	if (event.refs !== undefined) {
		if (!Array.isArray(event.refs) || event.refs.length > LIMITS.refs) errs.push(`refs must be an array of at most ${LIMITS.refs}`);
		else event.refs.forEach((r, i) => {
			if (r && typeof r === 'object') for (const k of Object.keys(r)) if (!REF_KEYS.includes(k)) errs.push(`unknown field "${k}" in refs[${i}]`);
			if (!r || !REF_KINDS.includes(r.kind) || !isStr(r.ref, LIMITS.refText)) errs.push(`refs[${i}] needs kind (${REF_KINDS.join('|')}) and ref`);
			if (r && r.note !== undefined && !isStr(r.note, LIMITS.refText)) errs.push(`refs[${i}].note too long`);
		});
	}

	if (event.data !== undefined) {
		if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) errs.push('data must be an object');
		else if (Buffer.byteLength(JSON.stringify(event.data)) > LIMITS.dataBytes) errs.push(`data exceeds ${LIMITS.dataBytes} bytes`);
	}

	if (event.prev !== null && !HASH_RE.test(event.prev ?? '')) errs.push('prev must be null or a sha256 hex');
	if (!HASH_RE.test(event.hash ?? '')) errs.push('hash malformed');
	else if (errs.length === 0 && hashEvent(event) !== event.hash) errs.push('hash does not match content');

	const secrets = findSecrets(JSON.stringify(event));
	if (secrets.length) errs.push(`possible secret detected (${secrets.join(', ')}); never write credentials to the ledger`);
	return errs;
}

// JSON Schema (draft 2020-12) generated from the constants above, for non-JS consumers
// (agents, MCP tool definitions, other languages). `validate` stays authoritative.
export function schema() {
	const idPat = ID_RE.source, hashPat = HASH_RE.source;
	return {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		$id: 'https://github.com/ALMMECHANICAL/Mapit-Out/ledger/schema/event.v1.schema.json',
		title: 'Map It Out ledger event v1',
		type: 'object',
		additionalProperties: false,
		required: ['v', 'id', 'ts', 'project', 'type', 'summary', 'actor', 'prev', 'hash'],
		properties: {
			v: { const: SCHEMA_VERSION },
			id: { type: 'string', pattern: idPat },
			ts: { type: 'string', format: 'date-time', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$', description: 'UTC, exactly as Date#toISOString writes it; must be a real calendar date.' },
			project: { type: 'string', minLength: 1, maxLength: LIMITS.project },
			type: { enum: EVENT_TYPES },
			summary: { type: 'string', minLength: 1, maxLength: LIMITS.summary },
			actor: {
				type: 'object', additionalProperties: false, required: ['kind', 'name'],
				properties: {
					kind: { enum: ACTOR_KINDS },
					name: { type: 'string', minLength: 1, maxLength: LIMITS.name },
					model: { type: 'string', minLength: 1, maxLength: LIMITS.name },
					host: { type: 'string', minLength: 1, maxLength: LIMITS.name },
					session: { type: 'string', minLength: 1, maxLength: LIMITS.name }
				}
			},
			task: { type: 'string', minLength: 1, maxLength: LIMITS.task },
			parent: { type: 'string', pattern: idPat },
			refs: {
				type: 'array', maxItems: LIMITS.refs,
				items: {
					type: 'object', additionalProperties: false, required: ['kind', 'ref'],
					properties: { kind: { enum: REF_KINDS }, ref: { type: 'string', minLength: 1, maxLength: LIMITS.refText }, note: { type: 'string', minLength: 1, maxLength: LIMITS.refText } }
				}
			},
			data: { type: 'object', description: `Small type-specific payload, at most ${LIMITS.dataBytes} bytes serialised.` },
			prev: { oneOf: [{ type: 'null' }, { type: 'string', pattern: hashPat }], description: 'Hash of the previous event in the same shard file.' },
			hash: { type: 'string', pattern: hashPat, description: 'sha256 of the canonical JSON of this event without the hash field.' }
		}
	};
}

// ---------------------------------------------------------------- storage

export function defaultDir() {
	return process.env.LEDGER_DIR || path.resolve('ledger');
}

export function shardPath(dir, actor, now = new Date()) {
	const month = now.toISOString().slice(0, 7);
	const file = [slug(actor.name), slug(actor.host, 'nohost'), slug(actor.session, 'default')].join('.') + '.jsonl';
	return path.join(dir, 'events', month, file);
}

// Last non-empty line of a file, read from the tail. The window doubles until a newline precedes the
// last line (or it covers the whole file), so an event larger than the first window is still read whole.
// (A fixed window cut such a line in half and the next event silently started a second chain.)
const TAIL = 32768;
async function lastLine(file) {
	let fh;
	try { fh = await fs.open(file, 'r'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
	try {
		const { size } = await fh.stat();
		for (let len = Math.min(size, TAIL); size > 0; len = Math.min(size, len * 2)) {
			const buf = Buffer.alloc(len);
			await fh.read(buf, 0, len, size - len);
			let end = buf.length;
			while (end > 0 && (buf[end - 1] === 0x0a || buf[end - 1] === 0x0d)) end--; // trailing newlines
			if (end === 0) { if (len >= size) return null; continue; } // window held only newlines
			const nl = buf.lastIndexOf(0x0a, end - 1); // 0x0a never occurs inside a multi-byte UTF-8 sequence
			if (nl >= 0 || len >= size) return buf.subarray(nl + 1, end).toString('utf8');
		}
		return null;
	} finally { await fh.close(); }
}

// Cross-process lock via exclusive create. Lock files older than 30 s are treated as stale.
async function withLock(file, fn) {
	const lock = file + '.lock';
	await fs.mkdir(path.dirname(file), { recursive: true });
	const deadline = Date.now() + 10000;
	for (;;) {
		try { await (await fs.open(lock, 'wx')).close(); break; } catch (e) {
			if (e.code !== 'EEXIST') throw e;
			try { if (Date.now() - (await fs.stat(lock)).mtimeMs > 30000) { await fs.unlink(lock); continue; } } catch { /* raced */ }
			if (Date.now() > deadline) throw new Error(`ledger: timed out waiting for lock ${lock}`);
			await new Promise((r) => setTimeout(r, 15 + Math.random() * 25));
		}
	}
	try { return await fn(); } finally { await fs.unlink(lock).catch(() => {}); }
}

// Append one event. `input` has: type, summary, [actor], [project], [task], [parent], [refs], [data].
// Actor defaults come from LEDGER_ACTOR / LEDGER_KIND / LEDGER_MODEL / LEDGER_HOST / LEDGER_SESSION.
export async function append(input, { dir = defaultDir(), now = new Date() } = {}) {
	const actor = { ...actorFromEnv(), ...(input.actor || {}) };
	for (const k of Object.keys(actor)) if (actor[k] === undefined || actor[k] === '') delete actor[k];

	const event = {
		v: SCHEMA_VERSION, id: newId(now.getTime()), ts: now.toISOString(),
		project: input.project || process.env.LEDGER_PROJECT || 'mapitout',
		type: input.type, summary: input.summary, actor
	};
	for (const k of ['task', 'parent', 'refs', 'data']) if (input[k] !== undefined) event[k] = input[k];

	// Reject unknown top-level keys early with a clear message.
	const allowed = new Set([...Object.keys(event), 'task', 'parent', 'refs', 'data', 'actor', 'project']);
	const extra = Object.keys(input).filter((k) => !allowed.has(k));
	if (extra.length) throw new Error(`ledger: unknown field(s): ${extra.join(', ')}`);

	const file = shardPath(dir, actor, now);
	return withLock(file, async () => {
		const prevLine = await lastLine(file);
		event.prev = prevLine ? JSON.parse(prevLine).hash : null;
		event.hash = hashEvent(event);
		const errs = validate(event);
		if (errs.length) throw new Error('ledger: invalid event: ' + errs.join('; '));
		if (event.type === 'task.claimed') {
			const owner = activeOwner(deriveTasks(await readAll({ dir })).get(event.task));
			if (owner && owner !== actor.name) throw new Error(`ledger: task ${event.task} is already claimed by ${owner}`);
		}
		await fs.appendFile(file, JSON.stringify(event) + '\n', { flag: 'a' });
		return event;
	});
}

export function actorFromEnv(env = process.env) {
	return {
		kind: env.LEDGER_KIND || 'agent',
		name: env.LEDGER_ACTOR || 'unknown',
		model: env.LEDGER_MODEL,
		host: env.LEDGER_HOST || hostname(),
		session: env.LEDGER_SESSION
	};
}

async function listShards(dir) {
	const root = path.join(dir, 'events');
	const out = [];
	let months;
	try { months = await fs.readdir(root); } catch (e) { if (e.code === 'ENOENT') return out; throw e; }
	for (const m of months.sort()) {
		const files = await fs.readdir(path.join(root, m)).catch(() => []);
		for (const f of files.sort()) if (f.endsWith('.jsonl')) out.push(path.join(root, m, f));
	}
	return out;
}

// Reads every shard; returns events sorted by (ts, id). Unparseable lines are skipped here
// and reported by verify().
export async function readAll({ dir = defaultDir() } = {}) {
	const events = [];
	for (const file of await listShards(dir)) {
		for (const line of (await fs.readFile(file, 'utf8')).split('\n')) {
			if (!line) continue;
			try { events.push(JSON.parse(line)); } catch { /* reported by verify */ }
		}
	}
	return events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Integrity check over every shard: JSON parses, schema valid, hash matches, chain unbroken,
// no secrets, no duplicate ids. Returns { ok, shards, events, problems[] }.
export async function verify({ dir = defaultDir() } = {}) {
	const problems = [];
	const seen = new Set();
	let count = 0;
	const shards = await listShards(dir);
	for (const file of shards) {
		const rel = path.relative(dir, file);
		let prev = null;
		const lines = (await fs.readFile(file, 'utf8')).split('\n');
		lines.forEach((line, i) => {
			if (!line) return;
			let ev;
			try { ev = JSON.parse(line); } catch { problems.push(`${rel}:${i + 1}: not valid JSON`); return; }
			count++;
			for (const e of validate(ev)) problems.push(`${rel}:${i + 1}: ${e}`);
			if (ev.prev !== prev) problems.push(`${rel}:${i + 1}: chain broken (prev does not match previous event)`);
			if (seen.has(ev.id)) problems.push(`${rel}:${i + 1}: duplicate id ${ev.id}`);
			seen.add(ev.id);
			prev = ev.hash;
		});
	}
	return { ok: problems.length === 0, shards: shards.length, events: count, problems };
}

// ---------------------------------------------------------------- derived views

// Task state is derived, never stored: replaying events yields owner/status. Earliest claim wins;
// a later claim by someone else (race across devices) is flagged `contested`.
export function deriveTasks(events) {
	const tasks = new Map();
	for (const ev of events) {
		if (!ev.task) continue;
		let t = tasks.get(ev.task);
		if (!t) { t = { id: ev.task, title: null, status: 'open', owner: null, contested: [], last: ev, events: 0 }; tasks.set(ev.task, t); }
		t.events++; t.last = ev;
		switch (ev.type) {
			case 'task.created': t.title = ev.summary; break;
			case 'task.claimed':
				if (!t.owner) { t.owner = ev.actor.name; t.status = 'claimed'; }
				else if (t.owner !== ev.actor.name) t.contested.push(ev.actor.name);
				break;
			case 'task.progress': if (t.status === 'open' || t.status === 'blocked') t.status = t.owner ? 'claimed' : t.status; break;
			case 'task.blocked': t.status = 'blocked'; break;
			case 'task.released': {
				const who = ev.actor.name;
				if (t.owner === who || (ev.actor.kind === 'human' && t.owner)) {
					// the owner (or a human freeing an abandoned claim) gives the task up; the next claimant, if any, inherits it
					t.owner = t.contested.shift() || null;
					t.status = t.owner ? 'claimed' : 'open';
				} else if (t.contested.includes(who)) {
					t.contested = t.contested.filter((n) => n !== who); // a losing claimant withdraws only itself
				} // anyone else releasing a task they do not hold changes nothing
				break;
			}
			case 'task.completed': t.status = 'done'; break;
		}
	}
	return tasks;
}

function activeOwner(task) {
	return task && task.owner && task.status !== 'done' ? task.owner : null;
}

export function parseSince(spec, now = Date.now()) {
	if (!spec) return 0;
	const m = /^(\d+)([smhdw])$/.exec(spec);
	if (m) return now - Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[m[2]];
	const t = Date.parse(spec);
	if (Number.isNaN(t)) throw new Error(`ledger: cannot parse --since "${spec}" (use 7d, 12h, or an ISO date)`);
	return t;
}

export function filterEvents(events, { type, actor, task, project, since } = {}) {
	const t0 = typeof since === 'number' ? since : parseSince(since);
	return events.filter((e) =>
		(!type || e.type === type || e.type.startsWith(type + '.')) &&
		(!actor || e.actor.name === actor) && (!task || e.task === task) &&
		(!project || e.project === project) && (!t0 || Date.parse(e.ts) >= t0));
}

const short = (id) => id.slice(-6);
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '\u2026' : s);
const line = (e) => `- ${e.ts.slice(0, 16).replace('T', ' ')} [${e.type}] ${e.actor.name}${e.actor.model ? ' (' + e.actor.model + ')' : ''}${e.task ? ' #' + e.task : ''}: ${trunc(e.summary, 200)} (${short(e.id)})`;
const MAX_TASK_LINES = 25;

// Digest any model can read at the start of a session. Budgeted in characters so a small local
// model's context window is respected: the header, open tasks and decisions are always kept;
// the oldest recent-activity lines are dropped first, and the cut is stated.
export function buildContext(events, { since = '14d', maxChars = 6000, project, now = Date.now() } = {}) {
	const scoped = project ? events.filter((e) => e.project === project) : events;
	const recent = filterEvents(scoped, { since: parseSince(since, now) });
	const tasks = [...deriveTasks(scoped).values()].filter((t) => t.status !== 'done');
	const decisions = scoped.filter((e) => e.type === 'decision').slice(-10);
	const handoffs = scoped.filter((e) => e.type === 'handoff').slice(-3);

	const head = ['# Ledger context', `Generated ${new Date(now).toISOString()} - ${scoped.length} events total, ${recent.length} in the last ${since}.`, ''];
	const fixed = [];
	fixed.push('## Open tasks');
	if (!tasks.length) fixed.push('(none)');
	for (const t of tasks.slice(0, MAX_TASK_LINES)) {
		fixed.push(`- #${t.id} [${t.status}]${t.owner ? ' owner: ' + t.owner : ''}${t.title ? ' - ' + trunc(t.title, 160) : ''}${t.contested.length ? ` (CONTESTED by ${t.contested.join(', ')})` : ''}`);
	}
	if (tasks.length > MAX_TASK_LINES) fixed.push(`(+${tasks.length - MAX_TASK_LINES} more open tasks; use \`ledger tasks\`)`);
	fixed.push('', '## Latest handoffs');
	if (!handoffs.length) fixed.push('(none)');
	handoffs.forEach((e) => fixed.push(line(e)));
	fixed.push('', '## Decisions (latest 10)');
	if (!decisions.length) fixed.push('(none)');
	decisions.forEach((e) => fixed.push(line(e)));

	const base = head.concat(fixed, ['', '## Recent activity (newest last)']).join('\n');
	const acts = recent.filter((e) => !['decision', 'handoff'].includes(e.type)).map(line);
	// Walk newest -> oldest, keeping lines while they fit (linear; a re-join per drop was O(n^2)).
	let used = base.length + 1 + 80, from = acts.length;
	while (from > 0 && used + acts[from - 1].length + 1 <= maxChars) { from--; used += acts[from].length + 1; }
	const kept = acts.slice(from), dropped = from;
	const note = dropped ? [`(${dropped} older line(s) omitted to fit the ${maxChars}-character budget; use \`ledger tail\` for more)`] : [];
	let out = [base, ...note, ...(kept.length ? kept : ['(none)'])].join('\n') + '\n';
	// Hard limit: the fixed sections are bounded (25 task lines, 3 hand-offs, 10 decisions, 200-char summaries) but a very small
	// budget can still be smaller than they are, so cut the tail rather than exceed what the caller asked for.
	const CUT = '\n(truncated to fit the budget)\n';
	if (out.length > maxChars) out = out.slice(0, Math.max(0, maxChars - CUT.length)) + CUT;
	return out;
}
