import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, EDITOR, client, login, startDirectus, type Directus } from './directus.js';
import { startFakeSupertext, type FakeServer } from './fake-supertext-server.js';

/**
 * End to end against a real Directus 12 (SQLite) with the built bundle and the demo
 * setup hook. Supertext is a local fake that prefixes segments with "[<lang>] ".
 */
let directus: Directus;
let fake: FakeServer;
let admin: ReturnType<typeof client>;
let editor: ReturnType<typeof client>;

beforeAll(async () => {
	fake = await startFakeSupertext('it-key');
	directus = await startDirectus({
		// Pasted with the prefix Supertext shows: must still work.
		SUPERTEXT_API_KEY: 'Supertext-Auth-Key it-key',
		SUPERTEXT_API_URL: fake.url,
		SUPERTEXT_POLL_INTERVAL: '0.1',
		SUPERTEXT_REPORT_URL: `${fake.url.replace(/\/v1\/$/, '')}/report`,
	});
	admin = client(directus.url, await login(directus.url, ADMIN));
	editor = client(directus.url, await login(directus.url, EDITOR));
}, 120_000);

afterAll(async () => {
	await directus?.stop();
	await fake?.close();
});

const translationsOf = async (id: number) => {
	const { json } = await admin.get(`/items/articles/${id}?fields=translations.id,translations.languages_code,translations.title,translations.summary,translations.body`);
	return Object.fromEntries((json.data.translations as any[]).map((t) => [t.languages_code, t]));
};

describe('demo setup', () => {
	it('creates languages, sample articles and the accounts once', async () => {
		const { json } = await editor.get('/items/languages?fields=code&sort=code');
		expect(json.data.map((l: any) => l.code)).toEqual(['de-CH', 'en-US', 'fr-CH', 'it-CH']);
		const articles = await editor.get('/items/articles?fields=id');
		expect(articles.json.data).toHaveLength(2);
		expect(directus.log()).toMatch(/Created the administrator account from DEMO_ADMIN_EMAIL/);
		expect(directus.log()).not.toContain(ADMIN.password);
		expect(directus.log()).not.toContain(EDITOR.password);
	});
});

describe('/supertext/info', () => {
	it('lists languages, translatable fields and the default source', async () => {
		const { status, json } = await editor.get('/supertext/info?collection=articles&item=1');
		expect(status).toBe(200);
		expect(json.data.configured).toBe(true);
		expect(json.data.defaultSource).toBe('en-US');
		expect(json.data.fields).toEqual([
			{ field: 'title', kind: 'text' },
			{ field: 'summary', kind: 'text' },
			{ field: 'body', kind: 'html' },
		]);
		const en = json.data.languages.find((l: any) => l.code === 'en-US');
		expect(en).toMatchObject({ hasTranslation: true });
		expect(json.data.languages.find((l: any) => l.code === 'de-CH')).toMatchObject({ hasTranslation: false, id: null });
	});

	it('requires a signed-in user', async () => {
		const { status } = await client(directus.url).get('/supertext/info?collection=articles&item=1');
		expect(status).toBe(401);
	});
});

