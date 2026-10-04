import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
	append, buildContext, canonical, deriveTasks, filterEvents, findSecrets, hashEvent,
	parseSince, readAll, schema, shardPath, validate, verify
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
