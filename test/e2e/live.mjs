#!/usr/bin/env node
/**
 * End-to-end test against the REAL Supertext API: a fresh demo (only the English sample
 * articles, nothing translated yet) with a real SUPERTEXT_API_KEY. The editor opens every
 * article in the Directus app, clicks Translate in the "Translate with Supertext" box for
 * all target languages and saves; then the data is checked through Directus's REST API (as
 * the editor): every article has exactly one row per target language, the fields are filled
 * and changed, no protocol leftovers, formatting, links and block structure kept, the text
 * is in the target language (de-CH without "ß"), the source row and the article status are
 * untouched, and translating again (with the replace warning) updates the same rows.
 * See "End-to-end tests" in docs/DEVELOPER.md.
 *
 *   DIRECTUS_URL=http://127.0.0.1:8081 EDITOR_EMAIL=… EDITOR_PASSWORD=… node test/e2e/live.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const B = (process.env.DIRECTUS_URL ?? 'http://127.0.0.1:8081').replace(/\/$/, '');
const SOURCE = process.env.E2E_SOURCE_LANGUAGE ?? 'en-US';
const need = (name) => process.env[name] || (() => { throw new Error(`Set ${name}`); })();
const artifacts = fileURLToPath(new URL('./artifacts/', import.meta.url));
mkdirSync(artifacts, { recursive: true });

const failures = [];
function check(name, ok, detail = '') {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
	return ok;
}

// Common words, to tell the target languages apart. Lower case, whole words.
const STOPWORDS = {
	en: ['the', 'and', 'is', 'are', 'with', 'for', 'you', 'your', 'our', 'of', 'to', 'we', 'who', 'what'],
	de: ['der', 'die', 'das', 'und', 'ist', 'sind', 'mit', 'für', 'sie', 'ihre', 'ihr', 'unser', 'unsere', 'wir', 'eine', 'ein', 'den', 'zu', 'von', 'was'],
	fr: ['le', 'les', 'et', 'est', 'sont', 'avec', 'pour', 'vous', 'votre', 'vos', 'notre', 'nos', 'nous', 'des', 'une', 'un', 'du', 'de', 'qui', 'que'],
	it: ['il', 'lo', 'gli', 'e', 'è', 'sono', 'con', 'per', 'lei', 'sua', 'suo', 'nostro', 'nostra', 'noi', 'una', 'un', 'del', 'della', 'di', 'che', 'chi'],
};
const words = (text) => text.toLowerCase().match(/[\p{L}]+/gu) ?? [];
const score = (text, lang) => words(text).filter((w) => STOPWORDS[lang].includes(w)).length;
/** Visible text of a field: HTML without tags and the common entities. */
const plain = (v) => String(v ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&[a-z]+;|&#\d+;/g, ' ');
const count = (haystack, needle) => String(haystack ?? '').split(needle).length - 1;
const hrefs = (html) => [...String(html ?? '').matchAll(/href="([^"]*)"/g)].map((m) => m[1]).sort().join(' ');

const FIELDS = ['title', 'summary', 'body'];
const LEFTOVERS = ['data-st-id', 'data-st-ph', 'st-ph-'];
// What the rich text of the sample articles has; each must survive the translation.
const MARKUP = [['links', '<a '], ['bold', '<strong'], ['italics', '<em'], ['headings', '<h2'], ['paragraphs', '<p'], ['list items', '<li'], ['quotes', '<blockquote']];

// --- REST API as the editor (for the checks) -----------------------------------------------
let token = null;
async function rest(path, init = {}) {
	const res = await fetch(B + path, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } });
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
	return body.data;
}
token = (await rest('/auth/login', { method: 'POST', body: JSON.stringify({ email: need('EDITOR_EMAIL'), password: need('EDITOR_PASSWORD') }) })).access_token;
const articlesNow = async () => rest('/items/articles?fields=id,status&sort=id&limit=-1');
const rowsNow = async () => rest('/items/articles_translations?fields=*&sort=id&limit=-1');

