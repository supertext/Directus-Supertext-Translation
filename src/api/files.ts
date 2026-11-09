import type { Accountability, SchemaOverview } from '@directus/types';
import { TranslationFiles, TranslationFileError, type FileSegment, type TranslationFile } from 'supertext-sdk';
import { encode, escapeHtml, type Encoded, type FieldKind } from '../shared/codecs.js';
import { sourceCode, targetCode } from '../shared/languages.js';
import type { SupertextConfig } from './config.js';
import { loadItem, TranslateError, type TranslatableField } from './translator.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Services = Record<string, any>;
type PrimaryKey = string | number;

/**
 * Translation files: "Export for translation" (XLIFF 1.2 or HTML) and "Import translation"
 * on top of the Supertext SDK's `TranslationFiles` (SDK 0.5.0). Same segments as an API
 * translation (`encode` per field of the translations collection); key `<field>.<piece>`.
 *
 * Reference (how an import finds the item again; each part URI-encoded):
 *   item:<collection>:<primary key>:<translations field>:<source language>:<target language>
 *   e.g. item:articles:12:translations:en-US:de-DE
 */
export const PLUGIN = 'Directus-Supertext-Translation';
const SHORT_NAME = 'directus';
/** Uploads above this size (bytes) are refused before they are read. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const FORMATS = {
	xliff: { extension: 'xlf', contentType: 'application/x-xliff+xml' },
	html: { extension: 'html', contentType: 'text/html; charset=utf-8' },
} as const;
export type Format = keyof typeof FORMATS;

export type FileRef = { collection: string; item: string; field: string; source: string; target: string };

export function formatReference(ref: FileRef): string {
	return ['item', ref.collection, ref.item, ref.field, ref.source, ref.target].map((p, i) => (i === 0 ? p : encodeURIComponent(p))).join(':');
}

/** The reference's parts, or null for anything else. */
export function parseReference(reference: string): FileRef | null {
	const parts = String(reference ?? '').split(':');
	if (parts.length !== 6 || parts[0] !== 'item') return null;
	try {
		const [collection, item, field, source, target] = parts.slice(1).map((p) => decodeURIComponent(p));
		if (![collection, item, field, source, target].every((p) => p && p.trim() === p)) return null;
		return { collection: collection!, item: item!, field: field!, source: source!, target: target! };
	} catch {
		return null;
	}
}

/**
 * The Supertext code the mapping resolves (`Languages.source` / `.target`); a language without
 * one keeps its own code with `_` as `-`: a file may go to any translator, so unmapped languages
 * don't block the export.
 */
export function languageCode(code: string, map: Record<string, string>, direction: 'source' | 'target'): string {
	try {
		return direction === 'source' ? sourceCode(code, map) : targetCode(code, map);
	} catch {
		return code.replace(/_/g, '-');
	}
}

/** The source row's segments: per field the pieces `encode` makes (plain-text fields as plain text). */
export type Collected = {
	segments: FileSegment[];
	fields: { field: string; kind: FieldKind; enc: Encoded; keys: string[] }[];
};

export function collectSegments(fields: TranslatableField[], row: Record<string, any> | undefined): Collected {
	const out: Collected = { segments: [], fields: [] };
	for (const f of fields) {
		const value = row?.[f.field];
		const enc = encode(f.kind, value);
		if (!enc || !enc.pieces.length) continue;
		const keys = enc.pieces.map((_, i) => `${f.field}.${i}`);
		enc.pieces.forEach((piece, i) => {
			out.segments.push(f.kind === 'text' ? { key: keys[i]!, text: String(value).trim() } : { key: keys[i]!, text: piece.html, html: true });
		});
		out.fields.push({ field: f.field, kind: f.kind, enc, keys });
	}
	return out;
}

/**
 * Field values from imported translations (key → text): fields with at least one translated
 * piece, rebuilt like an API translation (pieces without a translation keep the source).
 */
