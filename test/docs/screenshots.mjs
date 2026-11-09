#!/usr/bin/env node
/**
 * Regenerates docs/images/*.png from a fresh demo (no translations yet) whose
 * SUPERTEXT_API_URL points at the stand-in API (stand-in.mjs). See docs/DEVELOPER.md.
 *
 *   DIRECTUS_URL=http://127.0.0.1:8055 \
 *   EDITOR_EMAIL=… EDITOR_PASSWORD=… ADMIN_EMAIL=… ADMIN_PASSWORD=… node screenshots.mjs
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const B = process.env.DIRECTUS_URL ?? 'http://127.0.0.1:8055';
const out = fileURLToPath(new URL('../../docs/images/', import.meta.url));
const need = (name) => process.env[name] ?? (() => { throw new Error(`Set ${name}`); })();

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

async function session(email, password) {
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, locale: 'en-US' });
	page.setDefaultTimeout(90_000); // slow machines: Directus and the stand-in share the CPU with the browser
	await page.goto(`${B}/admin/login`);
	await page.fill('input[type=email]', email);
	await page.fill('input[type=password]', password);
	await page.click('button[type=submit]');
	await page.waitForURL(/admin\/(?!login)/);
	return page;
}

/** Admin-only first-login prompts (license key, project owner): close them without choosing. */
async function dismissPrompts(page) {
	for (let i = 0; i < 3; i++) {
		await page.waitForTimeout(800);
		const skip = page.getByRole('button', { name: /^(Skip|Remind Later)$/ });
		if (!(await skip.count())) return;
		await skip.first().click();
	}
}

const shot = (locator, name, pad = 12) =>
	locator.screenshot({ path: out + name, animations: 'disabled' }).catch(async () => {
		throw new Error(`Screenshot ${name} failed`);
	});

/** Clip from the top of `top` to the bottom of `bottom` (same column), with padding. */
async function clip(page, top, bottom, name, pad = 16) {
	const a = await top.boundingBox();
	const b = await bottom.boundingBox();
	await page.screenshot({
		path: out + name,
		fullPage: true,
		clip: { x: a.x - pad, y: a.y - pad, width: Math.max(a.width, b.width) + 2 * pad, height: b.y + b.height - a.y + 2 * pad },
	});
}

/** The form field whose label is exactly `label`. */
const field = (page, label) => page.locator('.field').filter({ has: page.getByText(label, { exact: true }) }).last();

/** A collection page: its title bar and the table. */
async function listShot(page, name) {
	const table = page.locator('.layout-tabular').first();
	await table.waitFor();
	await page.waitForTimeout(500);
	const t = await table.boundingBox();
	await page.screenshot({ path: out + name, clip: { x: t.x - 1, y: 0, width: t.width + 2, height: t.y + t.height + 12 } });
}

const pickLanguage = async (page, name) => {
	await page.locator('.field').filter({ has: page.locator('text=Translations') }).getByText('English', { exact: true }).first().click();
	await page.waitForTimeout(400);
	await page.locator('.v-list-item, [role=menuitem], li').filter({ hasText: name }).first().click();
	await page.waitForTimeout(800);
};

// --- Editor -------------------------------------------------------------------------------
const editor = await session(need('EDITOR_EMAIL'), need('EDITOR_PASSWORD'));
await editor.goto(`${B}/admin/content/articles/1`);
const box = editor.locator('.supertext');
await box.locator('.targets').waitFor();
await shot(box, '01-translate-box.png');

await box.getByRole('button', { name: 'Translate' }).click();
await box.locator('.result').first().waitFor({ timeout: 180_000 });
await editor.waitForTimeout(500);
await clip(editor, box, field(editor, 'Translations'), '02-translated-form.png');

await pickLanguage(editor, 'Deutsch');
{
	// The app scrolls inside its main panel, so bring the field to the top of the viewport.
	await field(editor, 'Translations').evaluate((el) => el.scrollIntoView({ block: 'start' }));
	await editor.waitForTimeout(400);
	const t = await field(editor, 'Translations').boundingBox();
	const vh = editor.viewportSize().height;
	await editor.screenshot({ path: out + '03-german-result.png', clip: { x: t.x - 16, y: Math.max(0, t.y - 16), width: t.width + 32, height: Math.min(780, vh - Math.max(0, t.y - 16)) } });
}

await editor.keyboard.press('Control+s');
await editor.waitForTimeout(2500);
await editor.goto(`${B}/admin/content/articles/1`);
await box.locator('.targets').waitFor();
await editor.waitForTimeout(500);
await box.getByRole('button', { name: 'Translate' }).click();
const dialog = editor.locator('#dialog-outlet .v-card').filter({ hasText: 'Replace existing translations' });
await dialog.waitFor();
await editor.waitForTimeout(400);
await shot(dialog, '04-replace-warning.png');
await dialog.getByRole('button', { name: 'Cancel' }).click();

