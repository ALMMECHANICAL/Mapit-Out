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

// Exactly the format Date#toISOString writes, restricted to real calendar dates (leap years included), so the
// same pattern can go in the JSON Schema and non-JS validators reject 2026-02-31 too. (Date.parse alone accepts it.)
const LEAP = '(?:\\d\\d(?:0[48]|[2468][048]|[13579][26])|(?:0[048]|[2468][048]|[13579][26])00)';
export const TS_PATTERN = '^(?:\\d{4}-(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|\\d{4}-(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|\\d{4}-02-(?:0[1-9]|1\\d|2[0-8])|' + LEAP + '-02-29)' +
	'T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}Z$';
const TS_RE = new RegExp(TS_PATTERN);
export function isIsoUtc(ts) {
	if (typeof ts !== 'string' || !TS_RE.test(ts)) return false;
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
			ts: { type: 'string', format: 'date-time', pattern: TS_PATTERN, description: 'UTC, exactly as Date#toISOString writes it; must be a real calendar date.' },
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
	// slug() is lossy ("A B" and "a-b" collapse), so a short hash of the raw identity keeps distinct writers in distinct files.
	const id = createHash('sha256').update([actor.name, actor.host ?? '', actor.session ?? ''].join('\0')).digest('hex').slice(0, 8);
	const file = [slug(actor.name), slug(actor.host, 'nohost'), slug(actor.session, 'default'), id].join('.') + '.jsonl';
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

// Cross-process lock via exclusive create. The lock file records its owner ({pid, host, token, t}).
// A lock is stale (and may be taken over) when its owner process is gone (same host), when it outlived a
// generous lease, or when it is unreadable and old. A live owner is never robbed, and release only removes
// the lock if it is still ours, so a slow writer can not delete a successor's lock.
const LOCK_LEASE_MS = 600000, LOCK_JUNK_MS = 30000;
function pidAlive(pid) {
	try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
async function readLock(lock) {
	let text;
	try { text = await fs.readFile(lock, 'utf8'); } catch { return null; }
	try { return JSON.parse(text); } catch { return { junk: true }; }
}
async function lockIsStale(lock) {
	const info = await readLock(lock);
	if (!info) return false; // gone already; just retry
	if (info.junk || typeof info.t !== 'number') {
		try { return Date.now() - (await fs.stat(lock)).mtimeMs > LOCK_JUNK_MS; } catch { return false; }
	}
	if (info.host === hostname() && Number.isInteger(info.pid) && !pidAlive(info.pid)) return true;
	return Date.now() - info.t > LOCK_LEASE_MS;
}
// Taking over a stale lock must be exclusive, or two waiters can both judge it stale and the slower one then
// unlinks the lock the faster one just created. Only the holder of the "<lock>.reap" mutex may unlink, and it
// re-checks staleness under that mutex. (Residual: a live owner that outlived the 10-minute lease and releases
// in the instant between the re-check and the unlink; a hung process, not a normal one.)
async function reapStale(lock) {
	const reap = lock + '.reap';
	let fh;
	try { fh = await fs.open(reap, 'wx'); } catch (e) {
		if (e.code !== 'EEXIST') throw e;
		try { if (Date.now() - (await fs.stat(reap)).mtimeMs > LOCK_JUNK_MS) await fs.unlink(reap); } catch { /* raced */ }
		return false; // someone else is reaping; back off and retry (with the timeout check) instead of spinning
	}
	await fh.close();
	try { if (await lockIsStale(lock)) await fs.unlink(lock).catch(() => {}); } finally { await fs.unlink(reap).catch(() => {}); }
	return true;
}
async function withLock(file, fn, { timeoutMs = 10000 } = {}) {
	const lock = file + '.lock';
	await fs.mkdir(path.dirname(file), { recursive: true });
	const token = randomBytes(8).toString('hex');
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const fh = await fs.open(lock, 'wx');
			try { await fh.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), token, t: Date.now() })); } finally { await fh.close(); }
			break;
		} catch (e) {
			if (e.code !== 'EEXIST') throw e;
			if (await lockIsStale(lock) && (await reapStale(lock))) continue; // took the stale lock away; retry the create at once
			if (Date.now() > deadline) throw new Error(`ledger: timed out waiting for lock ${lock}`);
			await new Promise((r) => setTimeout(r, 15 + Math.random() * 25));
		}
	}
	try { return await fn(); } finally {
		const info = await readLock(lock);
		if (info && info.token === token) await fs.unlink(lock).catch(() => {});
	}
}

const CLAIM_BLOCKED_ON_DONE = ['task.claimed', 'task.progress', 'task.blocked', 'task.released'];

