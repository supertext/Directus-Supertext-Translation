import type { Accountability, SchemaOverview } from '@directus/types';
import { encode, kindForField, type Encoded, type FieldKind } from '../shared/codecs.js';
import { buildDocument, parseDocument } from '../shared/document.js';
import { politenessFor, sourceCode, targetCode } from '../shared/languages.js';
import { SupertextClient, SupertextError } from '../shared/supertext-client.js';
import type { SupertextConfig } from './config.js';
import { userAgent } from './version.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Services = Record<string, any>;
type PrimaryKey = string | number;

type Values = Record<string, string | number>;

/**
 * A user-facing problem (bad request, nothing to translate, …). `message` is English;
 * the app shows `key` (a message of src/i18n, default `error.<code>`) with `values`
 * in the user's language.
 */
export class TranslateError extends Error {
	readonly key: string;

	constructor(
		message: string,
		readonly status = 400,
		readonly code = 'invalid_request',
		readonly values: Values = {},
		key?: string,
	) {
		super(message);
		this.name = 'TranslateError';
		this.key = key ?? `error.${code}`;
	}

	/** Wraps a Supertext API error; the app translates it as `supertext.<code>`. */
	static fromSupertext(error: SupertextError, status = 502): TranslateError {
		return new TranslateError(error.message, status, error.code, supertextValues(error), `supertext.${error.code}`);
	}
}

const supertextValues = (error: SupertextError): Values => ({
	...(error.status ? { status: error.status } : {}),
	...(error.detail ? { detail: error.detail } : {}),
});

/** How a translations field is wired: parent ← junction → languages. */
export type TranslationsRelation = {
	collection: string;
	field: string;
	junction: string;
	junctionPk: string;
	parentFk: string;
	languageFk: string;
	languages: string;
	languagePk: string;
};

export function findTranslationsRelation(schema: SchemaOverview, collection: string, field?: string): TranslationsRelation {
	if (!schema.collections[collection]) throw new TranslateError(`Collection "${collection}" does not exist.`, 404, 'not_found', { collection });
	const candidates = schema.relations.filter(
		(r) => r.related_collection === collection && r.meta?.one_field && r.meta?.junction_field && (!field || r.meta.one_field === field),
	);
	for (const rel of candidates) {
		const languageFk = rel.meta!.junction_field!;
		const langRel = schema.relations.find((r) => r.collection === rel.collection && r.field === languageFk);
		const special = schema.collections[collection]?.fields[rel.meta!.one_field!]?.special ?? [];
		if (!langRel?.related_collection || (special.length && !special.includes('translations'))) continue;
		return {
			collection,
			field: rel.meta!.one_field!,
			junction: rel.collection,
			junctionPk: schema.collections[rel.collection]!.primary,
			parentFk: rel.field,
			languageFk,
			languages: langRel.related_collection,
			languagePk: schema.collections[langRel.related_collection]!.primary,
		};
	}
	throw field
		? new TranslateError(`"${collection}.${field}" is not a translations field.`, 400, 'no_translations_field', { collection, field }, 'error.not_translations_field')
		: new TranslateError(`"${collection}" has no translations field.`, 400, 'no_translations_field', { collection });
}

export type TranslatableField = { field: string; kind: FieldKind };

/** Text fields of the junction collection that get translated (from field metadata). */
export async function translatableFields(services: Services, schema: SchemaOverview, rel: TranslationsRelation, only?: string[]): Promise<TranslatableField[]> {
	const fields: any[] = await new services.FieldsService({ schema, accountability: null }).readAll(rel.junction);
	const skip = new Set([rel.junctionPk, rel.parentFk, rel.languageFk]);
	return fields
		.filter((f) => !skip.has(f.field) && !f.meta?.hidden && !f.meta?.readonly && (!only?.length || only.includes(f.field)))
		.sort((a, b) => (a.meta?.sort ?? 0) - (b.meta?.sort ?? 0))
		.map((f) => ({ field: f.field as string, kind: kindForField(f) }))
		.filter((f): f is TranslatableField => f.kind !== null);
}

export type LanguageInfo = { code: string; name: string; hasTranslation: boolean; /** Primary key of its translation row, if any. */ id: PrimaryKey | null };

