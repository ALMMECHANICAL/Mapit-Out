import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_VERSIONS, TOOLS, createHandler, readLines } from './mcp.mjs';
import { readAll, verify } from './ledger.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MCP = path.join(here, 'mcp.mjs');
const tmp = () => fs.mkdtemp(path.join(tmpdir(), 'ledger-mcp-'));
let nextId = 1;
const rpc = (method, params) => ({ jsonrpc: '2.0', id: nextId++, method, params });
const call = (name, args) => rpc('tools/call', { name, arguments: args });
const text = (res) => res.result.content[0].text;

async function server(extra = {}) {
	const dir = await tmp();
	const env = { LEDGER_DIR: dir, LEDGER_ACTOR: 'lmstudio-qwen', LEDGER_KIND: 'model', LEDGER_MODEL: 'qwen', LEDGER_HOST: 'laptop', LEDGER_SESSION: 's1', ...extra };
	return { dir, handle: createHandler({ env, dir }) };
}

test('initialize echoes each supported protocol version and falls back to the newest', async () => {
	const { handle } = await server();
	for (const v of SUPPORTED_VERSIONS) {
		const r = await handle(rpc('initialize', { protocolVersion: v, capabilities: {}, clientInfo: { name: 'c', version: '1' } }));
		assert.equal(r.result.protocolVersion, v);
		assert.deepEqual(Object.keys(r.result.capabilities), ['tools']);
	}
	assert.equal((await handle(rpc('initialize', { protocolVersion: '1999-01-01' }))).result.protocolVersion, SUPPORTED_VERSIONS[0]);
});

test('notifications get no response; ping works; unknown methods are -32601; malformed requests -32600', async () => {
	const { handle } = await server();
	assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
	assert.deepEqual((await handle(rpc('ping'))).result, {});
	assert.equal((await handle(rpc('resources/list'))).error.code, -32601);
	assert.equal((await handle({ foo: 1 })).error.code, -32600);
	assert.equal((await handle(null)).error.code, -32600);
});

test('every listed tool is callable and has a schema', async () => {
	const { handle } = await server();
	const list = (await handle(rpc('tools/list'))).result.tools;
	assert.deepEqual(list.map((t) => t.name), TOOLS.map((t) => t.name));
	for (const t of list) {
		assert.equal(t.inputSchema.type, 'object');
		if (t.name === 'ledger_append') continue; // needs arguments, covered below
		const r = await handle(call(t.name, {}));
		assert.equal(r.result.isError, false, `${t.name}: ${r.result && text(r)}`);
	}
});

