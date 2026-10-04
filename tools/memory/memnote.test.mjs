import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, clean, init, latest, listNotes, parseNote, save, template, validateNote } from './memnote.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, 'memnote.mjs');
const tmp = () => fs.mkdtemp(path.join(tmpdir(), 'memnote-'));
const note = (o = {}) => `---
date: ${o.date || '2026-10-04'}
device: ${o.device || 'workstation'}
surface: ${o.surface || 'terminal'}
actor: ${o.actor || 'claude-code'}
project: ${o.project || 'mapitout'}
---
## Decisions
${o.body || 'Chose per-session notes in a private repo because sessions on different devices lose context.'}

## Next actions
Create the repo and save the first note.
`;
async function repo() { const d = await tmp(); await init(d); return d; }

test('clean strips a pasted code fence, CRLF and stray blank lines', () => {
	assert.equal(clean('```markdown\r\n---\r\na: b\r\n---\r\nhi\r\n```\r\n\r\n'), '---\na: b\n---\nhi\n');
	assert.equal(clean('\n\n  plain  \n\n'), 'plain\n');
});

test('parseNote reads front matter and body', () => {
	const { meta, body } = parseNote(note());
	assert.equal(meta.project, 'mapitout');
	assert.equal(meta.surface, 'terminal');
	assert.match(body, /## Decisions/);
	assert.equal(parseNote('no front matter').meta, null);
});

test('validateNote accepts a good note and rejects each kind of bad one', () => {
	assert.equal(validateNote(note()).ok, true);
	assert.match(validateNote('just text, no front matter at all').errors.join(), /front matter/);
	assert.match(validateNote(note({ date: '2026-13-45' })).errors.join(), /date/);
	assert.match(validateNote(note({ date: 'yesterday' })).errors.join(), /date/);
	assert.match(validateNote(note({ surface: 'toaster' })).errors.join(), /surface/);
	assert.match(validateNote(note().replace('actor: claude-code\n', '')).errors.join(), /actor/);
	assert.match(validateNote(note({ body: 'my key is sk-abcdefghijklmnop1234567890' })).errors.join(), /secret/);
	assert.match(validateNote(note({ body: 'x'.repeat(17000) })).errors.join(), /bytes/);
	const warn = validateNote(note({ body: 'y'.repeat(5000) }));
	assert.equal(warn.ok, true);
	assert.match(warn.warnings.join(), /aim for under/);
});

test('front-matter placeholders left unfilled are rejected (regression: a literal "<project...>" project saved fine)', () => {
	for (const [k, v] of [['project', '<project name, or general>'], ['device', '<MY-DEVICE-NAME>'], ['actor', '<your tool or model name>'], ['date', 'YYYY-MM-DD']]) {
		const text = note().replace(new RegExp(`^${k}: .*$`, 'm'), `${k}: ${v}`);
		assert.equal(validateNote(text).ok, false, `${k}: ${v} should be rejected`);
	}
	assert.match(validateNote(note().replace('surface: terminal', 'surface: ...')).errors.join(), /placeholder|surface/);
});

test('CLI latest --n: zero is rejected, not "everything" (slice(-0) trap)', async () => {
	const d = await repo();
	await save(note(), { repo: d });
	const run = (args) => spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
	assert.equal(run(['latest', '--repo', d, '--n', '0']).status, 1);
	assert.equal(run(['latest', '--repo', d, '--n', 'x']).status, 1);
	assert.equal(run(['latest', '--repo', d, '--n', '1']).status, 0);
});

test('template validates once the placeholder text is replaced, and prefills fields', () => {
	const t = template({ project: 'quick-quote', surface: 'cloud', actor: 'someone', device: 'laptop', date: '2026-10-04' });
	assert.match(t, /project: quick-quote/);
	assert.match(t, /surface: cloud/);
	assert.equal(parseNote(t).meta.device, 'laptop');
	// an unfilled template must be refused, and accepted once the hints are replaced
	assert.match(validateNote(t).errors.join(), /placeholder/);
	const filled = t.replace('(what was decided and why; link ADRs and ledger event ids)', 'Use per-session notes in a private repo.').replace('(unfiltered; mark half-formed ones)', 'Maybe index the notes with a local model later.');
	assert.equal(validateNote(filled).ok, true, validateNote(filled).errors.join());
});

test('save files the note under inbox/YYYY/MM and never overwrites', async () => {
	const d = await repo();
	const a = await save(note(), { repo: d });
	assert.match(a.file, /inbox\/2026\/10\/2026-10-04-\d{6}-workstation-mapitout-[0-9a-f]{6}\.md$/);
	const b = await save(note(), { repo: d });
	assert.notEqual(a.file, b.file);
	// force an exact name clash (same clock and random value): the local collision check must still not overwrite
	const fixed = { now: new Date('2026-10-04T10:00:00Z'), rand: () => 'abcdef' };
	const c = await save(note(), { repo: d, ...fixed }), c2 = await save(note(), { repo: d, ...fixed });
	assert.match(c2.file, /-abcdef-2\.md$/);
	assert.equal((await listNotes(d)).length, 4);
	assert.equal(await fs.readFile(a.file, 'utf8'), clean(note()));
});

test('impossible calendar dates are rejected (regression: Date.parse normalised 2026-02-31 into March)', () => {
	for (const d of ['2026-02-31', '2026-04-31', '2025-02-29', '2026-00-10', '2026-13-01', '2026-01-00']) {
		assert.match(validateNote(note({ date: d })).errors.join(), /date/, d);
	}
	assert.equal(validateNote(note({ date: '2024-02-29' })).ok, true); // real leap day
	assert.equal(validateNote(note({ date: '2026-12-31' })).ok, true);
});

test('two sessions on the same device, project and day get different file names (so synced clones never collide)', async () => {
	const a = await repo(), b = await repo(); // independent clones that have not seen each other's notes
	const now = new Date('2026-10-04T10:00:00Z');
	const fa = (await save(note(), { repo: a, now, rand: () => 'aaaaaa' })).file, fb = (await save(note(), { repo: b, now, rand: () => 'bbbbbb' })).file;
	assert.notEqual(path.basename(fa), path.basename(fb));
	assert.match(path.basename(fa), /^2026-10-04-\d{6}-workstation-mapitout-[0-9a-f]{6}\.md$/);
});

test('save accepts a fenced paste, supports dry run, and refuses secrets, bad notes and non-repos', async () => {
	const d = await repo();
	const dry = await save('```md\n' + note() + '```', { repo: d, dryRun: true });
	assert.equal(dry.written, false);
	assert.equal((await listNotes(d)).length, 0);
	await save('```md\n' + note() + '```', { repo: d });
	assert.equal((await listNotes(d)).length, 1);
	await assert.rejects(save(note({ body: 'token ghp_abcdefghijklmnopqrstuvwx' }), { repo: d }), /secret/);
	await assert.rejects(save('nope', { repo: d }), /rejected/);
	await assert.rejects(save(note(), { repo: await tmp() }), /not a memory repo/);
	assert.equal((await listNotes(d)).length, 1);
});

test('save --commit creates a commit in a real git repo; a git failure leaves the note saved', async () => {
	const d = await tmp();
	await init(d, { git: true });
	process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 't';
	process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@example.invalid';
	const r = await save(note(), { repo: d, commit: true });
	assert.equal(r.committed, true);
	assert.match(execFileSync('git', ['-C', d, 'log', '--oneline'], { encoding: 'utf8' }), /note: mapitout 2026-10-04 workstation/);
	// push with no remote fails: note must stay saved and committed, error reported
	const p = await save(note({ date: '2026-10-05' }), { repo: d, commit: true, push: true });
	assert.equal(p.written, true);
	assert.equal(p.committed, true);
	assert.equal(p.pushed, false);
	assert.ok(p.gitError);
	// not a git repo: saved, error reported
	const plain = await repo();
	const g = await save(note(), { repo: plain, commit: true });
	assert.equal(g.written, true);
	assert.ok(g.gitError);
});

test('latest returns newest notes oldest-first, filters by project (keeping general), and respects the budget', async () => {
	const d = await repo();
	for (let i = 1; i <= 6; i++) await save(note({ date: `2026-10-0${i}`, body: `decision number ${i} ${'pad '.repeat(40)}` }), { repo: d });
	await save(note({ date: '2026-10-07', project: 'other', body: 'belongs to another project' }), { repo: d });
	await save(note({ date: '2026-10-08', project: 'general', body: 'applies to everything' }), { repo: d });
	const all = await latest(d, { n: 3, maxChars: 100000 });
	assert.ok(all.indexOf('2026-10-07') < all.indexOf('2026-10-08'));
	assert.doesNotMatch(all, /decision number 5/);
	const proj = await latest(d, { project: 'mapitout', n: 10, maxChars: 100000 });
	assert.doesNotMatch(proj, /another project/);
	assert.match(proj, /applies to everything/);
	const small = await latest(d, { project: 'mapitout', n: 10, maxChars: 900 });
	assert.ok(small.length <= 900 + 200, `digest too large: ${small.length}`);
	assert.match(small, /older note\(s\) omitted/);
	assert.match(small, /applies to everything/); // newest kept
});

test('latest keeps the start of the newest note when even one note is over budget (regression: returned nothing)', async () => {
	const d = await repo();
	await save(note({ date: '2026-10-04', body: `START-MARKER ${'long text '.repeat(200)}END-MARKER` }), { repo: d });
	const out = await latest(d, { maxChars: 700 });
	assert.ok(out.length <= 700 + 80, `too large: ${out.length}`);
	assert.match(out, /START-MARKER/);
	assert.doesNotMatch(out, /END-MARKER/);
	assert.match(out, /truncated/);
	assert.doesNotMatch(out, /older note\(s\) omitted/); // the only note is shown (truncated), not omitted
});

test('index lists notes newest first; init is idempotent and does not clobber existing files', async () => {
	const d = await repo();
	await save(note({ date: '2026-10-01' }), { repo: d });
	await save(note({ date: '2026-10-03', project: 'quick-quote' }), { repo: d });
	const idx = await buildIndex(d);
	assert.ok(idx.indexOf('2026-10-03') < idx.indexOf('2026-10-01'));
	await fs.writeFile(path.join(d, 'README.md'), 'mine');
	assert.deepEqual(await init(d), []);
	assert.equal(await fs.readFile(path.join(d, 'README.md'), 'utf8'), 'mine');
});

test('CLI end to end: init, template, check, save from a pasted stdin, latest', async () => {
	const d = await tmp();
	const run = (args, input) => spawnSync('node', [CLI, ...args], { input, encoding: 'utf8' });
	assert.equal(run(['init', d]).status, 0);
	assert.match(run(['template', '--project', 'mapitout', '--surface', 'cloud']).stdout, /surface: cloud/);
	assert.equal(run(['check'], note()).status, 0);
	assert.equal(run(['check'], 'garbage').status, 2);
	const s = run(['save', '--repo', d], '```markdown\n' + note() + '```\n');
	assert.equal(s.status, 0, s.stderr);
	assert.match(s.stdout, /saved .*inbox\/2026\/10\//);
	const bad = run(['save', '--repo', d], 'no front matter');
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /rejected/);
	assert.match(run(['latest', '--repo', d, '--project', 'mapitout']).stdout, /Recent session notes/);
	assert.equal(run(['latest', '--repo', await tmp()]).status, 1);
});

test('listNotes surfaces I/O errors; a missing inbox is just empty (regression: every error looked like "no notes")', async () => {
	const d = await tmp();
	assert.equal((await listNotes(d)).length, 0);
	await fs.writeFile(path.join(d, 'inbox'), 'not a directory'); // ENOTDIR, which also fails as root unlike a chmod
	await assert.rejects(listNotes(d), /ENOTDIR/);
});

test('latest: hard maxChars cap, positive-integer checks, case-insensitive project (regressions)', async () => {
	const d = await repo();
	await save(note({ project: 'MapItOut', body: 'x'.repeat(500) }), { repo: d });
	assert.match(await latest(d, { project: 'mapitout', maxChars: 10000 }), /MapItOut/);
	for (const budget of [1, 20, 60, 120]) assert.ok((await latest(d, { maxChars: budget })).length <= budget, String(budget));
	await assert.rejects(latest(d, { maxChars: 0 }), /positive integer/);
	await assert.rejects(latest(d, { maxChars: 1.5 }), /positive integer/);
	await assert.rejects(latest(d, { n: 0 }), /positive integer/);
});

test('dates in years 0001-0099 are real dates (regression: Date.UTC maps them to 19xx)', () => {
	assert.deepEqual(validateNote(note({ date: '0050-01-01' })).errors.filter((e) => /date/.test(e)), []);
	assert.ok(validateNote(note({ date: '0050-02-30' })).errors.some((e) => /date/.test(e)));
});