// Translation files: "Export for translation" and "Import translation" in the same box.
await box.getByRole('button', { name: 'Export for translation' }).click();
const exportDialog = editor.locator('#dialog-outlet .v-card').filter({ hasText: 'File format' });
await exportDialog.waitFor();
await editor.waitForTimeout(400);
await shot(exportDialog, '11-export-dialog.png');
await exportDialog.getByRole('button', { name: 'Cancel' }).click();
// The file the dialog downloads (fetched the same way) for French, with the stand-in's French
// for the segments without formatting; the others stay untranslated.
const xliff = await editor.evaluate(async (base) => {
	const r = await fetch(`${base}/auth/refresh`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'session' }) });
	const token = (await r.json()).data?.access_token;
	const file = await fetch(`${base}/supertext/export`, {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify({ collection: 'articles', item: 1, source: 'en-US', targets: ['fr-CH'], format: 'xliff' }),
	});
	return file.text();
}, B);
const french = JSON.parse(readFileSync(new URL('translations.json', import.meta.url), 'utf8'))['fr-CH'];
const xmlText = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const htmlText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const filled = xliff.replace(/<source>([^<]*)<\/source>/g, (all, text) => {
	const fr = french[htmlText(xmlText(text))];
	return fr && !fr.includes('<') ? `${all}<target>${xml(xmlText(fr))}</target>` : all;
});
const upload = join(tmpdir(), 'directus-1-fr-CH.xlf');
writeFileSync(upload, filled);
await box.getByRole('button', { name: 'Import translation' }).click();
const importDialog = editor.locator('#dialog-outlet .v-card').filter({ hasText: 'Translated file' });
await importDialog.waitFor();
await importDialog.locator('#supertext-file').setInputFiles(upload);
await importDialog.getByRole('button', { name: 'Import translation' }).click();
// French exists already: the same confirmation as for Translate.
const replace = editor.locator('#dialog-outlet .v-card').filter({ hasText: 'Replace existing translations' });
await replace.waitFor();
await replace.getByRole('button', { name: 'Replace' }).click();
await importDialog.locator('.summary').waitFor();
await editor.waitForTimeout(500);
await shot(importDialog, '12-import-summary.png');
await importDialog.getByRole('button', { name: 'Cancel' }).click();

await editor.goto(`${B}/admin/content/articles`);
await listShot(editor, '05-articles.png');

// --- Administrator ------------------------------------------------------------------------
const admin = await session(need('ADMIN_EMAIL'), need('ADMIN_PASSWORD'));
await dismissPrompts(admin);

await admin.goto(`${B}/admin/content/languages`);
await dismissPrompts(admin);
await listShot(admin, '06-languages.png');

await admin.goto(`${B}/admin/settings/data-model/articles/supertext`);
await admin.waitForTimeout(2000);
await dismissPrompts(admin);
await admin.getByText('Interface', { exact: true }).first().click();
const options = admin.getByText('Translations field', { exact: true }).first();
await options.waitFor();
await options.scrollIntoViewIfNeeded();
await admin.waitForTimeout(500);
{
	const top = await options.boundingBox();
	const end = await admin.getByText('Fields to translate', { exact: true }).first().boundingBox();
	await admin.screenshot({ path: out + '07-interface-options.png', clip: { x: top.x - 24, y: top.y - 24, width: 900, height: end.y - top.y + 124 } });
}

// A flow with the operation, to show its settings.
const token = await admin.evaluate(async (base) => {
	const r = await fetch(`${base}/auth/refresh`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'session' }) });
	return (await r.json()).data?.access_token ?? null;
}, B);
const api = (method, path, body) =>
	admin.evaluate(async ({ base, method, path, body, token }) => {
		const r = await fetch(base + path, { method, credentials: 'include', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
		return r.json();
	}, { base: B, method, path, body, token });
const flow = await api('POST', '/flows', { name: 'Translate with Supertext', icon: 'translate', status: 'active', trigger: 'manual', accountability: 'all', options: { collections: ['articles'], location: 'both', async: false } });
const op = await api('POST', '/operations', { flow: flow.data.id, key: 'supertext', name: 'Supertext: translate', type: 'supertext-translate-flow', position_x: 19, position_y: 1, options: { source: 'en-US', onlyMissing: false } });
await api('PATCH', `/flows/${flow.data.id}`, { operation: op.data.id });
await admin.goto(`${B}/admin/settings/flows/${flow.data.id}/${op.data.id}`);
await admin.waitForTimeout(2500);
await shot(admin.locator('.v-drawer, [role=dialog]').last(), '08-flow-operation.png');

// The Supertext module: configuration, API key check, Test connection, version reports, languages.
await admin.goto(`${B}/admin/supertext`);
await dismissPrompts(admin);
await admin.getByRole('button', { name: 'Test connection' }).click();
await admin.getByText('API key checked: the connection to Supertext works.').waitFor();
// The docs run against the stand-in; show the address users will see.
await admin.evaluate(() => {
	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
	for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent.includes('127.0.0.1')) n.textContent = 'https://api.supertext.com/v1/';
});
await admin.screenshot({ path: out + '09-supertext-module.png', clip: { x: 0, y: 0, width: 960, height: 760 } });

// The language rows: one combo box per Directus language, the tone where Supertext offers it.
{
	const heading = admin.locator('.supertext-module h2').filter({ hasText: 'Languages' });
	const save = admin.getByRole('button', { name: 'Save languages' });
	await heading.evaluate((el) => el.scrollIntoView({ block: 'start' }));
	await admin.waitForTimeout(400);
	const a = await heading.boundingBox();
	const b = await save.boundingBox();
	const table = await admin.locator('table.languages').boundingBox();
	await admin.screenshot({ path: out + '10-supertext-languages.png', clip: { x: table.x - 16, y: Math.max(0, a.y - 16), width: table.width + 32, height: b.y + b.height - a.y + 32 } });
}

await browser.close();
console.log(`Saved screenshots to ${out}`);
