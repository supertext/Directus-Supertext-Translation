import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/api/config.js';
import { translateItem } from '../src/api/translator.js';
import { withLanguageSettings } from '../src/api/settings.js';
import { REVIEW_URL, SupertextClient } from '../src/shared/supertext-client.js';
import { fakeSupertext } from './fakeSupertext.js';
import { extensionVersion, userAgent } from '../src/api/version.js';

const noSleep = async () => {};

/** Just enough of Directus' services for one item with a translations field (languages en, de-CH, fr-CH). */
function services() {
	const rows = [{ id: 1, languages_code: 'en', title: 'Hello' }];
	const languages = [{ code: 'en', name: 'English' }, { code: 'de-CH', name: 'Deutsch' }, { code: 'fr-CH', name: 'Français' }];
	return {
		FieldsService: class {
			async readAll() {
				return [
					{ field: 'id', type: 'integer', meta: {} },
					{ field: 'articles_id', type: 'integer', meta: {} },
					{ field: 'languages_code', type: 'string', meta: {} },
					{ field: 'title', type: 'string', meta: { interface: 'input' } },
				];
			}
			async readOne() {
				return { meta: { options: { defaultLanguage: 'en' } } };
			}
		},
		ItemsService: class {
			constructor(readonly collection: string) {}
			async readOne() {
				return { translations: rows };
			}
			async readByQuery() {
				return languages;
			}
		},
	};
}

const schema: any = {
	collections: {
		articles: { primary: 'id', fields: { translations: { special: ['translations'] } } },
		articles_translations: { primary: 'id', fields: {} },
		languages: { primary: 'code', fields: { name: {} } },
	},
	relations: [
		{ collection: 'articles_translations', field: 'articles_id', related_collection: 'articles', meta: { one_field: 'translations', junction_field: 'languages_code' } },
		{ collection: 'articles_translations', field: 'languages_code', related_collection: 'languages', meta: null },
	],
};

const hosts = (calls: { method: string; url: string }[]) => {
	const out: Record<string, string[]> = {};
	for (const c of calls) (out[new URL(c.url).host] ??= []).push(c.method);
	return out;
};

describe('Translation review', () => {
	it('defaults to Supertext’s review service; an empty SUPERTEXT_REVIEW_URL turns it off', () => {
		expect(REVIEW_URL).toBe('https://localizationreview-production.up.railway.app/v1/');
		expect(readConfig({}, {}).reviewUrl).toBe(REVIEW_URL);
		expect(readConfig({}, { SUPERTEXT_REVIEW_URL: '' }).reviewUrl).toBe('');
		expect(readConfig({ SUPERTEXT_REVIEW_URL: 'http://127.0.0.1:3000/v1/' }, {}).reviewUrl).toBe('http://127.0.0.1:3000/v1/');
	});

	it('sends languages with review on through the review service (all four calls), the others directly', async () => {
		const fake = fakeSupertext();
		const config = withLanguageSettings(
			{ ...readConfig({ SUPERTEXT_API_KEY: 'test-key', SUPERTEXT_API_URL: 'https://api.test/v1/', SUPERTEXT_REVIEW_URL: 'https://review.test/v1/' }, {}), concurrency: 1 },
			{ codes: {}, politeness: {}, review: { 'de-CH': true } },
		);
		const result = await translateItem({ services: services(), schema, accountability: null, config, collection: 'articles', item: 1, save: false, fetch: fake.fetch as typeof fetch, sleep: noSleep });

		expect(result.results.map((r) => r.ok && r.values.title)).toEqual(['[de-CH] Hello', '[fr-CH] Hello']);
		expect(hosts(fake.calls)).toEqual({ 'review.test': ['POST', 'GET', 'GET', 'DELETE'], 'api.test': ['POST', 'GET', 'GET', 'DELETE'] });
		expect(fake.calls.slice(0, 4).every((c) => c.url.startsWith('https://review.test/v1/'))).toBe(true);
	});

	it('goes directly to Supertext for every language when the review URL is empty', async () => {
		const fake = fakeSupertext();
		const config = withLanguageSettings(
			readConfig({ SUPERTEXT_API_KEY: 'test-key', SUPERTEXT_API_URL: 'https://api.test/v1/' }, { SUPERTEXT_REVIEW_URL: '' }),
			{ codes: {}, politeness: {}, review: { 'de-CH': true, 'fr-CH': true } },
		);
		await translateItem({ services: services(), schema, accountability: null, config, collection: 'articles', item: 1, save: false, fetch: fake.fetch as typeof fetch, sleep: noSleep });
		expect(Object.keys(hosts(fake.calls))).toEqual(['api.test']);
	});

	it('uses one review client with the same key, and never for the key check', async () => {
		const fake = fakeSupertext();
		const client = new SupertextClient({ apiKey: 'test-key', baseUrl: 'https://api.test/v1', reviewUrl: 'https://review.test/v1/', fetch: fake.fetch as typeof fetch, sleep: noSleep });
		expect(client.forReview(false)).toBe(client);
		const review = client.forReview(true);
		expect(review).not.toBe(client);
		expect(client.forReview(true)).toBe(review);
		expect(await review.translateHtml({ html: '<p data-st-id="0">Hallo</p>', targetLang: 'fr-CH' })).toContain('[fr-CH] Hallo');
		expect(fake.calls.every((c) => c.url.startsWith('https://review.test/v1/'))).toBe(true);
		await client.checkApiKey();
		expect(fake.calls.at(-1)?.url).toBe('https://api.test/v1/features');

		const same = new SupertextClient({ apiKey: 'k', baseUrl: 'https://api.test/v1/', reviewUrl: 'https://api.test/v1' });
		expect(same.forReview(true)).toBe(same);
		const none = new SupertextClient({ apiKey: 'k', reviewUrl: '' });
		expect(none.forReview(true)).toBe(none);
	});

	it('names the extension and its version in the User-Agent', async () => {
		expect(userAgent()).toBe(`Directus-Supertext-Translation/${extensionVersion()}`);
		const agents: string[] = [];
		const fetchSpy = (async (_url: RequestInfo | URL, init?: RequestInit) => {
			agents.push(new Headers(init?.headers).get('User-Agent') ?? '');
			return Response.json({});
		}) as typeof fetch;
		await new SupertextClient({ apiKey: 'k', baseUrl: 'https://api.test/v1/', userAgent: userAgent(), fetch: fetchSpy }).validateApiKey();
		expect(agents[0]).toContain(userAgent());
	});
});
