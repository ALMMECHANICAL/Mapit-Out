import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { spawnSync } from 'node:child_process';
import {
	append, isIsoUtc, buildContext, canonical, deriveTasks, filterEvents, findSecrets, hashEvent,
	parseSince, readAll, schema, shardPath, validate, verify, TS_PATTERN
} from './ledger.mjs';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, 'cli.mjs');

async function tmp() { return fs.mkdtemp(path.join(tmpdir(), 'ledger-')); }
const A = { kind: 'agent', name: 'claude-code', host: 'cloud', session: 's1' };
const B = { kind: 'model', name: 'lmstudio-qwen', host: 'laptop', session: 's9' };

test('append writes a valid, chained event', async () => {
	const dir = await tmp();
	const e1 = await append({ type: 'note', summary: 'first', actor: A }, { dir });
	const e2 = await append({ type: 'note', summary: 'second', actor: A }, { dir });
	assert.equal(e1.prev, null);
	assert.equal(e2.prev, e1.hash);
	assert.deepEqual(validate(e1), []);
	const r = await verify({ dir });
	assert.equal(r.ok, true);
	assert.equal(r.events, 2);
});

test('different writers use different shard files (no shared file to conflict on)', async () => {
	const dir = await tmp();
	await append({ type: 'note', summary: 'a', actor: A }, { dir });
	await append({ type: 'note', summary: 'b', actor: B }, { dir });
	assert.notEqual(shardPath(dir, A), shardPath(dir, B));
	const r = await verify({ dir });
	assert.equal(r.shards, 2);
	assert.equal((await readAll({ dir })).length, 2);
});

test('tampering with an event is detected', async () => {
	const dir = await tmp();
	const e = await append({ type: 'decision', summary: 'use JSONL', actor: A }, { dir });
	const file = shardPath(dir, A, new Date(e.ts));
	const edited = (await fs.readFile(file, 'utf8')).replace('use JSONL', 'use SQLite');
	await fs.writeFile(file, edited);
	const r = await verify({ dir });
	assert.equal(r.ok, false);
	assert.match(r.problems.join('\n'), /hash does not match/);
});

test('deleting a middle event breaks the chain', async () => {
	const dir = await tmp();
	const e = await append({ type: 'note', summary: 'one', actor: A }, { dir });
	await append({ type: 'note', summary: 'two', actor: A }, { dir });
	await append({ type: 'note', summary: 'three', actor: A }, { dir });
	const file = shardPath(dir, A, new Date(e.ts));
	const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
	await fs.writeFile(file, [lines[0], lines[2]].join('\n') + '\n');
	const r = await verify({ dir });
	assert.equal(r.ok, false);
	assert.match(r.problems.join('\n'), /chain broken/);
});

test('secrets are rejected on write and detected by verify', async () => {
	const dir = await tmp();
	for (const bad of [
		'key is sk-abcdefghijklmnop1234567890',
		'token ghp_abcdefghijklmnopqrstuvwx',
		'AKIAABCDEFGHIJKLMNOP leaked',
		'password: hunter2hunter2',
		'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123'
	]) {
		await assert.rejects(append({ type: 'note', summary: bad, actor: A }, { dir }), /secret/);
	}
	await assert.rejects(append({ type: 'note', summary: 'ok', data: { k: 'api_key=abcdef123456' }, actor: A }, { dir }), /secret/);
	assert.deepEqual(findSecrets('plain text about api keys in general'), []);
	assert.equal((await readAll({ dir })).length, 0);
});

