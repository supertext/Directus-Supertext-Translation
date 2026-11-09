import { describe, expect, it } from 'vitest';
import { TranslationFiles } from 'supertext-sdk';
import { buildExport, collectSegments, formatReference, importJobs, MAX_UPLOAD_BYTES, parseReference, PLUGIN, readBody, type ImportTarget } from '../src/api/files.js';
import { TranslateError, type TranslatableField } from '../src/api/translator.js';

const fields: TranslatableField[] = [
	{ field: 'title', kind: 'text' },
	{ field: 'body', kind: 'html' },
];
const row = () => ({ title: 'Fish & chips', body: '<p>One <strong>bold</strong></p><p>Two</p>' });
const ref = { collection: 'articles', item: '12', field: 'translations', source: 'en-US', target: 'de-DE' };

const exportXliff = (source = row(), targets = ['de-DE']) =>
	buildExport({ collection: 'articles', item: '12', field: 'translations', source: 'en-US', targets, format: 'xliff', collected: collectSegments(fields, source) }).content;

/** Puts a <target> into the trans-unit `id` of an exported XLIFF file. */
const withTarget = (xliff: string, id: string, target: string) =>
	xliff.replace(new RegExp(`(<trans-unit id="${id.replace('.', '\\.')}"[^>]*>\\s*<source>[\\s\\S]*?</source>)`), `$1<target>${target}</target>`);

/** The item form's item 12 with its current source row; `ids` of existing translation rows. */
const target = (current = row(), languages = ['en-US', 'de-DE', 'fr-FR'], ids: Record<string, number | null> = { 'de-DE': 7 }): ImportTarget => ({
	collection: 'articles',
	item: '12',
	field: 'translations',
	load: async () => ({ languages: new Set(languages), collected: collectSegments(fields, current), ids }),
});

describe('reference', () => {
	it('round-trips, also with colons in the key, and refuses anything else', () => {
		expect(formatReference(ref)).toBe('item:articles:12:translations:en-US:de-DE');
		expect(parseReference(formatReference(ref))).toEqual(ref);
		const odd = { ...ref, item: 'a:b c' };
		expect(parseReference(formatReference(odd))).toEqual(odd);
		for (const bad of ['', 'page:12', 'item:a:1:t:en', 'item:a:1:t:en:de:x', 'item:a::t:en:de', 'item:a:%E0:t:en:de']) expect(parseReference(bad), bad).toBeNull();
	});
});

describe('export', () => {
	it('uses the collector\'s segments (plain text as text), the mapping and the file name', () => {
		const file = buildExport({ collection: 'articles', item: '12', field: 'translations', source: 'en-US', targets: ['de-DE', 'de_LI'], format: 'xliff', collected: collectSegments(fields, row()), languageMap: { 'de-DE': 'de-CH' } });
		expect(file.filename).toBe('directus-12.xlf');
		expect(file.contentType).toBe('application/x-xliff+xml');
		const jobs = TranslationFiles.read(file.content);
		expect(jobs.map((j) => [j.plugin, j.reference, j.sourceLanguage, j.targetLanguage])).toEqual([
			[PLUGIN, 'item:articles:12:translations:en-US:de-DE', 'en', 'de-CH'],
			[PLUGIN, 'item:articles:12:translations:en-US:de_LI', 'en', 'de-LI'],
		]);
		expect(jobs[0]!.units.map((u) => u.key)).toEqual(['title.0', 'body.0', 'body.1']);
		expect(file.content).toContain('<source>Fish &amp; chips</source>');
	});

	it('HTML: exactly one target; nothing to translate; no targets', () => {
		const html = buildExport({ collection: 'articles', item: '12', field: 'translations', source: 'en-US', targets: ['fr-FR'], format: 'html', collected: collectSegments(fields, row()) });
		expect(html.filename).toBe('directus-12-fr-FR.html');
		expect(html.contentType).toBe('text/html; charset=utf-8');
		const base = { collection: 'articles', item: '12', field: 'translations', source: 'en-US' } as const;
		expect(() => buildExport({ ...base, targets: ['fr-FR', 'de-DE'], format: 'html', collected: collectSegments(fields, row()) })).toThrow(expect.objectContaining({ code: 'one_target' }));
		expect(() => buildExport({ ...base, targets: ['de-DE'], format: 'xliff', collected: collectSegments(fields, {}) })).toThrow(expect.objectContaining({ code: 'nothing_to_translate' }));
		expect(() => buildExport({ ...base, targets: ['en-US'], format: 'xliff', collected: collectSegments(fields, row()) })).toThrow(expect.objectContaining({ code: 'no_targets' }));
	});
});

