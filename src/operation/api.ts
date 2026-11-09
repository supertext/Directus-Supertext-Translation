import { defineOperationApi } from '@directus/extensions-sdk';
import { readConfig } from '../api/config.js';
import { translateItem, type TranslateResult } from '../api/translator.js';
import { Reporting, siteUrl } from '../api/reporting.js';
import { loadLanguageSettings, withLanguageSettings } from '../api/settings.js';

let reporting: Reporting | null = null;

export type Options = {
	collection?: string;
	item?: string | number | (string | number)[];
	field?: string;
	source?: string;
	targets?: string[] | string;
	fields?: string[] | string;
	onlyMissing?: boolean;
};

const list = (v: unknown): string[] | undefined => {
	if (Array.isArray(v)) return v.map(String).filter(Boolean);
	if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean);
	return undefined;
};

/**
 * Flow operation "Supertext: translate". Translates and saves. Item keys come from the
 * options, else from the trigger (event: key/keys, manual: body.keys).
 */
export default defineOperationApi<Options>({
	id: 'supertext-translate-flow',
	handler: async (options, { services, getSchema, env, data, accountability, logger, database }) => {
		reporting ??= new Reporting({ env, database, logger });
		const trigger = (data as any)?.$trigger ?? {};
		const collection = options.collection || trigger.collection || trigger.body?.collection;
		const raw = options.item ?? trigger.keys ?? trigger.key ?? trigger.body?.keys;
		const items = (Array.isArray(raw) ? raw : raw !== undefined && raw !== null && raw !== '' ? [raw] : []) as (string | number)[];
		if (!collection) throw new Error('Supertext: no collection (set it in the operation or use an item trigger).');
		if (!items.length) throw new Error('Supertext: no item keys (set them in the operation or use an item trigger).');

		const schema = await getSchema();
		// The environment's settings with the language mapping from the Supertext page (the environment wins per language).
		const config = withLanguageSettings(readConfig(env), await loadLanguageSettings(reporting.store, logger));
		const done: TranslateResult[] = [];
		const failures: string[] = [];
		for (const item of items) {
			const result = await translateItem({
				services,
				schema,
				accountability: accountability ?? null,
				config,
				collection,
				item,
				field: options.field || undefined,
				source: options.source || undefined,
				targets: list(options.targets),
				fields: list(options.fields),
				onlyMissing: options.onlyMissing === true,
				save: true,
				emitEvents: false,
			});
			done.push(result);
			for (const r of result.results) if (!r.ok) failures.push(`${collection}/${item} → ${r.language}: ${r.error}`);
		}
		for (const f of failures) logger.warn(`[supertext] ${f}`);
		// Version report and key check (background; a rejected key marks the check invalid).
		const rejected = done.flatMap((r) => r.results).find((r) => !r.ok && r.code === 'authentication_failure');
		if (rejected) reporting.inBackground('authenticationFailed', config, siteUrl(env), Number(rejected.values?.status) || 401);
		else reporting.inBackground('onRequest', config, siteUrl(env));
		if (failures.length) throw new Error(`Supertext: ${failures.length} translation(s) failed. ${failures.join(' | ')}`);
		return done.map((r) => ({ item: r.item, source: r.source, translated: r.results.filter((x) => x.ok).map((x) => x.language) }));
	},
});
