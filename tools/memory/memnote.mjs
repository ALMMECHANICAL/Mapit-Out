#!/usr/bin/env node
// memnote - file and read cross-device session notes in the private memory repo.
// Design: docs/mapitout/memory/DESIGN.md, decision: docs/mapitout/adr/0007-*.md
// Zero dependencies (Node >= 18). Reuses the ledger's secret scanner.
//
//   memnote init <dir> [--git]                create the memory repo skeleton
//   memnote template [--project p] [--surface s] [--actor a] [--device d]
//   memnote save [--repo dir] [--commit] [--push] [--dry-run] [file]    (reads stdin if no file)
//   memnote check [file]                      validate a note without saving
//   memnote latest [--repo dir] [--project p] [--n 5] [--max-chars 4000]  digest to paste at session start
//   memnote index [--repo dir]                regenerate index.md
//
// Repo dir: --repo, or MEMORY_REPO, or ./ (must contain inbox/ after init).

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { findSecrets, slug } from '../ledger/ledger.mjs';

export const SURFACES = ['terminal', 'desktop', 'cloud', 'local-model', 'web', 'mobile', 'other'];
export const REQUIRED = ['date', 'device', 'surface', 'actor', 'project'];
export const SECTIONS = ['Decisions', 'Ideas', 'Open questions', 'Next actions', 'Links'];
// Hint lines emitted by template(); a note that still contains them was saved unfilled.
const PLACEHOLDERS = ['(what was decided and why; link ADRs and ledger event ids)', '(unfiltered; mark half-formed ones)'];
export const LIMITS = { warnBytes: 4096, maxBytes: 16384 };

// ---------------------------------------------------------------- parsing

// Pasted text often arrives wrapped in a code fence, with CRLF line endings, or with stray blank lines.
export function clean(text) {
	let t = String(text).replace(/\r\n?/g, '\n').trim();
	const m = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(t);
	if (m) t = m[1].trim();
	return t + '\n';
}

// Minimal front matter: `key: value` lines between two `---` fences. No nesting, no lists.
export function parseNote(text) {
	const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
	if (!m) return { meta: null, body: text };
	const meta = {};
	for (const line of m[1].split('\n')) {
		const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
		if (kv) meta[kv[1]] = kv[2].trim();
	}
	return { meta, body: m[2] };
}