test('verify itself catches a secret that reached a shard some other way (forged but correctly chained)', async () => {
	const dir = await tmp();
	const ok = await append({ type: 'note', summary: 'clean', actor: A }, { dir });
	const file = shardPath(dir, A, new Date(ok.ts));
	const leaked = { ...ok, id: ok.id.slice(0, 13) + '0001' + ok.id.slice(17), summary: 'oops sk-abcdefghijklmnop1234567890', prev: ok.hash };
	delete leaked.hash;
	leaked.hash = hashEvent(leaked); // chain and hash are consistent: only the secret scan can object
	await fs.appendFile(file, JSON.stringify(leaked) + '\n');
	const r = await verify({ dir });
	assert.equal(r.ok, false);
	assert.match(r.problems.join('\n'), /possible secret/);
	assert.doesNotMatch(r.problems.join('\n'), /chain broken|hash does not match/);
});

test('validation rejects bad input', async () => {
	const dir = await tmp();
	await assert.rejects(append({ type: 'nope', summary: 'x', actor: A }, { dir }), /type must be/);
	await assert.rejects(append({ type: 'note', summary: '', actor: A }, { dir }), /summary required/);
	await assert.rejects(append({ type: 'note', summary: 'x'.repeat(501), actor: A }, { dir }), /summary required/);
	await assert.rejects(append({ type: 'note', summary: 'x', actor: { ...A, kind: 'robot' } }, { dir }), /actor.kind/);
	await assert.rejects(append({ type: 'note', summary: 'x', actor: A, bogus: 1 }, { dir }), /unknown field/);
	await assert.rejects(append({ type: 'note', summary: 'x', actor: A, refs: [{ kind: 'nope', ref: 'r' }] }, { dir }), /refs\[0\]/);
	await assert.rejects(append({ type: 'note', summary: 'x', actor: A, data: { big: 'y'.repeat(5000) } }, { dir }), /exceeds/);
	await assert.rejects(append({ type: 'note', summary: 'x', actor: A, parent: 'not-an-id' }, { dir }), /parent/);
});

test('concurrent writers on the same shard keep the chain intact', async () => {
	const dir = await tmp();
	const env = { ...process.env, LEDGER_DIR: dir, LEDGER_ACTOR: 'claude-code', LEDGER_HOST: 'cloud', LEDGER_SESSION: 'race' };
	await Promise.all(Array.from({ length: 8 }, (_, i) =>
		run('node', [CLI, 'append', '--type', 'note', '--summary', `parallel ${i}`], { env })));
	const r = await verify({ dir });
	assert.equal(r.ok, true, r.problems.join('\n'));
	assert.equal(r.events, 8);
	assert.equal(r.shards, 1);
});

test('task state is derived; second claimant is refused; release reopens', async () => {
	const dir = await tmp();
	await append({ type: 'task.created', summary: 'Design the log', task: 't1', actor: A }, { dir });
	await append({ type: 'task.claimed', summary: 'taking it', task: 't1', actor: A }, { dir });
	await assert.rejects(append({ type: 'task.claimed', summary: 'me too', task: 't1', actor: B }, { dir }), /already claimed by claude-code/);
	let t = deriveTasks(await readAll({ dir })).get('t1');
	assert.equal(t.owner, 'claude-code');
	assert.equal(t.status, 'claimed');
	await append({ type: 'task.released', summary: 'giving back', task: 't1', actor: A }, { dir });
	await append({ type: 'task.claimed', summary: 'mine now', task: 't1', actor: B }, { dir });
	await append({ type: 'task.completed', summary: 'done', task: 't1', actor: B }, { dir });
	t = deriveTasks(await readAll({ dir })).get('t1');
	assert.equal(t.status, 'done');
	assert.equal(t.owner, 'lmstudio-qwen');
});

test('cross-device claim race is flagged as contested (earliest wins)', () => {
	// Simulates two devices claiming before either synced: both events exist, so append could not refuse.
	const mk = (ts, actor, type) => ({ id: ts.replace(/\D/g, '').slice(0, 12).padEnd(12, '0') + '-0000000000', ts, type, task: 't', summary: 's', actor });
	const tasks = deriveTasks([
		mk('2026-10-04T10:00:00.000Z', A, 'task.claimed'),
		mk('2026-10-04T10:00:05.000Z', B, 'task.claimed')
	]);
	const t = tasks.get('t');
	assert.equal(t.owner, 'claude-code');
	assert.deepEqual(t.contested, ['lmstudio-qwen']);
});