export function valuesFromTranslations(collected: Collected, translations: Map<string, string>): Record<string, string> {
	const values: Record<string, string> = {};
	for (const { field, kind, enc, keys } of collected.fields) {
		if (!keys.some((k) => translations.has(k))) continue;
		values[field] = enc.rebuild(
			keys.map((k) => {
				const text = translations.get(k);
				if (text === undefined) return undefined;
				return kind === 'text' ? escapeHtml(text).replace(/\n/g, '<br>') : text;
			}),
		);
	}
	return values;
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_');

/** The file: XLIFF with one job per target language, or HTML for exactly one. */
export function buildExport(args: { collection: string; item: string; field: string; source: string; targets: string[]; format: Format; collected: Collected; languageMap?: Record<string, string> }) {
	const kind = FORMATS[args.format];
	if (!kind) throw new TranslateError('Choose XLIFF or HTML.', 400, 'invalid_format', {}, 'files.error.invalid_format');
	const targets = [...new Set(args.targets.filter((t) => t && t !== args.source))];
	if (!targets.length) throw new TranslateError('Choose at least one language to translate into.', 400, 'no_targets');
	if (args.format === 'html' && targets.length !== 1) throw new TranslateError('An HTML file holds exactly one target language.', 400, 'one_target', {}, 'files.error.one_target');
	if (!args.collected.segments.length) throw new TranslateError('Nothing to translate.', 400, 'nothing_to_translate', {}, 'files.error.nothing_to_translate');
	const map = args.languageMap ?? {};
	const jobs = targets.map((target) => ({
		plugin: PLUGIN,
		reference: formatReference({ collection: args.collection, item: args.item, field: args.field, source: args.source, target }),
		sourceLanguage: languageCode(args.source, map, 'source'),
		targetLanguage: languageCode(target, map, 'target'),
		segments: args.collected.segments,
	}));
	let content: string;
	try {
		content = args.format === 'html' ? TranslationFiles.exportHtml(jobs[0]!) : TranslationFiles.exportXliff(jobs);
	} catch (error) {
		if (error instanceof TranslationFileError && error.code === 'invalid_job') throw new TranslateError('Nothing to translate.', 400, 'nothing_to_translate', {}, 'files.error.nothing_to_translate');
		throw error;
	}
	return {
		filename: safeName(`${SHORT_NAME}-${args.item}${targets.length === 1 ? `-${targets[0]}` : ''}.${kind.extension}`),
		contentType: kind.contentType,
		content,
	};
}

export type Counts = { ok: number; source_changed: number; untranslated: number; invalid_markup: number; missing: number };

/** `accepted`: what to write (`ok`, and `source_changed` only with `includeChanged`). */
export function planImport(file: TranslationFile, collected: Collected, includeChanged = false) {
	const counts: Counts = { ok: 0, source_changed: 0, untranslated: 0, invalid_markup: 0, missing: 0 };
	const accepted = new Map<string, string>();
	for (const r of TranslationFiles.importTranslations(file, collected.segments)) {
		counts[r.status]++;
		if (r.text !== null && (r.status === 'ok' || (r.status === 'source_changed' && includeChanged))) accepted.set(r.key, r.text);
	}
	return { counts, accepted };
}

/** What the item form gets per job; `values` go into the form like an API translation. */
export type ImportJob = {
	reference: string;
	language: string | null;
	counts: Counts;
	imported: number;
	skippedChanged: number;
	ok: boolean;
	values: Record<string, string>;
	id: PrimaryKey | null;
	created: boolean;
	error?: { message: string; code: string; key: string; values: Record<string, string | number> };
};

/** The item the panel imports into, and what it needs per reference. */
export type ImportTarget = {
	collection: string;
	item: string;
	field: string;
	/** The languages of the translations field; the source row's segments; the target row's id. */
	load(source: string): Promise<{ languages: Set<string>; collected: Collected; ids: Record<string, PrimaryKey | null> }>;
};

/**
 * Reads the file and plans each job (no writing: the item form applies the values and the
 * editor saves). Too large and `read` errors throw; everything else is reported per job.
 */
export async function importJobs(content: string, target: ImportTarget, includeChanged = false): Promise<ImportJob[]> {
	if (Buffer.byteLength(content, 'utf8') > MAX_UPLOAD_BYTES) throw new TranslateError('The file is too large (at most 10 MB).', 413, 'too_large', {}, 'files.error.too_large');
	let files: TranslationFile[];
	try {
		files = TranslationFiles.read(content);
	} catch (error) {
		if (error instanceof TranslationFileError) throw new TranslateError(error.message, error.code === 'too_large' ? 413 : 400, error.code, {}, `files.error.${error.code}`);
		throw error;
	}
	const out: ImportJob[] = [];
	for (const file of files) {
		const job: ImportJob = { reference: file.reference, language: null, counts: { ok: 0, source_changed: 0, untranslated: 0, invalid_markup: 0, missing: 0 }, imported: 0, skippedChanged: 0, ok: false, values: {}, id: null, created: false };
		out.push(job);
		const fail = (message: string, code: string, values: Record<string, string | number> = {}) => {
			job.error = { message, code, key: `files.error.${code}`, values };
		};
		if (file.plugin !== PLUGIN) {
			fail(`This file belongs to another system (${file.plugin}).`, 'other_system', { plugin: file.plugin });
			continue;
		}
		const ref = parseReference(file.reference);
		if (!ref || ref.source === ref.target) {
			fail('The item this file was exported from no longer exists.', 'not_found');
			continue;
		}
		job.language = ref.target;
		if (ref.collection !== target.collection || ref.item !== target.item || ref.field !== target.field) {
			fail('This file belongs to another item. Import it there.', 'other_item', { reference: file.reference });
			continue;
		}
		let loaded;
		try {
			loaded = await target.load(ref.source);
		} catch (error) {
			if (error instanceof TranslateError && error.status === 404) {
				fail(error.message, 'not_found');
				continue;
			}
			throw error;
		}
		const missingLanguage = [ref.source, ref.target].find((l) => !loaded.languages.has(l));
		if (missingLanguage) {
			fail(`The project has no language ${missingLanguage}.`, 'no_language', { language: missingLanguage });
			continue;
		}
		const plan = planImport(file, loaded.collected, includeChanged);
		job.counts = plan.counts;
		job.skippedChanged = includeChanged ? 0 : plan.counts.source_changed;
		job.imported = plan.accepted.size;
		job.values = valuesFromTranslations(loaded.collected, plan.accepted);
		job.id = loaded.ids[ref.target] ?? null;
		job.created = job.id === null;
		job.ok = true;
	}
	return out;
}

/** Same rule as translating: only people who may change the item. */
async function requireUpdate(services: Services, schema: SchemaOverview, accountability: Accountability | null, collection: string, item: string) {
	if (!accountability) return;
	const perms = await new services.PermissionsService({ schema, accountability }).getItemPermissions(collection, item);
	if (!perms?.update?.access) throw new TranslateError('You are not allowed to edit this item.', 403, 'forbidden');
}

type Ctx = { services: Services; schema: SchemaOverview; accountability: Accountability | null; config: SupertextConfig };

/** POST /supertext/export: the item's source-language segments as a file. */
export async function exportItem(ctx: Ctx, args: { collection: string; item: string; field?: string; source?: string; targets: string[]; format: Format; fields?: string[] }) {
	await requireUpdate(ctx.services, ctx.schema, ctx.accountability, args.collection, args.item);
	const data = await loadItem(ctx.services, ctx.schema, ctx.accountability, args.collection, args.item, args.field, args.fields);
	const known = new Set(data.languages.map((l) => l.code));
	const source = args.source || data.defaultSource || '';
	if (!known.has(source)) throw new TranslateError(`Unknown source language "${source}".`, 400, 'unknown_language', { language: source }, 'error.unknown_source');
	const unknown = args.targets.filter((t) => !known.has(t));
	if (unknown.length) throw new TranslateError(`Unknown language(s): ${unknown.join(', ')}.`, 400, 'unknown_language', { languages: unknown.join(', ') });
	return buildExport({
		collection: args.collection,
		item: String(args.item),
		field: data.relation.field,
		source,
		targets: args.targets,
		format: args.format,
		collected: collectSegments(data.fields, data.rows[source]),
		languageMap: ctx.config.languageMap,
	});
}

/** POST /supertext/import: the jobs of an uploaded file for the item the panel shows. */
export async function importItem(ctx: Ctx, args: { collection: string; item: string; field?: string; fields?: string[]; content: string; includeChanged: boolean }) {
	await requireUpdate(ctx.services, ctx.schema, ctx.accountability, args.collection, args.item);
	const first = await loadItem(ctx.services, ctx.schema, ctx.accountability, args.collection, args.item, args.field, args.fields);
	return importJobs(
		args.content,
		{
			collection: args.collection,
			item: String(args.item),
			field: first.relation.field,
			load: async (source) => ({
				languages: new Set(first.languages.map((l) => l.code)),
				collected: collectSegments(first.fields, first.rows[source]),
				ids: Object.fromEntries(first.languages.map((l) => [l.code, l.id])),
			}),
		},
		args.includeChanged,
	);
}

/**
 * The request body as text, refused (`too_large`) above `limit` bytes: by its Content-Length
 * before anything is read, else while reading. Kept in memory only, never stored.
 */
export function readBody(req: any, limit = MAX_UPLOAD_BYTES): Promise<string> {
	const tooLarge = () => new TranslateError('The file is too large (at most 10 MB).', 413, 'too_large', {}, 'files.error.too_large');
	if (typeof req.body === 'string') return Buffer.byteLength(req.body) > limit ? Promise.reject(tooLarge()) : Promise.resolve(req.body);
	if (Number(req.headers?.['content-length'] ?? 0) > limit) return Promise.reject(tooLarge());
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let done = false;
		req.on('data', (chunk: Buffer) => {
			if (done) return;
			size += chunk.length;
			if (size > limit) {
				done = true;
				req.pause();
				reject(tooLarge());
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			if (!done) {
				done = true;
				resolve(Buffer.concat(chunks).toString('utf8'));
			}
		});
		req.on('error', (error: unknown) => {
			if (!done) {
				done = true;
				reject(error);
			}
		});
	});
}