describe('/supertext/translate (item form)', () => {
	it('returns translations without saving them', async () => {
		const before = fake.uploads.length;
		const { status, json } = await editor.post('/supertext/translate', { collection: 'articles', item: 1, targets: ['de-CH', 'fr-CH'] });
		expect(status).toBe(200);
		expect(json.data.source).toBe('en-US');
		const de = json.data.results.find((r: any) => r.language === 'de-CH');
		expect(de).toMatchObject({ ok: true, id: null, created: true, saved: false, missing: [] });
		expect(de.values.title).toBe('[de-CH] Content that speaks every language');
		// Rich text: same structure, one segment per block, formatting kept.
		expect(de.values.body).toContain('<h2>[de-CH] Translate in one click</h2>');
		expect(de.values.body).toContain('<ul><li><p>[de-CH] Titles and summaries</p></li>');
		expect(de.values.body).toContain('<strong>Translate</strong>');
		expect(Object.keys(await translationsOf(1))).toEqual(['en-US']);

		const sent = fake.uploads.slice(before);
		expect(sent.map((u) => u.target).sort()).toEqual(['de-CH', 'fr-CH']);
		// Source as primary subtag; whole paragraphs with inline tags as one segment.
		expect(sent[0]!.source).toBe('en');
		expect(sent[0]!.html).toContain('<div data-st-id="3">Open an article, choose the languages and click <strong>Translate</strong>.');
	});

	it('reports a failed language and still returns the others', async () => {
		fake.failFor.add('it-CH');
		try {
			const { json } = await editor.post('/supertext/translate', { collection: 'articles', item: 1, targets: ['de-CH', 'it-CH'] });
			expect(json.data.results).toEqual([
				expect.objectContaining({ language: 'de-CH', ok: true }),
				expect.objectContaining({ language: 'it-CH', ok: false, code: 'translation_error' }),
			]);
		} finally {
			fake.failFor.clear();
		}
	});

	it('rejects unknown languages and missing source text', async () => {
		const unknown = await editor.post('/supertext/translate', { collection: 'articles', item: 1, targets: ['xx-XX'] });
		expect(unknown.status).toBe(400);
		expect(unknown.json.errors[0].message).toMatch(/Unknown language/);
		const noSource = await editor.post('/supertext/translate', { collection: 'articles', item: 1, source: 'fr-CH', targets: ['de-CH'] });
		expect(noSource.status).toBe(400);
		expect(noSource.json.errors[0].extensions.code).toBe('no_source');
	});

	it('refuses users who may not edit the item', async () => {
		// A user whose policy can only read articles.
		const policy = await admin.post('/policies', { name: 'Readers', app_access: true, admin_access: false, icon: 'visibility' });
		const policyId = policy.json.data.id;
		await admin.post('/permissions', [
			{ policy: policyId, collection: 'articles', action: 'read', fields: ['*'] },
			{ policy: policyId, collection: 'articles_translations', action: 'read', fields: ['*'] },
			{ policy: policyId, collection: 'languages', action: 'read', fields: ['*'] },
		]);
		const role = await admin.post('/roles', { name: 'Reader' });
		await admin.post('/access', { role: role.json.data.id, policy: policyId });
		await admin.post('/users', { email: 'reader@example.com', password: 'reader-pass-123', role: role.json.data.id, status: 'active' });
		const reader = client(directus.url, await login(directus.url, { email: 'reader@example.com', password: 'reader-pass-123' }));

		const before = fake.uploads.length;
		const { status, json } = await reader.post('/supertext/translate', { collection: 'articles', item: 1, targets: ['de-CH'] });
		expect(status).toBe(403);
		expect(json.errors[0].extensions.code).toBe('forbidden');
		expect(fake.uploads.length).toBe(before);
	});

	it('saves through the parent item when asked to', async () => {
		const { json } = await editor.post('/supertext/translate', { collection: 'articles', item: 2, targets: ['de-CH'], save: true });
		expect(json.data.results[0]).toMatchObject({ language: 'de-CH', ok: true, saved: true, created: true });
		const rows = await translationsOf(2);
		expect(rows['de-CH'].title).toBe('[de-CH] About Supertext');
		expect(rows['de-CH'].body).toContain('<blockquote><p>[de-CH] Good translation is invisible: readers simply understand.</p></blockquote>');

		// Again: the same row is updated, not duplicated.
		await editor.patch('/items/articles_translations/' + rows['en-US'].id, { title: 'About Supertext AG' });
		await editor.post('/supertext/translate', { collection: 'articles', item: 2, targets: ['de-CH'], save: true });
		const again = await translationsOf(2);
		expect(again['de-CH'].id).toBe(rows['de-CH'].id);
		expect(again['de-CH'].title).toBe('[de-CH] About Supertext AG');
		expect(Object.keys(again).sort()).toEqual(['de-CH', 'en-US']);
	});
});

describe('translation files', () => {
	it('exports an item as XLIFF and imports the translated file into form values', async () => {
		const token = await login(directus.url, EDITOR);
		const auth = { authorization: `Bearer ${token}` };
		const exported = await fetch(`${directus.url}/supertext/export`, {
			method: 'POST',
			headers: { ...auth, 'content-type': 'application/json' },
			body: JSON.stringify({ collection: 'articles', item: 2, source: 'en-US', targets: ['fr-CH'], format: 'xliff' }),
		});
		expect(exported.status).toBe(200);
		expect(exported.headers.get('content-type')).toMatch(/^application\/x-xliff\+xml/);
		expect(exported.headers.get('content-disposition')).toBe('attachment; filename="directus-2-fr-CH.xlf"');
		const xliff = await exported.text();
		expect(xliff).toContain('original="item:articles:2:translations:en-US:fr-CH"');
		const title = /<trans-unit id="title\.0"[^>]*>\s*<source>([^<]*)<\/source>/.exec(xliff)![1]!;
		const translated = xliff.replace(`<source>${title}</source>`, `<source>${title}</source><target>Titre traduit</target>`);
		const upload = (path: string, body: string) => fetch(`${directus.url}${path}`, { method: 'POST', headers: { ...auth, 'content-type': 'text/plain' }, body });
		const imported = await upload('/supertext/import?collection=articles&item=2', translated);
		expect(imported.status).toBe(200);
		const [job] = (await imported.json()).data.jobs;
		expect(job).toMatchObject({ ok: true, language: 'fr-CH', imported: 1, values: { title: 'Titre traduit' } });
		expect(job.counts.untranslated).toBeGreaterThan(0);
		// Nothing saved: the form applies the values and the editor saves.
		expect((await translationsOf(2))['fr-CH']?.title).not.toBe('Titre traduit');
		// The file of another item, and an invalid file.
		const other = (await (await upload('/supertext/import?collection=articles&item=1', translated)).json()).data.jobs[0];
		expect(other.error).toMatchObject({ code: 'other_item' });
		const invalid = await upload('/supertext/import?collection=articles&item=2', 'not a file');
		expect(invalid.status).toBe(400);
		expect((await invalid.json()).errors[0].extensions).toMatchObject({ code: 'invalid_file', key: 'files.error.invalid_file' });
		// Signed out: refused.
		const anonymous = await fetch(`${directus.url}/supertext/import?collection=articles&item=2`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: translated });
		expect(anonymous.status).toBe(401);
	});
});