// Append one event. `input` has: type, summary, [actor], [project], [task], [parent], [refs], [data].
// Actor defaults come from LEDGER_ACTOR / LEDGER_KIND / LEDGER_MODEL / LEDGER_HOST / LEDGER_SESSION.
// Task events also take a ledger-wide lock (before the shard lock) so "check the owner, then claim" is atomic
// across writers on one checkout; across devices a race is detected after sync (contested), not prevented.
export async function append(input, { dir = defaultDir(), now = new Date(), lockTimeoutMs } = {}) {
	const actor = { ...actorFromEnv(), ...(input.actor || {}) };
	for (const k of Object.keys(actor)) if (actor[k] === undefined || actor[k] === '') delete actor[k];

	const allowed = new Set(['type', 'summary', 'task', 'parent', 'refs', 'data', 'actor', 'project']);
	const extra = Object.keys(input).filter((k) => !allowed.has(k));
	if (extra.length) throw new Error(`ledger: unknown field(s): ${extra.join(', ')}`);

	const file = shardPath(dir, actor, now);
	const lockOpts = { timeoutMs: lockTimeoutMs };
	const write = () => withLock(file, async () => {
		// id and ts are made inside the lock so a writer that waited does not stamp an older time than its predecessor
		const event = {
			v: SCHEMA_VERSION, id: newId(now.getTime()), ts: now.toISOString(),
			project: input.project || process.env.LEDGER_PROJECT || 'mapitout',
			type: input.type, summary: input.summary, actor
		};
		for (const k of ['task', 'parent', 'refs', 'data']) if (input[k] !== undefined) event[k] = input[k];
		const prevLine = await lastLine(file);
		event.prev = prevLine ? JSON.parse(prevLine).hash : null;
		event.hash = hashEvent(event);
		const errs = validate(event);
		if (errs.length) throw new Error('ledger: invalid event: ' + errs.join('; '));
		if (CLAIM_BLOCKED_ON_DONE.includes(event.type)) {
			const task = deriveTasks(await readAll({ dir })).get(event.task);
			if (task && task.status === 'done') throw new Error(`ledger: task ${event.task} is already completed`);
			const owner = event.type === 'task.claimed' ? activeOwner(task) : null;
			if (owner && owner !== actor.name) throw new Error(`ledger: task ${event.task} is already claimed by ${owner}`);
		}
		await fs.appendFile(file, JSON.stringify(event) + '\n', { flag: 'a' });
		return event;
	}, lockOpts);
	if (typeof input.type === 'string' && input.type.startsWith('task.')) return withLock(path.join(dir, 'tasks'), write, lockOpts);
	return write();
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
	try { months = await fs.readdir(root, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return out; throw e; }
	for (const m of months.filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
		const files = await fs.readdir(path.join(root, m)); // a permission or I/O error must surface, not hide a month of events
		for (const f of files.sort()) if (f.endsWith('.jsonl')) out.push(path.join(root, m, f));
	}
	return out;
}

// Reads every shard and merges them by (ts, id). Each shard's own file order is kept (it is the hash-chain
// order), so a device whose clock stepped backwards can not reorder its own events. Unparseable lines are
// skipped here and reported by verify().
export async function readAll({ dir = defaultDir() } = {}) {
	const lists = [];
	for (const file of await listShards(dir)) {
		const evs = [];
		for (const line of (await fs.readFile(file, 'utf8')).split('\n')) {
			if (!line) continue;
			try { evs.push(JSON.parse(line)); } catch { /* reported by verify */ }
		}
		if (evs.length) lists.push(evs);
	}
	// Min-heap over the shard heads: O(events log shards). Entries are [event, shardIndex].
	const idx = lists.map(() => 1), out = [], heap = [];
	const less = (x, y) => (x[0].ts < y[0].ts ? true : x[0].ts > y[0].ts ? false : x[0].id < y[0].id ? true : x[0].id > y[0].id ? false : x[1] < y[1]);
	const up = (k) => { for (; k > 0; ) { const p = (k - 1) >> 1; if (!less(heap[k], heap[p])) break; [heap[k], heap[p]] = [heap[p], heap[k]]; k = p; } };
	const down = (k) => { for (;;) { let m = k; const l = 2 * k + 1, r = l + 1; if (l < heap.length && less(heap[l], heap[m])) m = l; if (r < heap.length && less(heap[r], heap[m])) m = r; if (m === k) return; [heap[k], heap[m]] = [heap[m], heap[k]]; k = m; } };
	lists.forEach((l, i) => { heap.push([l[0], i]); up(heap.length - 1); });
	while (heap.length) {
		const [ev, i] = heap[0];
		out.push(ev);
		if (idx[i] < lists[i].length) heap[0] = [lists[i][idx[i]++], i];
		else { const last = heap.pop(); if (heap.length) heap[0] = last; }
		down(0);
	}
	return out;
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
		if (t.status === 'done') continue; // completed is terminal: later events can not reopen or re-own it
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
					t.contested = [...new Set(t.contested)].filter((n) => n !== t.owner); // a writer that claimed twice queues once, and never behind itself
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