// --- Setup -------------------------------------------------------------------------------
const languages = await rest('/items/languages?fields=code,name&limit=-1');
const targets = languages.map((l) => l.code).filter((c) => c !== SOURCE);
const articles = await articlesNow();
const sourceRows = await rowsNow();
console.log(`Demo: ${articles.length} articles, languages ${languages.map((l) => l.code).join(', ')} (source ${SOURCE})`);
check('demo has target languages', targets.length > 0);
check('demo has sample articles', articles.length > 0);
check('fresh demo (only source rows)', sourceRows.every((r) => r.languages_code === SOURCE), `${sourceRows.length} rows`);
const source = new Map(sourceRows.filter((r) => r.languages_code === SOURCE).map((r) => [r.articles_id, r]));
check('every sample article has source text', articles.every((a) => source.has(a.id)));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, locale: 'en-US' });
page.setDefaultTimeout(30_000);

// --- Log in as the editor ----------------------------------------------------------------
await page.goto(`${B}/admin/login`);
await page.fill('input[type=email]', need('EDITOR_EMAIL'));
await page.fill('input[type=password]', need('EDITOR_PASSWORD'));
await page.click('button[type=submit]');
const loggedIn = await page.waitForURL(/admin\/(?!login)/).then(() => true, () => false);
if (!check('editor can log in (DEMO_EDITOR_*)', loggedIn)) {
	await page.screenshot({ path: `${artifacts}login.png` });
	await browser.close();
	throw new Error(failures.join('\n'));
}