describe('import', () => {
	it('ok values for the form; untranslated, invalid and missing not', async () => {
		let xliff = withTarget(exportXliff(), 'title.0', 'Fisch &amp; Pommes');
		xliff = withTarget(xliff, 'body.0', 'Eins <bpt id="1">&lt;strong&gt;</bpt>fett'); // drops the closing code
		const current = { ...row(), body: row().body + '<p>Added later</p>' };
		const [job] = await importJobs(xliff, target(current));
		expect(job!.error).toBeUndefined();
		expect(job!.counts).toEqual({ ok: 1, source_changed: 0, untranslated: 1, invalid_markup: 1, missing: 1 });
		expect(job!.imported).toBe(1);
		expect(job!.values).toEqual({ title: 'Fisch & Pommes' });
		expect(job!).toMatchObject({ ok: true, language: 'de-DE', id: 7, created: false });
	});

	it('rich text with the source\'s markup; untranslated pieces keep the source', async () => {
		const xliff = withTarget(exportXliff(), 'body.0', 'Eins <bpt id="1">&lt;b onclick=x&gt;</bpt>fett<ept id="1">&lt;/b&gt;</ept>');
		const [job] = await importJobs(xliff, target(row(), undefined, {}));
		expect(job!.values).toEqual({ body: '<p>Eins <strong>fett</strong></p><p>Two</p>' });
		expect(job!).toMatchObject({ id: null, created: true });
	});

	it('source_changed only with includeChanged', async () => {
		const xliff = withTarget(withTarget(exportXliff(), 'title.0', 'Fisch'), 'body.1', 'Zwei');
		const current = { ...row(), title: 'Fish and chips' };
		let [job] = await importJobs(xliff, target(current));
		expect(job!).toMatchObject({ skippedChanged: 1, imported: 1 });
		expect(job!.values).toEqual({ body: '<p>One <strong>bold</strong></p><p>Zwei</p>' });
		[job] = await importJobs(xliff, target(current), true);
		expect(job!).toMatchObject({ skippedChanged: 0, imported: 2 });
		expect(job!.values.title).toBe('Fisch');
	});

	it('an HTML file imported unchanged gives the source text back', async () => {
		const html = buildExport({ collection: 'articles', item: '12', field: 'translations', source: 'en-US', targets: ['de-DE'], format: 'html', collected: collectSegments(fields, row()) }).content;
		const [job] = await importJobs(html, target());
		expect(job!.counts.ok).toBe(3);
		expect(job!.values).toEqual({ title: 'Fish & chips', body: row().body });
	});

	it('another plugin, another item, unknown reference, missing language, missing item', async () => {
		const base = withTarget(exportXliff(), 'title.0', 'Fisch');
		const cases: [string, string, Record<string, string>, ImportTarget?][] = [
			[base.replace(`product-name="${PLUGIN}"`, 'product-name="Strapi-Supertext-Translation"'), 'other_system', { plugin: 'Strapi-Supertext-Translation' }],
			[base.replace('original="item:articles:12:', 'original="item:articles:13:'), 'other_item', { reference: 'item:articles:13:translations:en-US:de-DE' }],
			[base.replace('original="item:articles:12:translations:en-US:de-DE"', 'original="page:12"'), 'not_found', {}],
			[base.replace(':de-DE"', ':it-IT"'), 'no_language', { language: 'it-IT' }],
			[base, 'not_found', {}, { ...target(), load: async () => { throw new TranslateError('gone', 404, 'not_found'); } }],
		];
		for (const [content, code, values, t] of cases) {
			const [job] = await importJobs(content, t ?? target());
			expect(job!.error, code).toMatchObject({ code, key: `files.error.${code}`, values });
			expect(job!.ok).toBe(false);
			expect(job!.values).toEqual({});
		}
	});

	it('too large refused before reading; read errors with the SDK codes', async () => {
		await expect(importJobs('x'.repeat(MAX_UPLOAD_BYTES + 1), target())).rejects.toMatchObject({ code: 'too_large', status: 413 });
		await expect(importJobs('hello', target())).rejects.toMatchObject({ code: 'invalid_file', key: 'files.error.invalid_file' });
		await expect(importJobs('<!DOCTYPE html><html><body><p>x</p></body></html>', target())).rejects.toMatchObject({ code: 'missing_metadata' });
		await expect(readBody({ headers: { 'content-length': String(MAX_UPLOAD_BYTES + 1) } })).rejects.toMatchObject({ code: 'too_large' });
	});
});
