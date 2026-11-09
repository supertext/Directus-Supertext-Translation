import { describe, expect, it } from 'vitest';
import endpoint from '../src/endpoint/index.js';
import { readConfig } from '../src/api/config.js';
import { StateStore } from '../src/api/reporting.js';
import {
	applyLanguageChanges,
	emptyLanguageSettings,
	LanguageSettingsError,
	loadLanguageSettings,
	parseLanguageSettings,
	saveLanguageSettings,
	withLanguageSettings,
} from '../src/api/settings.js';

/** Just enough of Knex for the state table: hasTable/createTable and key/value rows. */
function fakeDatabase() {
	const rows = new Map<string, string>();
	let table = false;
	const db: any = (name: string) => {
		expect(name).toBe('supertext_state');
		return {
			where: ({ key }: { key: string }) => ({
				first: async () => (rows.has(key) ? { value: rows.get(key) } : undefined),
				update: async ({ value }: { value: string }) => (rows.has(key) ? (rows.set(key, value), 1) : 0),
			}),
			insert: async ({ key, value }: { key: string; value: string }) => void rows.set(key, value),
		};
	};
	db.schema = { hasTable: async () => table, createTable: async () => void (table = true) };
	return { db, rows };
}

describe('language settings', () => {
	it('reads stored JSON leniently', () => {
		expect(parseLanguageSettings(null)).toEqual(emptyLanguageSettings());
		expect(parseLanguageSettings('not json')).toEqual(emptyLanguageSettings());
		expect(parseLanguageSettings('{"codes":{"de":"de-CH","x":"xx-YY"},"politeness":{"de":"more","fr":"loud"}}')).toEqual({
			codes: { de: 'de-CH' },
			politeness: { de: 'more' },
			review: {},
		});
		expect(parseLanguageSettings('{"codes":{},"politeness":{},"review":{"de":true,"fr":"yes"}}').review).toEqual({ de: true });
	});

	it('applies the rows of the Supertext page, validating the codes', () => {
		const next = applyLanguageChanges({ codes: { fr: 'fr-FR' }, politeness: {}, review: { fr: true, it: true } }, [
			{ language: 'de', target: 'de-CH', politeness: 'more', review: true },
			{ language: 'fr', target: null, review: false },
			{ language: 'en', target: 'en-US', politeness: 'more' }, // en-US has no formal/informal: dropped
			{ language: 'it', target: null }, // review omitted: unchanged
		]);
		expect(next).toEqual({ codes: { de: 'de-CH', en: 'en-US' }, politeness: { de: 'more' }, review: { de: true, it: true } });
		expect(applyLanguageChanges({ codes: {}, politeness: {}, review: { de: true } }, [{ language: 'de', target: null, review: 'yes' as any }]).review).toEqual({ de: true });
		expect(() => applyLanguageChanges(emptyLanguageSettings(), [{ language: 'de', target: 'de' }])).toThrow(LanguageSettingsError);
		expect(() => applyLanguageChanges(emptyLanguageSettings(), [{ language: 'de', target: 'de-CH', politeness: 'loud' }])).toThrow(LanguageSettingsError);
		expect(() => applyLanguageChanges(emptyLanguageSettings(), 'de=de-CH')).toThrow(LanguageSettingsError);
	});

	it('lets the environment win per language', () => {
		const config = readConfig({ SUPERTEXT_LANGUAGE_MAP: '{"de":"de-AT"}', SUPERTEXT_POLITENESS: '{"fr":"less"}' }, {});
		const merged = withLanguageSettings(config, { codes: { de: 'de-CH', it: 'it-CH' }, politeness: { fr: 'more', it: 'more' }, review: { it: true } });
		expect(merged.review).toEqual({ it: true });
		expect(merged.languageMap).toEqual({ de: 'de-AT', it: 'it-CH' });
		expect(merged.politeness).toEqual({ fr: 'less', it: 'more' });
	});

	it('is stored in supertext_state next to the reporter state', async () => {
		const { db, rows } = fakeDatabase();
		const store = new StateStore(db);
		await saveLanguageSettings(store, { codes: { de: 'de-CH' }, politeness: {}, review: { de: true } });
		expect(JSON.parse(rows.get('languages')!)).toEqual({ codes: { de: 'de-CH' }, politeness: {}, review: { de: true } });
		expect(await loadLanguageSettings(store)).toEqual({ codes: { de: 'de-CH' }, politeness: {}, review: { de: true } });
		// Unreadable store: environment and defaults only.
		expect(await loadLanguageSettings(new StateStore(undefined as any), { warn() {} })).toEqual(emptyLanguageSettings());
	});
});