export type ItemTranslations = {
	relation: TranslationsRelation;
	/** The translations field's "default language", else the first language with text. */
	defaultSource: string | null;
	fields: TranslatableField[];
	languages: LanguageInfo[];
	rows: Record<string, any>;
};

/** Loads the item's translation rows and the languages, both with the user's permissions. */
export async function loadItem(services: Services, schema: SchemaOverview, accountability: Accountability | null, collection: string, item: PrimaryKey | null, field?: string, only?: string[]): Promise<ItemTranslations> {
	const relation = findTranslationsRelation(schema, collection, field);
	const fields = await translatableFields(services, schema, relation, only);
	const ctx = { schema, accountability };
	// item null: a new, unsaved item has no translation rows yet.
	const record = item === null ? null : await new services.ItemsService(collection, ctx).readOne(item, { fields: [`${relation.field}.*`] });
	const rows: Record<string, any> = {};
	for (const row of (record?.[relation.field] ?? []) as any[]) {
		const code = typeof row[relation.languageFk] === 'object' ? row[relation.languageFk]?.[relation.languagePk] : row[relation.languageFk];
		if (code != null) rows[String(code)] = row;
	}
	const langRows: any[] = await new services.ItemsService(relation.languages, ctx).readByQuery({ limit: -1, fields: ['*'] });
	const nameField = ['name', 'title', 'label'].find((f) => schema.collections[relation.languages]?.fields[f]);
	const languages = langRows.map((l) => {
		const code = String(l[relation.languagePk]);
		const row = rows[code];
		return { code, name: String((nameField && l[nameField]) || code), hasTranslation: !!row && fields.some((f) => isFilled(row[f.field])), id: row ? (row[relation.junctionPk] as PrimaryKey) : null };
	});
	let fieldDefault: string | null = null;
	try {
		const meta = await new services.FieldsService({ schema, accountability: null }).readOne(collection, relation.field);
		fieldDefault = (meta?.meta?.options?.defaultLanguage as string | undefined) ?? null;
	} catch {
		// Field metadata is optional.
	}
	const defaultSource = languages.find((l) => l.code === fieldDefault)?.code ?? languages.find((l) => l.hasTranslation)?.code ?? languages[0]?.code ?? null;
	return { relation, defaultSource, fields, languages, rows };
}

const isFilled = (v: unknown) => typeof v === 'string' && v.trim() !== '';

export type LanguageResult =
	| { language: string; ok: true; values: Record<string, string>; id: PrimaryKey | null; created: boolean; missing: string[]; saved: boolean }
	| { language: string; ok: false; error: string; code: string; key: string; values: Values };

export type TranslateResult = {
	collection: string;
	item: PrimaryKey;
	field: string;
	source: string;
	fields: string[];
	results: LanguageResult[];
};

export type TranslateArgs = {
	services: Services;
	schema: SchemaOverview;
	accountability: Accountability | null;
	config: SupertextConfig;
	collection: string;
	item: PrimaryKey;
	field?: string;
	source?: string;
	targets?: string[];
	/** Restrict to these fields of the translations collection. */
	fields?: string[];
	/** true: save the translations (Flow operation); false: only return them (form). */
	save: boolean;
	/** Only languages that have no translated text yet. */
	onlyMissing?: boolean;
	/** false: saving doesn't trigger flows/hooks (avoids loops when a flow translates on save). */
	emitEvents?: boolean;
	/** Tests. */
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
};