test('context digest is budgeted, keeps open tasks and decisions, states the cut', async () => {
	const dir = await tmp();
	await append({ type: 'task.created', summary: 'Build ledger', task: 'ledger', actor: A }, { dir });
	await append({ type: 'decision', summary: 'JSONL sharded by writer', actor: A }, { dir });
	for (let i = 0; i < 60; i++) await append({ type: 'note', summary: `activity line number ${i} with some padding text`, actor: B }, { dir });
	const events = await readAll({ dir });
	const small = buildContext(events, { maxChars: 1800 });
	assert.ok(small.length <= 1800 + 200, `digest too large: ${small.length}`);
	assert.match(small, /Open tasks[\s\S]*#ledger \[open\]/);
	assert.match(small, /JSONL sharded by writer/);
	assert.match(small, /older line\(s\) omitted/);
	const big = buildContext(events, { maxChars: 20000 });
	assert.doesNotMatch(big, /omitted/);
	assert.match(big, /activity line number 0 /);
});

test('append stays correct when the shard is larger than the tail window', async () => {
	const dir = await tmp();
	const big = { pad: 'x'.repeat(3000) };
	for (let i = 0; i < 25; i++) await append({ type: 'note', summary: `big ${i}`, data: big, actor: A }, { dir }); // ~75 KB > 32 KB tail
	const e = await append({ type: 'note', summary: 'after the big ones', actor: A }, { dir });
	const r = await verify({ dir });
	assert.equal(r.ok, true, r.problems.join('\n'));
	assert.equal(r.events, 26);
	assert.ok(e.prev);
});

test('context digest scales linearly (regression: was O(n^2), 33 s at 20k events)', () => {
	const now = Date.now();
	const events = Array.from({ length: 20000 }, (_, i) => ({
		v: 1, id: (now - 20000 + i).toString(16).padStart(12, '0') + '-0000000000', ts: new Date(now - 20000 + i).toISOString(),
		project: 'mapitout', type: 'note', summary: `event ${i} with padding text`, actor: A
	}));
	const t0 = performance.now();
	const out = buildContext(events, { maxChars: 6000, now });
	assert.ok(performance.now() - t0 < 3000, `buildContext too slow: ${Math.round(performance.now() - t0)} ms`);
	assert.ok(out.length <= 6200);
	assert.match(out, /event 19999 /); // newest kept
	assert.doesNotMatch(out, /event 0 /); // oldest dropped
});

test('events written in the same millisecond replay in write order (regression: random tiebreak scrambled them)', async () => {
	const dir = await tmp();
	const now = new Date('2026-10-04T10:00:00.000Z');
	for (let i = 0; i < 40; i++) await append({ type: 'note', summary: `n${i}`, actor: A }, { dir, now });
	const got = (await readAll({ dir })).map((e) => Number(e.summary.slice(1)));
	assert.deepEqual(got, Array.from({ length: 40 }, (_, i) => i));
});

test('a valid event larger than the tail window still chains correctly (regression: lastLine returned null)', async () => {
	const dir = await tmp();
	const cjk = '界'.repeat(300); // 3 bytes each in UTF-8
	const refs = Array.from({ length: 20 }, (_, i) => ({ kind: 'file', ref: cjk, note: cjk }));
	const e1 = await append({ type: 'note', summary: 'big', refs, data: { pad: '界'.repeat(1300) }, actor: A }, { dir });
	assert.ok(Buffer.byteLength(JSON.stringify(e1)) > 40000, 'test event should exceed the 32 KiB tail window');
	const e2 = await append({ type: 'note', summary: 'after the big one', actor: A }, { dir });
	assert.equal(e2.prev, e1.hash);
	const r = await verify({ dir });
	assert.equal(r.ok, true, r.problems.join('\n'));
});

test('only the owner (or a human) can release a task; a losing claimant releasing just withdraws itself', () => {
	const mk = (n, ts, actor, type) => ({ id: ts.toString(16).padStart(12, '0') + '-' + String(n).padStart(10, '0'), ts: new Date(ts).toISOString(), type, task: 't', summary: 's', actor });
	const owner = A, loser = B, third = { kind: 'agent', name: 'someone-else' }, human = { kind: 'human', name: 'owner' };
	let tasks = deriveTasks([mk(1, 1000, owner, 'task.claimed'), mk(2, 2000, loser, 'task.claimed'), mk(3, 3000, loser, 'task.released')]);
	assert.equal(tasks.get('t').owner, 'claude-code', 'loser withdrawing must not free the task');
	assert.deepEqual(tasks.get('t').contested, []);
	tasks = deriveTasks([mk(1, 1000, owner, 'task.claimed'), mk(2, 2000, third, 'task.released')]);
	assert.equal(tasks.get('t').owner, 'claude-code', 'a stranger cannot release someone else\'s claim');
	tasks = deriveTasks([mk(1, 1000, owner, 'task.claimed'), mk(2, 2000, loser, 'task.claimed'), mk(3, 3000, owner, 'task.released')]);
	assert.equal(tasks.get('t').owner, 'lmstudio-qwen', 'owner releasing hands over to the next claimant');
	tasks = deriveTasks([mk(1, 1000, owner, 'task.claimed'), mk(2, 2000, owner, 'task.released')]);
	assert.equal(tasks.get('t').status, 'open');
	tasks = deriveTasks([mk(1, 1000, owner, 'task.claimed'), mk(2, 2000, human, 'task.released')]);
	assert.equal(tasks.get('t').owner, null, 'a human can free an abandoned claim');
});

test('unknown keys are rejected at every level, matching the JSON Schema (additionalProperties: false)', async () => {
	const dir = await tmp();
	await assert.rejects(append({ type: 'note', summary: 'x', actor: { ...A, unexpected: 1 } }, { dir }), /unknown.*actor/i);
	await assert.rejects(append({ type: 'note', summary: 'x', actor: A, refs: [{ kind: 'file', ref: 'r', extra: 1 }] }, { dir }), /unknown.*refs\[0\]/i);
	const good = await append({ type: 'note', summary: 'x', actor: A }, { dir });
	const forged = { ...good, surprise: true };
	forged.hash = hashEvent(forged);
	assert.match(validate(forged).join(), /unknown.*field/i);
	assert.equal((await readAll({ dir })).length, 1);
});

test('ts must be a real calendar date in the exact ISO format (Date.parse alone accepts 2026-02-31)', async () => {
	const dir = await tmp();
	const good = await append({ type: 'note', summary: 'x', actor: A }, { dir });
	for (const ts of ['2026-02-31T00:00:00.000Z', '2026-13-01T00:00:00.000Z', '2026-10-04T10:00:00Z', '2026-10-04', 'yesterday', '2026-10-04T10:00:00.000+01:00']) {
		const bad = { ...good, ts };
		bad.hash = hashEvent(bad);
		assert.match(validate(bad).join(), /ts must be/, ts);
	}
	assert.deepEqual(validate(good), []);
});

test('context digest honours the budget even when the fixed sections alone would not fit (regression: could exceed --max-chars)', () => {
	const now = Date.now();
	const events = [];
	for (let i = 0; i < 200; i++) {
		events.push({ v: 1, id: (now - 1000 + i).toString(16).padStart(12, '0') + '-0000000000', ts: new Date(now - 1000 + i).toISOString(), project: 'p', type: 'task.created', task: `task-${i}`, summary: 'long title '.repeat(40), actor: A });
	}
	for (const maxChars of [400, 1500, 6000]) {
		const out = buildContext(events, { maxChars, now });
		assert.ok(out.length <= maxChars, `maxChars ${maxChars}: got ${out.length}`);
	}
	const big = buildContext(events, { maxChars: 6000, now });
	assert.match(big, /\+175 more open tasks/);
});

test('CLI tail --n: zero returns nothing, invalid is an error (regression: slice(-0) returned the whole ledger)', async () => {
	const dir = await tmp();
	const env = { ...process.env, LEDGER_DIR: dir, LEDGER_ACTOR: 'claude-code', LEDGER_HOST: 'cloud' };
	for (let i = 0; i < 3; i++) await run('node', [CLI, 'append', '--type', 'note', '--summary', `n${i}`], { env });
	const out = (args) => run('node', [CLI, 'tail', '--json', ...args], { env }).then((r) => JSON.parse(r.stdout));
	assert.equal((await out(['--n', '0'])).length, 0);
	assert.equal((await out(['--n', '2'])).length, 2);
	assert.equal((await out([])).length, 3);
	await assert.rejects(run('node', [CLI, 'tail', '--n', 'abc'], { env }), /non-negative integer/);
	await assert.rejects(run('node', [CLI, 'tail', '--n=-1'], { env }), /non-negative integer/);
	await assert.rejects(run('node', [CLI, 'tail', '--n', '-1'], { env }), (e) => /ambiguous/.test(e.stderr) && !/at .*node:internal/.test(e.stderr)); // clean message, no stack trace
});

test('schema requires non-empty strings wherever validate() does', () => {
	const s = schema();
	assert.equal(s.properties.refs.items.properties.ref.minLength, 1);
	assert.equal(s.properties.refs.items.properties.note.minLength, 1);
	for (const k of ['model', 'host', 'session']) assert.equal(s.properties.actor.properties[k].minLength, 1);
});

test('filters and since parsing', async () => {
	const dir = await tmp();
	await append({ type: 'note', summary: 'old', actor: A }, { dir, now: new Date('2026-01-01T00:00:00Z') });
	await append({ type: 'decision', summary: 'new', task: 'x', actor: B }, { dir });
	const all = await readAll({ dir });
	assert.equal(filterEvents(all, { actor: 'claude-code' }).length, 1);
	assert.equal(filterEvents(all, { type: 'decision' }).length, 1);
	assert.equal(filterEvents(all, { since: '1d' }).length, 1);
	assert.equal(filterEvents(all, { task: 'x' })[0].summary, 'new');
	assert.throws(() => parseSince('soon'), /cannot parse/);
});

test('canonical JSON and hash are key-order independent', () => {
	assert.equal(canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), canonical({ a: [2, { c: 2, d: 1 }], b: 1 }));
	assert.equal(hashEvent({ a: 1, b: 2, hash: 'x' }), hashEvent({ b: 2, a: 1 }));
});