/** The endpoint on a fake router, with a schema that has one translations field and languages de, en-IE, fr-CH. */
function routes(env: Record<string, string> = {}) {
	const { db, rows } = fakeDatabase();
	const handlers: Record<string, (req: any, res: any) => Promise<void>> = {};
	const router: any = {
		get: (path: string, fn: any) => (handlers[`GET ${path}`] = fn),
		post: (path: string, fn: any) => (handlers[`POST ${path}`] = fn),
	};
	const schema = {
		collections: {
			articles: { primary: 'id', fields: { translations: { special: ['translations'] } } },
			articles_translations: { primary: 'id', fields: {} },
			languages: { primary: 'code', fields: {} },
		},
		relations: [
			{ collection: 'articles_translations', field: 'articles_id', related_collection: 'articles', meta: { one_field: 'translations', junction_field: 'languages_code' } },
			{ collection: 'articles_translations', field: 'languages_code', related_collection: 'languages', meta: null },
		],
	};
	const services = {
		ItemsService: class {
			async readByQuery() {
				return [
					{ code: 'de', name: 'German' },
					{ code: 'en-IE', name: 'English (Ireland)' },
					{ code: 'fr-CH', name: 'French (Switzerland)' },
				];
			}
		},
	};
	const config: any = typeof endpoint === 'function' ? { handler: endpoint } : endpoint;
	config.handler(router, { services, getSchema: async () => schema, env: { SUPERTEXT_VERSION_REPORTS: '0', ...env }, logger: { error() {}, warn() {}, debug() {} }, database: db });
	return { handlers, rows };
}

function call(handler: any, req: any) {
	return new Promise<{ status: number; body: any }>((resolve) => {
		let status = 200;
		const res: any = { status: (s: number) => ((status = s), res), json: (body: any) => resolve({ status, body }) };
		handler(req, res);
	});
}

const admin = { accountability: { user: 'u1', admin: true } };

describe('Supertext page: languages', () => {
	it('lists every language with the suggestion, the saved code and the override', async () => {
		const { handlers } = routes({ SUPERTEXT_LANGUAGE_MAP: '{"fr-CH":"fr-FR"}' });
		const { body } = await call(handlers['GET /status'], admin);
		const byCode = Object.fromEntries(body.data.languages.map((l: any) => [l.code, l]));
		expect(byCode.de).toMatchObject({ target: 'de-DE', suggested: 'de-DE', saved: null, override: null, politenessSupported: true, review: false });
		expect(byCode['en-IE']).toMatchObject({ target: null, suggested: null, saved: null });
		expect(byCode['fr-CH']).toMatchObject({ target: 'fr-FR', suggested: 'fr-CH', override: 'fr-FR' });
		expect(body.data.targets.map((t: any) => t.code)).toContain('de-CH');
	});

	it('saves the combo boxes (admins only) and uses them', async () => {
		const { handlers, rows } = routes();
		const save = handlers['POST /languages'];
		expect((await call(save, { accountability: { user: 'u2', admin: false }, body: { languages: [] } })).status).toBe(403);
		const bad = await call(save, { ...admin, body: { languages: [{ language: 'de', target: 'deutsch' }] } });
		expect(bad.status).toBe(400);
		expect(bad.body.errors[0].extensions).toMatchObject({ code: 'invalid_language_setting', values: { language: 'de', code: 'deutsch' } });

		const ok = await call(save, { ...admin, body: { languages: [{ language: 'de', target: 'de-CH', politeness: 'more', review: true }, { language: 'en-IE', target: 'en-GB', review: false }] } });
		expect(ok.status).toBe(200);
		expect(JSON.parse(rows.get('languages')!)).toEqual({ codes: { de: 'de-CH', 'en-IE': 'en-GB' }, politeness: { de: 'more' }, review: { de: true } });

		const { body } = await call(handlers['GET /status'], admin);
		const byCode = Object.fromEntries(body.data.languages.map((l: any) => [l.code, l]));
		expect(byCode.de).toMatchObject({ target: 'de-CH', saved: 'de-CH', politeness: 'more', savedPoliteness: 'more', review: true });
		expect(byCode['en-IE']).toMatchObject({ target: 'en-GB', saved: 'en-GB', review: false });
		expect(body.data.reviewUrl).toBe('https://localizationreview-production.up.railway.app/v1/');
	});
});