test('append then read back through context, tasks and tail; verify stays OK', async () => {
	const { handle, dir } = await server();
	const a = await handle(call('ledger_append', { type: 'task.created', summary: 'Wire the adapter', task: 't1' }));
	assert.equal(a.result.isError, false, text(a));
	assert.match(text(a), /^ok [0-9a-f]{12}-[0-9a-f]{10} task\.created$/);
	await handle(call('ledger_append', { type: 'task.claimed', summary: 'taking it', task: 't1', refs: [{ kind: 'pr', ref: 'ALMMECHANICAL/Mapit-Out#3' }] }));
	assert.match(text(await handle(call('ledger_tasks', {}))), /#t1 \[claimed\] lmstudio-qwen - Wire the adapter/);
	assert.match(text(await handle(call('ledger_context', {}))), /Ledger context[\s\S]*Open tasks[\s\S]*#t1/);
	assert.match(text(await handle(call('ledger_tail', { n: 1 }))), /task\.claimed.*lmstudio-qwen #t1/);
	assert.match(text(await handle(call('ledger_verify', {}))), /^OK: 2 events/);
	const evs = await readAll({ dir });
	assert.deepEqual(evs[0].actor, { kind: 'model', name: 'lmstudio-qwen', model: 'qwen', host: 'laptop', session: 's1' });
});

test('identity comes from the environment: an actor argument is refused and cannot impersonate', async () => {
	const { handle, dir } = await server();
	const r = await handle(call('ledger_append', { type: 'note', summary: 'x', actor: { name: 'human-owner', kind: 'human' } }));
	assert.equal(r.error.code, -32602);
	assert.match(r.error.message, /unknown argument "actor"/);
	assert.equal((await readAll({ dir })).length, 0);
});

test('without LEDGER_ACTOR the actor is the MCP client name', async () => {
	const { handle, dir } = await server({ LEDGER_ACTOR: '' });
	await handle(rpc('initialize', { protocolVersion: SUPPORTED_VERSIONS[0], clientInfo: { name: 'LM Studio', version: '0.3' } }));
	await handle(call('ledger_append', { type: 'note', summary: 'hello' }));
	assert.equal((await readAll({ dir }))[0].actor.name, 'LM Studio');
});

test('secrets, bad types and task-rule violations come back as isError results, not crashes', async () => {
	const { handle, dir } = await server();
	const secret = await handle(call('ledger_append', { type: 'note', summary: 'key is sk-abcdefghijklmnopqrstuv' }));
	assert.equal(secret.result.isError, true);
	assert.match(text(secret), /possible secret/);
	assert.equal((await readAll({ dir })).length, 0);
	await handle(call('ledger_append', { type: 'task.claimed', summary: 'mine', task: 'x' }));
	const other = createHandler({ env: { LEDGER_DIR: dir, LEDGER_ACTOR: 'someone-else', LEDGER_HOST: 'h2' }, dir });
	const dup = await other(call('ledger_append', { type: 'task.claimed', summary: 'mine too', task: 'x' }));
	assert.equal(dup.result.isError, true);
	assert.match(text(dup), /already claimed by lmstudio-qwen/);
});

test('argument validation: missing, wrong type, out of range, unknown tool', async () => {
	const { handle } = await server();
	assert.match((await handle(call('ledger_append', { type: 'note' }))).error.message, /missing required argument "summary"/);
	assert.match((await handle(call('ledger_append', { type: 'nope', summary: 's' }))).error.message, /type must be one of/);
	assert.match((await handle(call('ledger_append', { type: 'note', summary: 'x'.repeat(501) }))).error.message, /too long/);
	assert.match((await handle(call('ledger_tail', { n: 0 }))).error.message, />= 1/);
	assert.match((await handle(call('ledger_context', { max_chars: 5 }))).error.message, />= 200/);
	assert.match((await handle(call('ledger_append', { type: 'note', summary: 's', refs: [{ kind: 'pr' }] }))).error.message, /missing required argument "refs\[0\]\.ref"|refs\[0\]/);
	assert.match((await handle(call('nope', {}))).error.message, /unknown tool/);
});

test('context honours max_chars as a hard limit', async () => {
	const { handle } = await server();
	for (let i = 0; i < 30; i++) await handle(call('ledger_append', { type: 'note', summary: `activity number ${i} ${'pad '.repeat(30)}` }));
	assert.ok(text(await handle(call('ledger_context', { max_chars: 800 }))).length <= 800);
});

// ---- end to end over real stdio

const children = new Set();
test.after(() => { for (const c of children) c.kill(); }); // never leave a server waiting on open stdin if a test fails early

function spawnServer(env, entry = MCP) {
	const child = spawn(process.execPath, [entry], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
	children.add(child);
	child.on('close', () => children.delete(child));
	const lines = [];
	let buf = '', waiter = null;
	child.stdout.on('data', (d) => {
		buf += d;
		let i;
		while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
		if (waiter) { const w = waiter; waiter = null; w(); }
	});
	const next = async (ms = 10000) => {
		const deadline = Date.now() + ms;
		while (!lines.length) {
			if (Date.now() > deadline) throw new Error('timed out waiting for a response from the MCP server');
			await new Promise((r) => { waiter = r; setTimeout(r, 100); });
		}
		return JSON.parse(lines.shift());
	};
	return { child, next, send: (m) => child.stdin.write((typeof m === 'string' ? m : JSON.stringify(m)) + '\n') };
}

test('stdio end to end: handshake, garbage line, oversize line, then a real append; stdout stays protocol-only', async () => {
	const dir = await tmp();
	const s = spawnServer({ LEDGER_DIR: dir, LEDGER_ACTOR: 'e2e', LEDGER_HOST: 'h', LEDGER_SESSION: 'x' });
	s.send(rpc('initialize', { protocolVersion: SUPPORTED_VERSIONS[1], clientInfo: { name: 'test' } }));
	assert.equal((await s.next()).result.protocolVersion, SUPPORTED_VERSIONS[1]);
	s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
	s.send('this is not json');
	assert.equal((await s.next()).error.code, -32700);
	s.send('{"jsonrpc":"2.0","id":99,"method":"ping","pad":"' + 'x'.repeat(1024 * 1024 + 10) + '"}');
	assert.equal((await s.next()).error.code, -32600);
	s.send(call('ledger_append', { type: 'note', summary: 'over stdio' }));
	const r = await s.next();
	assert.match(text(r), /^ok /);
	s.child.stdin.end();
	await new Promise((res) => s.child.on('close', res));
	assert.equal((await readAll({ dir })).length, 1);
});

test('several MCP servers on one ledger keep every chain valid', async () => {
	const dir = await tmp();
	const servers = Array.from({ length: 4 }, (_, i) => spawnServer({ LEDGER_DIR: dir, LEDGER_ACTOR: 'same', LEDGER_HOST: 'h', LEDGER_SESSION: 'shared' + (i % 2) }));
	await Promise.all(servers.map(async (s, i) => {
		for (let j = 0; j < 5; j++) { s.send(call('ledger_append', { type: 'note', summary: `s${i} m${j}` })); assert.match(text(await s.next()), /^ok /); }
		s.child.stdin.end();
		await new Promise((res) => s.child.on('close', res));
	}));
	const v = await verify({ dir });
	assert.equal(v.ok, true, v.problems.join('\n'));
	assert.equal(v.events, 20);
});

test('one multibyte request over 1 MiB is rejected by bytes even though it is under 1 MiB of characters, and the server recovers', async () => {
	const dir = await tmp();
	const s = spawnServer({ LEDGER_DIR: dir, LEDGER_ACTOR: 'e2e' });
	const big = '\u00e9'.repeat(600000); // 600k characters, 1.2 MB of UTF-8
	s.send(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping', params: { pad: big } }));
	assert.equal((await s.next()).error.code, -32600);
	s.send(rpc('ping'));
	assert.deepEqual((await s.next()).result, {});
	s.child.stdin.end();
});

test('the server starts when launched through a symlink (how npm installs a bin)', async () => {
	const dir = await tmp();
	const link = path.join(dir, 'ledger-mcp');
	await fs.symlink(MCP, link);
	const s = spawnServer({ LEDGER_DIR: dir, LEDGER_ACTOR: 'e2e' }, link);
	s.send(rpc('ping'));
	assert.deepEqual((await s.next()).result, {});
	s.child.stdin.end();
});

test('readLines: lines split across chunks and multibyte characters split across chunks; last line without newline', async () => {
	const bytes = Buffer.from('{"a":"\u00e9"}\n{"b":2}\nlast');
	const cut = bytes.indexOf(0xc3) + 1; // between the two bytes of the first multibyte character
	const out = [];
	for await (const l of readLines(Readable.from([bytes.subarray(0, cut), bytes.subarray(cut, cut + 5), bytes.subarray(cut + 5)]))) out.push(l);
	assert.deepEqual(out, ['{"a":"\u00e9"}', '{"b":2}', 'last']);
});

test('readLines: an oversized line is reported once, never buffered whole, and the next line is intact', async () => {
	const huge = Buffer.alloc(5000, 0x61);
	const chunks = [Buffer.from('ok1\n'), huge.subarray(0, 2000), huge.subarray(2000), Buffer.from('\nok2\n')];
	const out = [];
	for await (const l of readLines(Readable.from(chunks), 1000)) out.push(l);
	assert.deepEqual(out, ['ok1', null, 'ok2']);
});

test('arguments are checked as own properties: inherited names like constructor are unknown arguments', async () => {
	const { handle, dir } = await server();
	const r = await handle(call('ledger_append', JSON.parse('{"type":"note","summary":"x","constructor":{"a":1},"__proto__x":1}')));
	assert.equal(r.error.code, -32602);
	assert.match(r.error.message, /unknown argument/);
	assert.equal((await readAll({ dir })).length, 0);
	assert.match((await handle(call('ledger_tail', { toString: 1 }))).error.message, /unknown argument "toString"/);
});