test('committed JSON Schema is in sync with the code', () => {
	const file = path.join(here, '..', '..', 'ledger', 'schema', 'event.v1.schema.json');
	assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), JSON.parse(JSON.stringify(schema())),
		'run: node tools/ledger/cli.mjs schema > ledger/schema/event.v1.schema.json');
});

test('the repo ledger itself verifies', async () => {
	const r = await verify({ dir: path.join(here, '..', '..', 'ledger') });
	assert.equal(r.ok, true, r.problems.join('\n'));
});

// ---- review round 3 regressions

async function plantLock(dir, actor, info) {
	const file = shardPath(dir, actor);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file + '.lock', typeof info === 'string' ? info : JSON.stringify(info));
	return file + '.lock';
}
const deadPid = () => { const r = spawnSync(process.execPath, ['-e', '']); return r.pid; };

test('lock: a live owner is never robbed, even when the lock is old; waiting times out cleanly', async () => {
	const dir = await tmp();
	const lock = await plantLock(dir, A, { pid: process.pid, host: hostname(), token: 'x', t: Date.now() - 60000 });
	await assert.rejects(append({ type: 'note', summary: 'n', actor: A }, { dir, lockTimeoutMs: 200 }), /timed out waiting for lock/);
	assert.equal((await fs.readFile(lock, 'utf8')).includes('"token":"x"'), true, 'live owner lock must survive');
});