export async function translateItem(args: TranslateArgs): Promise<TranslateResult> {
	const { services, schema, accountability, config } = args;
	if (!config.apiKey) throw new TranslateError('No Supertext API key is configured. Set SUPERTEXT_API_KEY.', 503, 'missing_api_key');

	// Only people who may change the item spend translation credit.
	if (accountability) {
		const perms = await new services.PermissionsService({ schema, accountability }).getItemPermissions(args.collection, String(args.item));
		if (!perms?.update?.access) throw new TranslateError('You are not allowed to edit this item.', 403, 'forbidden');
	}

	const data = await loadItem(services, schema, accountability, args.collection, args.item, args.field, args.fields);
	const { relation, fields, languages, rows } = data;
	if (!fields.length) throw new TranslateError(`"${relation.junction}" has no text fields to translate.`, 400, 'no_fields', { collection: relation.junction });

	const known = new Set(languages.map((l) => l.code));
	const source = args.source || data.defaultSource || undefined;
	if (!source || !known.has(source)) throw new TranslateError(`Unknown source language "${source ?? ''}".`, 400, 'unknown_language', { language: source ?? '' }, 'error.unknown_source');
	const sourceRow = rows[source];
	if (!sourceRow || !fields.some((f) => isFilled(sourceRow[f.field]))) {
		throw new TranslateError(`There is no ${source} text to translate. Fill in and save the ${source} translation first.`, 400, 'no_source', { language: source });
	}
	let targets = (args.targets?.length ? args.targets : languages.map((l) => l.code)).filter((t) => t !== source);
	const unknown = targets.filter((t) => !known.has(t));
	if (unknown.length) throw new TranslateError(`Unknown language(s): ${unknown.join(', ')}.`, 400, 'unknown_language', { languages: unknown.join(', ') });
	if (!targets.length) throw new TranslateError('Choose at least one language to translate into.', 400, 'no_targets');
	if (args.onlyMissing) {
		const done = new Set(languages.filter((l) => l.hasTranslation).map((l) => l.code));
		targets = targets.filter((t) => !done.has(t));
		if (!targets.length) return { collection: args.collection, item: args.item, field: relation.field, source, fields: [], results: [] };
	}

	// One document for all fields; remember which pieces belong to which field.
	const encoded: { field: string; enc: Encoded; from: number }[] = [];
	const pieces: Encoded['pieces'] = [];
	for (const f of fields) {
		const enc = encode(f.kind, sourceRow[f.field]);
		if (!enc || !enc.pieces.length) continue;
		encoded.push({ field: f.field, enc, from: pieces.length });
		pieces.push(...enc.pieces);
	}
	const html = buildDocument(pieces);

	const client = new SupertextClient({
		apiKey: config.apiKey,
		baseUrl: config.baseUrl,
		pollIntervalMs: config.pollIntervalMs,
		timeoutMs: config.timeoutMs,
		userAgent: userAgent(),
		reviewUrl: config.reviewUrl,
		fetch: args.fetch,
		sleep: args.sleep,
	});

	const translateOne = async (language: string): Promise<LanguageResult> => {
		try {
			// Languages with *Translation review* on go through the review service (whole round trip on that client).
			const translatedHtml = await client.forReview(config.review[language] === true).translateHtml({
				html,
				targetLang: targetCode(language, config.languageMap),
				sourceLang: sourceCode(source, config.languageMap),
				politeness: politenessFor(language, config.politeness),
			});
			const translated = parseDocument(translatedHtml, pieces.length);
			const values: Record<string, string> = {};
			const missing: string[] = [];
			for (const { field, enc, from } of encoded) {
				const parts = enc.pieces.map((_, i) => translated.get(from + i));
				if (parts.some((p) => p === undefined)) missing.push(field);
				values[field] = enc.rebuild(parts);
			}
			const row = rows[language];
			return { language, ok: true, values, id: row ? (row[relation.junctionPk] as PrimaryKey) : null, created: !row, missing, saved: false };
		} catch (error) {
			if (error instanceof SupertextError) {
				return { language, ok: false, error: error.message, code: error.code, key: `supertext.${error.code}`, values: { ...supertextValues(error), language } };
			}
			throw error;
		}
	};

	const results = await mapLimit(targets, Math.max(1, config.concurrency), translateOne);

	if (args.save) {
		const parent = new services.ItemsService(args.collection, { schema, accountability });
		for (const r of results) {
			if (!r.ok) continue;
			const edit = r.id != null
				? { create: [], update: [{ [relation.junctionPk]: r.id, ...r.values }], delete: [] }
				: { create: [{ ...r.values, [relation.languageFk]: { [relation.languagePk]: r.language } }], update: [], delete: [] };
			try {
				// Through the parent, like the item form: one revision, the user's permissions.
				await parent.updateOne(args.item, { [relation.field]: edit }, { emitEvents: args.emitEvents ?? true });
				r.saved = true;
			} catch (error: any) {
				const index = results.indexOf(r);
				const detail = String(error?.message ?? error);
				results[index] = { language: r.language, ok: false, error: `Translated but not saved: ${detail}`, code: 'save_failed', key: 'error.save_failed', values: { detail } };
			}
		}
	}

	return { collection: args.collection, item: args.item, field: relation.field, source, fields: encoded.map((e) => e.field), results };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]!);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}