describe('Flow operation', () => {
	const createFlow = async (flow: Record<string, unknown>, options: Record<string, unknown>) => {
		const created = await admin.post('/flows', { status: 'active', accountability: 'all', icon: 'translate', ...flow });
		const id = created.json.data.id;
		const op = await admin.post('/operations', { flow: id, key: 'supertext', name: 'Supertext', type: 'supertext-translate-flow', position_x: 19, position_y: 1, options });
		expect(op.status).toBe(200);
		await admin.patch(`/flows/${id}`, { operation: op.json.data.id });
		return id as string;
	};

	it('translates and saves the items of a manual trigger', async () => {
		const flow = await createFlow({ name: 'Translate (manual)', trigger: 'manual', options: { collections: ['articles'], location: 'both', async: false } }, { targets: ['fr-CH', 'it-CH'] });
		const { status, json } = await admin.post(`/flows/trigger/${flow}`, { collection: 'articles', keys: [1] });
		expect(status).toBe(200);
		expect(json.data ?? json).toEqual([{ item: 1, source: 'en-US', translated: ['fr-CH', 'it-CH'] }]);
		const rows = await translationsOf(1);
		expect(rows['fr-CH'].title).toBe('[fr-CH] Content that speaks every language');
		expect(rows['it-CH'].summary).toBe('[it-CH] How Supertext translates your Directus content while keeping its structure.');
	});

	it('translates on save without triggering itself again', async () => {
		await createFlow(
			{ name: 'Translate on save', trigger: 'event', options: { type: 'action', scope: ['items.create'], collections: ['articles'] } },
			{ onlyMissing: true },
		);
		const before = fake.uploads.length;
		const created = await editor.post('/items/articles', { status: 'draft', translations: [{ languages_code: { code: 'en-US' }, title: 'New article', summary: 'Fresh text.' }] });
		const id = created.json.data.id;
		for (let i = 0; i < 50 && Object.keys(await translationsOf(id)).length < 4; i++) await new Promise((r) => setTimeout(r, 200));
		const rows = await translationsOf(id);
		expect(Object.keys(rows).sort()).toEqual(['de-CH', 'en-US', 'fr-CH', 'it-CH']);
		expect(rows['de-CH'].title).toBe('[de-CH] New article');
		await new Promise((r) => setTimeout(r, 1500));
		expect(fake.uploads.length - before).toBe(3);
	});
});

describe('Commando Center', () => {
	it('answers the public ping with the challenge', async () => {
		const ok = await fetch(`${directus.url}/supertext/ping?challenge=abcdefghijklmnop1234`);
		expect(ok.status).toBe(200);
		expect(ok.headers.get('cache-control')).toBe('no-store');
		expect(await ok.json()).toEqual({ ok: true, plugin: 'Directus-Supertext-Translation', challenge: 'abcdefghijklmnop1234' });
		const bad = await fetch(`${directus.url}/supertext/ping?challenge=<script>`);
		expect(bad.status).toBe(400);
		expect(await bad.json()).toEqual({ ok: false });
	});

	it('checks the key and reports the installation', async () => {
		const test = await admin.post('/supertext/test', {});
		expect(test.json.data.check.status).toBe('ok');
		await admin.get('/supertext/status');
		const deadline = Date.now() + 10_000;
		while (!fake.reports.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
		const report = fake.reports[0];
		expect(report).toMatchObject({
			schema: 1,
			event: 'installed',
			site_url: directus.url,
			plugin: { name: 'Directus-Supertext-Translation' },
			system: { name: 'Directus', version: '12.6.1' },
			runtime: { name: 'Node.js' },
			api_key_configured: true,
			api_key_check: { status: 'ok', http_status: 200 },
			callback: { url: `${directus.url}/supertext/ping` },
		});
		expect(JSON.stringify(fake.reports)).not.toContain('it-key');
		const status = await admin.get('/supertext/status');
		expect(status.json.data.reports).toMatchObject({ enabled: true, check: { status: 'ok' } });
	});
});