test('lock: a lock left by a dead process on this host is recovered at once', async () => {
	const dir = await tmp();
	await plantLock(dir, A, { pid: deadPid(), host: hostname(), token: 'dead', t: Date.now() });
	await append({ type: 'note', summary: 'n', actor: A }, { dir, lockTimeoutMs: 2000 });
	assert.equal((await verify({ dir })).ok, true);
});

test('lock: a lease-expired lock and an old unreadable lock are recovered; a fresh unreadable one is waited on', async () => {
	let dir = await tmp();
	await plantLock(dir, A, { pid: process.pid, host: 'some-other-host', token: 'old', t: Date.now() - 3600000 });
	await append({ type: 'note', summary: 'n', actor: A }, { dir, lockTimeoutMs: 2000 });
	dir = await tmp();
	const lock = await plantLock(dir, A, 'garbage');
	await assert.rejects(append({ type: 'note', summary: 'n', actor: A }, { dir, lockTimeoutMs: 150 }), /timed out/);
	const old = new Date(Date.now() - 120000);
	await fs.utimes(lock, old, old);
	await append({ type: 'note', summary: 'n', actor: A }, { dir, lockTimeoutMs: 2000 });
});

test('claims by different actors racing in separate processes: exactly one wins', async () => {
	const dir = await tmp();
	await append({ type: 'task.created', summary: 'contended', task: 'race', actor: A }, { dir });
	const claim = (name, i) => run('node', [CLI, 'append', '--type', 'task.claimed', '--summary', 'mine', '--task', 'race', '--actor', `${name}${i}`, '--host', `h${i}`],
		{ env: { ...process.env, LEDGER_DIR: dir } }).then(() => 'won', () => 'lost');
	const results = await Promise.all(Array.from({ length: 16 }, (_, i) => claim('racer', i)));
	assert.equal(results.filter((r) => r === 'won').length, 1, results.join(','));
	const t = deriveTasks(await readAll({ dir })).get('race');
	assert.equal(t.contested.length, 0);
	assert.equal((await verify({ dir })).ok, true);
});