// Date.parse accepts 2026-02-31 and rolls it into March, so check the parts survive a round trip.
export function isRealDate(s) {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
	if (!m) return false;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const t = new Date(Date.UTC(y, mo - 1, d));
	return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

export function validateNote(text) {
	const errors = [], warnings = [];
	const bytes = Buffer.byteLength(text);
	if (bytes > LIMITS.maxBytes) errors.push(`note is ${bytes} bytes (max ${LIMITS.maxBytes}); did you paste the whole chat instead of the summary?`);
	else if (bytes > LIMITS.warnBytes) warnings.push(`note is ${bytes} bytes; aim for under ${LIMITS.warnBytes}`);

	const { meta, body } = parseNote(text);
	if (!meta) errors.push('missing front matter (--- fences with date, device, surface, actor, project)');
	else {
		for (const k of REQUIRED) if (!meta[k]) errors.push(`front matter missing "${k}"`);
		if (meta.date && !isRealDate(meta.date)) errors.push('date must be a real calendar date, YYYY-MM-DD');
		if (meta.surface && !SURFACES.includes(meta.surface)) errors.push(`surface must be one of: ${SURFACES.join(', ')}`);
		for (const k of ['device', 'actor', 'project']) if (meta[k] && meta[k].length > 80) errors.push(`${k} too long`);
		for (const [k, val] of Object.entries(meta)) {
			if (/[<>]/.test(val) || val === '...' || /^YYYY/i.test(val)) errors.push(`front matter "${k}" still holds placeholder text (${val}); fill it in`);
		}
	}
	const headings = [...body.matchAll(/^##\s+(.+?)\s*$/gm)].map((h) => h[1].replace(/\s*\(.*\)$/, '').trim().toLowerCase());
	if (!SECTIONS.some((s) => headings.includes(s.toLowerCase()))) warnings.push(`no recognised sections (${SECTIONS.join(', ')})`);
	if (body.replace(/^##.*$/gm, '').replace(/\s+/g, '').length < 20) warnings.push('note body is almost empty');

	if (PLACEHOLDERS.some((p) => body.includes(p))) errors.push('the template placeholder text is still in the note; replace or delete the (bracketed) hints');

	const secrets = findSecrets(text);
	if (secrets.length) errors.push(`possible secret detected (${secrets.join(', ')}); remove it before saving`);
	return { ok: errors.length === 0, errors, warnings, meta };
}

export function template({ project = 'general', surface = 'other', actor = 'unknown', device = hostname(), date = new Date().toISOString().slice(0, 10) } = {}) {
	return `---
date: ${date}
device: ${device}
surface: ${surface}
actor: ${actor}
project: ${project}
---
## Decisions
(what was decided and why; link ADRs and ledger event ids)

## Ideas
(unfiltered; mark half-formed ones)

## Open questions

## Next actions

## Links
`;
}

// ---------------------------------------------------------------- repo operations

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

// <date>-<HHMMSS>-<device>-<project>-<6 random hex>.md : the time and random part make a name clash between two
// independently synced clones practically impossible (a clash would be an add/add git conflict).
export function notePath(repo, meta, { now = new Date(), rand = () => randomBytes(3).toString('hex') } = {}) {
	const [y, m] = meta.date.split('-');
	const hms = now.toISOString().slice(11, 19).replace(/:/g, '');
	return path.join(repo, 'inbox', y, m, `${meta.date}-${hms}-${slug(meta.device)}-${slug(meta.project)}-${rand()}.md`);
}

async function uniquePath(file) {
	if (!(await exists(file))) return file;
	const base = file.replace(/\.md$/, '');
	for (let i = 2; i < 1000; i++) if (!(await exists(`${base}-${i}.md`))) return `${base}-${i}.md`;
	throw new Error('memnote: too many notes with the same name');
}

async function requireRepo(repo) {
	if (!(await exists(path.join(repo, 'inbox')))) throw new Error(`memnote: ${repo} is not a memory repo (no inbox/). Run: memnote init ${repo}`);
}

export async function save(text, { repo, commit = false, push = false, dryRun = false, now, rand } = {}) {
	const note = clean(text);
	const v = validateNote(note);
	if (!v.ok) { const e = new Error('memnote: note rejected:\n  - ' + v.errors.join('\n  - ')); e.problems = v; throw e; }
	await requireRepo(repo);
	const file = await uniquePath(notePath(repo, v.meta, { now, rand }));
	if (dryRun) return { file, warnings: v.warnings, written: false };
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, note, { flag: 'wx' });
	const result = { file, warnings: v.warnings, written: true, committed: false, pushed: false };
	if (commit || push) {
		const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
		try {
			git('add', '--', path.relative(repo, file));
			git('commit', '-m', `note: ${v.meta.project} ${v.meta.date} ${v.meta.device}`, '--', path.relative(repo, file));
			result.committed = true;
			if (push) { git('push'); result.pushed = true; }
		} catch (e) {
			result.gitError = String(e.stderr || e.message).trim();
		}
	}
	return result;
}

export async function listNotes(repo) {
	const root = path.join(repo, 'inbox');
	const out = [];
	const walk = async (dir) => {
		let ents;
		try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; } // a permission/I-O error must not look like "no notes"
		for (const ent of ents) {
			const p = path.join(dir, ent.name);
			if (ent.isDirectory()) await walk(p);
			else if (ent.name.endsWith('.md')) {
				const text = await fs.readFile(p, 'utf8');
				const { meta, body } = parseNote(text);
				if (meta && meta.date) out.push({ file: p, rel: path.relative(repo, p), meta, body });
			}
		}
	};
	await walk(root);
	return out.sort((a, b) => (a.meta.date + a.rel < b.meta.date + b.rel ? -1 : 1));
}

// Newest notes, budgeted in characters (small local models have small context windows).
export async function latest(repo, { project, n = 5, maxChars = 4000 } = {}) {
	if (!Number.isInteger(n) || n < 1) throw new Error('memnote: n must be a positive integer');
	if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('memnote: maxChars must be a positive integer');
	let notes = await listNotes(repo);
	const want = project && project.toLowerCase();
	if (want) notes = notes.filter((x) => { const p = String(x.meta.project).toLowerCase(); return p === want || p === 'general'; });
	notes = notes.slice(-n);
	const head = `# Recent session notes${project ? ` for ${project}` : ''} (${notes.length}, oldest first)\n`;
	const blocks = notes.map((x) => `\n## ${x.meta.date} - ${x.meta.project} - ${x.meta.actor} on ${x.meta.device} (${x.meta.surface})\n${x.body.trim()}\n`);
	let used = head.length, from = blocks.length;
	while (from > 0 && used + blocks[from - 1].length <= maxChars) { from--; used += blocks[from].length; }
	const msg = (k) => (k > 0 ? `\n(${k} older note(s) omitted to fit the ${maxChars}-character budget)\n` : '');
	let kept = blocks.slice(from).join(''), omitted = msg(from);
	if (!kept && blocks.length) { // even the newest note is over budget: keep its start rather than nothing
		omitted = msg(blocks.length - 1);
		const room = Math.max(0, maxChars - head.length - omitted.length - 40);
		kept = blocks[blocks.length - 1].slice(0, room).trimEnd() + '\n(newest note truncated to fit the budget)\n';
	}
	const out = head + omitted + kept;
	// hard limit: the header and omission note alone can exceed a very small budget
	return out.length > maxChars ? out.slice(0, maxChars) : out;
}

export async function buildIndex(repo, { max = 200 } = {}) {
	const notes = (await listNotes(repo)).reverse().slice(0, max);
	const rows = notes.map((x) => `| ${x.meta.date} | ${x.meta.project} | ${x.meta.device} | ${x.meta.actor} | [${path.basename(x.rel)}](${x.rel}) |`);
	return `# Index\n\nGenerated by \`memnote index\`; newest first, up to ${max} notes. Do not edit by hand.\n\n| Date | Project | Device | Actor | Note |\n|---|---|---|---|---|\n${rows.join('\n')}\n`;
}

export async function init(dir, { git = false } = {}) {
	await fs.mkdir(dir, { recursive: true });
	const files = {
		'README.md': `# Memory

PRIVATE repository. Session notes and curated knowledge for all projects and devices.
Design: Mapit-Out \`docs/mapitout/memory/DESIGN.md\`. Never commit secrets, passwords or customer data.

- \`inbox/YYYY/MM/\` raw end-of-session notes, one file per session (written by \`memnote save\`; never edited)
- \`projects/<project>/README.md\` current state per project: goal, status, next actions, links
- \`notes/\` curated knowledge
- \`registers/\` asset register and similar lists
- \`devices/README.md\` device roles and capabilities
- \`index.md\` generated: \`memnote index\`
`,
		'devices/README.md': '# Devices\n\nOne line per device: name, role, what it is good for (for example local models, media, storage). Private; keep credentials out.\n',
		'registers/README.md': '# Registers\n\nAsset register and similar lists. Add one file per register.\n',
		'projects/README.md': '# Projects\n\nOne folder per project with a README.md: goal, status, next actions, links.\n',
		'notes/README.md': '# Notes\n\nCurated, de-duplicated knowledge folded in from the inbox.\n',
		'inbox/.gitkeep': '',
		'.gitignore': '.DS_Store\n*.swp\n'
	};
	const created = [];
	for (const [rel, content] of Object.entries(files)) {
		const p = path.join(dir, rel);
		if (await exists(p)) continue;
		await fs.mkdir(path.dirname(p), { recursive: true });
		await fs.writeFile(p, content);
		created.push(rel);
	}
	if (git && !(await exists(path.join(dir, '.git')))) execFileSync('git', ['-C', dir, 'init', '-q']);
	return created;
}

// ---------------------------------------------------------------- CLI

async function readInput(file) {
	if (file) return fs.readFile(file, 'utf8');
	if (process.stdin.isTTY) throw new Error('memnote: paste the note on stdin (pipe or redirect), or pass a file');
	const chunks = [];
	for await (const c of process.stdin) chunks.push(c);
	return Buffer.concat(chunks).toString('utf8');
}

async function main() {
	let parsed;
	try { parsed = parseArgs({
		allowPositionals: true,
		options: {
			repo: { type: 'string' }, project: { type: 'string' }, surface: { type: 'string' }, actor: { type: 'string' }, device: { type: 'string' },
			n: { type: 'string' }, 'max-chars': { type: 'string' }, git: { type: 'boolean' },
			commit: { type: 'boolean' }, push: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' }
		}
	}); } catch (e) { throw new Error(`memnote: ${e.message}`); }
	const { values: v, positionals } = parsed;
	const [cmd, arg] = positionals;
	const repo = path.resolve(v.repo || process.env.MEMORY_REPO || '.');
	if (!cmd || v.help || cmd === 'help') {
		const self = fileURLToPath(import.meta.url);
		console.log((await fs.readFile(self, 'utf8')).split('\n').filter((l) => l.startsWith('//')).slice(0, 14).map((l) => l.slice(3)).join('\n'));
		return;
	}
	if (cmd === 'init') {
		if (!arg) throw new Error('usage: memnote init <dir> [--git]');
		const created = await init(path.resolve(arg), { git: v.git });
		console.log(created.length ? `created:\n  ${created.join('\n  ')}` : 'nothing to create (already initialised)');
	} else if (cmd === 'template') {
		const opts = {};
		for (const k of ['project', 'surface', 'actor', 'device']) if (v[k]) opts[k] = v[k];
		process.stdout.write(template(opts));
	} else if (cmd === 'check') {
		const r = validateNote(clean(await readInput(arg)));
		r.warnings.forEach((w) => console.log('warning: ' + w));
		r.errors.forEach((e) => console.log('error: ' + e));
		console.log(r.ok ? 'OK' : 'REJECTED');
		process.exit(r.ok ? 0 : 2);
	} else if (cmd === 'save') {
		const r = await save(await readInput(arg), { repo, commit: v.commit, push: v.push, dryRun: v['dry-run'] });
		r.warnings.forEach((w) => console.log('warning: ' + w));
		console.log(r.written ? `saved ${path.relative(process.cwd(), r.file)}` : `would save ${path.relative(process.cwd(), r.file)} (dry run)`);
		if (r.committed) console.log('committed' + (r.pushed ? ' and pushed' : ''));
		if (r.gitError) { console.log('git problem (the note is saved; commit/push it yourself): ' + r.gitError); process.exit(3); }
		if (r.written && !r.committed) console.log(`next: git -C ${repo} add inbox && git -C ${repo} commit -m "note" && git -C ${repo} push`);
	} else if (cmd === 'latest') {
		await requireRepo(repo);
		const n = v.n === undefined ? 5 : Number(v.n);
		if (!Number.isInteger(n) || n < 1) throw new Error('memnote: --n must be a positive integer');
		const maxChars = v['max-chars'] === undefined ? 4000 : Number(v['max-chars']);
		if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('memnote: --max-chars must be a positive integer');
		process.stdout.write(await latest(repo, { project: v.project, n, maxChars }));
	} else if (cmd === 'index') {
		await requireRepo(repo);
		await fs.writeFile(path.join(repo, 'index.md'), await buildIndex(repo));
		console.log('wrote index.md');
	} else {
		throw new Error(`unknown command "${cmd}"`);
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	main().catch((e) => { console.error(e.message); process.exit(1); });
}