/** Translates one article in the item form into every target language and saves it. */
async function translateArticle(id, label, replacing) {
	const tag = `${label}: article ${id}`;
	await page.goto(`${B}/admin/content/articles/${id}`);
	const box = page.locator('.supertext');
	await box.locator('.targets').waitFor();
	await page.waitForTimeout(500);
	const boxErrors = await box.locator('.v-notice.danger').allTextContents();
	check(`${tag}: translate box without errors`, boxErrors.length === 0, boxErrors.join(' | '));
	const offered = await box.locator('.target').allTextContents();
	for (const code of targets) check(`${tag}: ${code} offered`, offered.some((t) => t.includes(`(${code})`)));
	if (replacing) {
		const warned = await box.locator('.existing').count();
		check(`${tag}: every language marked "will be replaced"`, warned === targets.length, `${warned}/${targets.length}`);
	}

	const answer = page.waitForResponse((r) => r.url().includes('/supertext/translate') && r.request().method() === 'POST', { timeout: 900_000 });
	await box.getByRole('button', { name: 'Translate' }).click();
	if (replacing) {
		const dialog = page.locator('#dialog-outlet .v-card').filter({ hasText: 'Replace existing translations' });
		if (check(`${tag}: replace warning shown`, await dialog.waitFor().then(() => true, () => false))) {
			await dialog.getByRole('button', { name: 'Replace' }).click();
		}
	}
	const started = Date.now();
	const res = await answer;
	const results = (await res.json().catch(() => ({})))?.data?.results ?? [];
	console.log(`${tag}: ${Math.round((Date.now() - started) / 1000)} s, HTTP ${res.status()}`);
	check(`${tag}: translate request succeeded`, res.ok(), `HTTP ${res.status()}`);
	for (const code of targets) {
		const r = results.find((x) => x.language === code);
		check(`${tag}: ${code} translated`, !!r?.ok, r ? (r.error ?? '') : 'no result');
		if (r?.ok && r.missing?.length) check(`${tag}: ${code} complete (no missing segments)`, false, r.missing.join(', '));
	}
	await box.locator('.result').first().waitFor();
	await page.waitForTimeout(300);
	const notices = (await box.locator('.result').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
	const errors = notices.filter((t) => !t.startsWith('Translated into'));
	check(`${tag}: success shown, no error in the box`, notices.length > 0 && errors.length === 0, errors.join(' | '));
	await page.screenshot({ path: `${artifacts}${label}-article-${id}.png`, fullPage: true });

	// Save the form (Ctrl+S = save and stay), like an editor reviewing and saving.
	const saved = page.waitForResponse((r) => new URL(r.url()).pathname === `/items/articles/${id}` && r.request().method() === 'PATCH', { timeout: 60_000 });
	await page.keyboard.press('Control+s');
	const save = await saved.catch(() => null);
	check(`${tag}: saved`, !!save?.ok(), save ? `HTTP ${save.status()}` : 'no save request');
	await page.waitForTimeout(1000);
	const alerts = await page.locator('.notification-item.error, .notification-item.danger, .v-notification.danger').allTextContents();
	check(`${tag}: no error notification`, alerts.length === 0, alerts.join(' | '));
}

// --- First translation -------------------------------------------------------------------
for (const a of articles) await translateArticle(a.id, 'first-run', false);
const firstRows = await rowsNow();

for (const code of targets) {
	const lang = code.split(/[-_]/)[0].toLowerCase();
	let fields = 0;
	let changed = 0;
	let text = '';
	for (const a of articles) {
		const s = source.get(a.id);
		const rows = firstRows.filter((r) => r.articles_id === a.id && r.languages_code === code);
		const tag = `${code}: article ${a.id}`;
		if (!check(`${tag}: exactly one translation row`, rows.length === 1, `${rows.length}`)) continue;
		const t = rows[0];
		for (const f of FIELDS) {
			if (!s?.[f] || !plain(s[f]).trim()) continue;
			fields++;
			const v = String(t[f] ?? '');
			if (!check(`${tag}: ${f} filled`, plain(v).trim() !== '')) continue;
			if (v !== String(s[f])) changed++;
			else console.log(`note ${tag}: ${f} unchanged ("${plain(v).trim().slice(0, 60)}")`);
			text += ` ${plain(v)}`;
			const left = LEFTOVERS.filter((l) => v.includes(l));
			check(`${tag}: ${f} has no protocol leftovers`, left.length === 0, left.join(', '));
			for (const [what, needle] of MARKUP) {
				if (count(s[f], needle)) check(`${tag}: ${f} keeps its ${what}`, count(v, needle) === count(s[f], needle), `${count(v, needle)}/${count(s[f], needle)}`);
			}
			if (hrefs(s[f])) check(`${tag}: ${f} keeps the link targets`, hrefs(v) === hrefs(s[f]), hrefs(v));
		}
	}
	check(`${code}: texts were changed by the translation`, fields > 0 && changed / fields >= 0.8, `${changed}/${fields} fields`);
	if (STOPWORDS[lang]) {
		const scores = Object.fromEntries(Object.keys(STOPWORDS).map((l) => [l, score(text, l)]));
		const best = Object.entries(scores).sort((x, y) => y[1] - x[1])[0][0];
		check(`${code}: text is in the target language`, best === lang, JSON.stringify(scores));
	}
	if (/^de-ch$/i.test(code)) check(`${code}: Swiss German spelling (no "ß")`, !text.includes('ß'));
}

// The plugin only fills translation rows: the source text and the article status stay as they were.
const after = await articlesNow();
for (const a of articles) {
	const now = after.find((x) => x.id === a.id);
	check(`article ${a.id}: status unchanged (${a.status})`, now?.status === a.status, now?.status);
	const s = source.get(a.id);
	const sNow = firstRows.find((r) => r.id === s.id);
	check(`article ${a.id}: source text unchanged`, !!sNow && FIELDS.every((f) => sNow[f] === s[f]));
}

// --- Translating again updates in place ---------------------------------------------------
for (const a of articles) await translateArticle(a.id, 'second-run', true);
const secondRows = await rowsNow();
const ids = (rows) => rows.map((r) => `${r.articles_id}/${r.languages_code}#${r.id}`).sort().join(',');
check('translating again updates the same rows (no duplicates)', ids(firstRows) === ids(secondRows), `${firstRows.length} → ${secondRows.length} rows`);

await browser.close();

if (failures.length) {
	console.error(`\n${failures.length} check(s) failed:\n- ${failures.join('\n- ')}`);
	process.exit(1);
}
console.log('\nAll end-to-end checks passed.');