test('claims by different actors racing in one process: exactly one wins (the interleaving that a per-shard lock alone does not stop)', async () => {
	const dir = await tmp();
	await append({ type: 'task.created', summary: 'contended', task: 'race2', actor: A }, { dir });
	const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
		append({ type: 'task.claimed', summary: 'mine', task: 'race2', actor: { kind: 'agent', name: `r${i}`, host: `h${i}` } }, { dir }).then(() => 'won', () => 'lost')));
	assert.equal(results.filter((r) => r === 'won').length, 1, results.join(','));
	assert.equal(deriveTasks(await readAll({ dir })).get('race2').contested.length, 0);
});

test('a completed task is terminal: no claim, progress, block or release is accepted or changes derived state', async () => {
	const dir = await tmp();
	await append({ type: 'task.created', summary: 'x', task: 'd', actor: A }, { dir });
	await append({ type: 'task.completed', summary: 'done', task: 'd', actor: A }, { dir });
	for (const type of ['task.claimed', 'task.progress', 'task.blocked', 'task.released']) {
		await assert.rejects(append({ type, summary: 'late', task: 'd', actor: B }, { dir }), /already completed/, type);
	}
	// events that arrive via sync after completion must not reopen it either
	const evs = await readAll({ dir });
	const late = { ...evs[1], id: 'ffffffffffff-0000000000', ts: '2999-01-01T00:00:00.000Z', type: 'task.claimed', actor: B };
	const t = deriveTasks([...evs, late]).get('d');
	assert.equal(t.status, 'done');
});

test('identities whose slugs collide still get separate shard files', async () => {
	const dir = await tmp();
	const x = { kind: 'agent', name: 'Claude Code', host: 'h', session: 's' }, y = { kind: 'agent', name: 'claude-code', host: 'h', session: 's' };
	assert.notEqual(shardPath(dir, x), shardPath(dir, y));
	await append({ type: 'note', summary: 'a', actor: x }, { dir });
	await append({ type: 'note', summary: 'b', actor: y }, { dir });
	const r = await verify({ dir });
	assert.equal(r.shards, 2);
	assert.equal(r.ok, true);
});

test('listShards surfaces I/O errors instead of reporting an empty ledger; stray files are ignored', async () => {
	const dir = await tmp();
	await fs.mkdir(path.join(dir, 'events'), { recursive: true });
	await fs.writeFile(path.join(dir, 'events', '.DS_Store'), '');
	assert.equal((await readAll({ dir })).length, 0);
	await fs.mkdir(path.join(dir, 'events', '2026-10'));
	await fs.chmod(path.join(dir, 'events', '2026-10'), 0o000);
	if (process.getuid && process.getuid() !== 0) await assert.rejects(readAll({ dir }), /EACCES/);
	await fs.chmod(path.join(dir, 'events', '2026-10'), 0o755);
});

test('readAll merges shards by (ts, id) but never reorders a shard (backwards clock step)', async () => {
	const dir = await tmp();
	const base = Date.parse('2026-10-04T10:00:00.000Z');
	await append({ type: 'note', summary: 'a1', actor: A }, { dir, now: new Date(base + 5000) });
	await append({ type: 'note', summary: 'a2-skewed', actor: A }, { dir, now: new Date(base + 1000) }); // clock stepped back
	await append({ type: 'note', summary: 'b1', actor: B }, { dir, now: new Date(base + 3000) });
	const order = (await readAll({ dir })).map((e) => e.summary);
	assert.ok(order.indexOf('a1') < order.indexOf('a2-skewed'), order.join(','));
	assert.equal((await verify({ dir })).ok, true);
});

test('JSON Schema ts pattern agrees with isIsoUtc on every day over ~300 years and on impossible dates', () => {
	const re = new RegExp(TS_PATTERN);
	for (let d = Date.UTC(1900, 0, 1); d < Date.UTC(2200, 0, 1); d += 864e5) {
		const ts = new Date(d).toISOString();
		assert.equal(re.test(ts), true, ts);
		assert.equal(isIsoUtc(ts), true, ts);
	}
	for (const bad of ['2026-02-29T00:00:00.000Z', '2100-02-29T00:00:00.000Z', '2026-04-31T00:00:00.000Z', '2026-02-31T00:00:00.000Z', '2026-13-01T00:00:00.000Z',
		'2026-00-10T00:00:00.000Z', '2026-01-00T00:00:00.000Z', '2026-01-01T24:00:00.000Z', '2026-01-01T00:60:00.000Z', '2026-01-01T00:00:00Z']) {
		assert.equal(re.test(bad), false, bad);
		assert.equal(isIsoUtc(bad), false, bad);
	}
	for (const good of ['2024-02-29T00:00:00.000Z', '2000-02-29T12:00:00.000Z']) assert.equal(re.test(good), true, good);
});

test('a writer that claimed twice offline queues once: one release does not hand the task back to the same name', () => {
	const mk = (n, ts, actor, type) => ({ id: n.toString(16).padStart(12, '0') + '-0000000000', ts, type, task: 't', summary: 's', actor });
	const o = { kind: 'agent', name: 'owner' }, d = { kind: 'agent', name: 'dup' };
	const t = deriveTasks([mk(1, '2026-10-04T10:00:00.000Z', o, 'task.claimed'), mk(2, '2026-10-04T10:00:01.000Z', d, 'task.claimed'),
		mk(3, '2026-10-04T10:00:02.000Z', d, 'task.claimed'), mk(4, '2026-10-04T10:00:03.000Z', o, 'task.released'),
		mk(5, '2026-10-04T10:00:04.000Z', d, 'task.released')]).get('t');
	assert.equal(t.owner, null);
	assert.equal(t.status, 'open');
});
