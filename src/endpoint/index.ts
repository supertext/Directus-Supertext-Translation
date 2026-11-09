import { defineEndpoint } from '@directus/extensions-sdk';
import { readConfig } from '../api/config.js';
import { findTranslationsRelation, loadItem, translateItem, TranslateError } from '../api/translator.js';
import { SupertextClient } from '../shared/supertext-client.js';
import { politenessFor, suggestTarget, supportsPoliteness, targetCodeOrNull, targetOptions } from '../shared/languages.js';
import { extensionVersion, userAgent } from '../api/version.js';
import { Reporting, siteUrl } from '../api/reporting.js';
import { exportItem, importItem, readBody, type Format } from '../api/files.js';
import { applyLanguageChanges, LanguageSettingsError, loadLanguageSettings, saveLanguageSettings, withLanguageSettings } from '../api/settings.js';

/**
 * /supertext/info       GET  ?collection=&item=&field=   languages, fields, whether a key is set
 * /supertext/translate  POST { collection, item, field?, source?, targets?, fields?, save? }
 * /supertext/status     GET  version, configuration and languages (admins; the Supertext module)
 * /supertext/languages  POST { languages: [{ language, target, politeness, review }] } saves the language mapping (admins)
 * /supertext/test       POST cost-free check of the API key (admins)
 * /supertext/ping       GET  ?challenge=   public: the Commando Center's reachability check
 * /supertext/export     POST { collection, item, field?, source?, targets, format: 'xliff'|'html', fields? }  the file (download)
 * /supertext/import     POST ?collection=&item=&field=&includeChanged=1, body: the file (text, ≤ 10 MB)  the jobs for the form
 *
 * Both run with the signed-in user's permissions. `save` defaults to false: the item
 * form puts the translations into the form and the editor saves them.
 */
export default defineEndpoint({
	id: 'supertext',
	handler: (router, { services, getSchema, env, logger, database }) => {
		const reporting = new Reporting({ env, database, logger });
		/** The environment's settings with the language mapping saved on the Supertext page (the environment wins per language). */
		const settings = async () => {
			const fromEnv = readConfig(env);
			const saved = await loadLanguageSettings(reporting.store, logger);
			return { env: fromEnv, saved, config: withLanguageSettings(fromEnv, saved) };
		};
		/** Version report and key check on back-end requests (in the background, see api/reporting.ts). */
		const report = (req: any, config: ReturnType<typeof readConfig>) => reporting.inBackground('onRequest', config, siteUrl(env, req));

		// Public, no login: the Commando Center checks that the site is reachable. Only while version reports are on.
		router.get('/ping', (req: any, res: any) => {
			const answer = reporting.ping(req.query?.challenge);
			res.status(answer.status).set(answer.headers).send(answer.body);
		});

		const fail = (res: any, error: unknown) => {
			if (error instanceof TranslateError) {
				return res.status(error.status).json({ errors: [{ message: error.message, extensions: { code: error.code, key: error.key, values: error.values } }] });
			}
			const e = error as any;
			const status = typeof e?.status === 'number' ? e.status : 500;
			if (status >= 500) logger.error(`[supertext] ${e?.stack ?? e}`);
			return res.status(status).json({ errors: [{ message: e?.message ?? 'Unexpected error', extensions: { code: e?.code ?? 'INTERNAL' } }] });
		};

		const requireUser = (req: any) => {
			if (!req.accountability?.user) throw new TranslateError('Sign in to use Supertext.', 401, 'unauthenticated');
		};

		const requireAdmin = (req: any) => {
			requireUser(req);
			if (!req.accountability.admin) throw new TranslateError('Only administrators can do this.', 403, 'forbidden', {}, 'error.admin_only');
		};

		router.get('/status', async (req: any, res: any) => {
			try {
				requireAdmin(req);
				const schema = req.schema ?? (await getSchema());
				const { env: fromEnv, saved, config } = await settings();
				// Every languages collection used by a translations field, with its rows.
				const languageCollections = new Map<string, string>();
				for (const collection of Object.keys(schema.collections)) {
					try {
						const rel = findTranslationsRelation(schema, collection);
						languageCollections.set(rel.languages, rel.languagePk);
					} catch {
						// not a collection with translations
					}
				}
				// One row per language code (the mapping is per code, also when two collections list it).
				const languages: Record<string, unknown>[] = [];
				const seen = new Set<string>();
				for (const [collection, pk] of languageCollections) {
					const rows: any[] = await new services.ItemsService(collection, { schema, accountability: req.accountability }).readByQuery({ limit: -1, sort: [pk] });
					for (const row of rows) {
						const code = String(row[pk]);
						if (seen.has(code)) continue;
						seen.add(code);
						const target = targetCodeOrNull(code, config.languageMap);
						languages.push({
							collection,
							code,
							name: String(row.name ?? code),
							/** Sent to Supertext: the mapping, else exact match, else the SDK default; null: unsupported_language. */
							target,
							saved: saved.codes[code] ?? null,
							override: fromEnv.languageMap[code] ?? null,
							suggested: suggestTarget(code),
							politeness: politenessFor(code, config.politeness),
							savedPoliteness: saved.politeness[code] ?? 'default',
							politenessOverride: fromEnv.politeness[code] ?? null,
							politenessSupported: target ? supportsPoliteness(target) : null,
							/** *Translation review* on: translations into this language go through the review service. */
							review: config.review[code] === true,
						});
					}
				}
				report(req, config);
				res.json({
					data: {
						version: extensionVersion(),
						reports: { enabled: reporting.enabled, check: await reporting.lastCheck() },
						configured: config.apiKey !== '',
						baseUrl: config.baseUrl,
						/** '' when review is off for every language (SUPERTEXT_REVIEW_URL empty). */
						reviewUrl: config.reviewUrl,
						concurrency: config.concurrency,
						timeoutSeconds: config.timeoutMs / 1000,
						languages,
						/** The combo box's choices: Supertext's target codes (SDK), sorted by English name. */
						targets: targetOptions().map(({ code, name, politeness }) => ({ code, name, politeness })),
					},
				});
			} catch (error) {
				fail(res, error);
			}
		});

		router.post('/languages', async (req: any, res: any) => {
			try {
				requireAdmin(req);
				const { env: fromEnv, saved } = await settings();
				let next;
				try {
					next = applyLanguageChanges(saved, req.body?.languages);
				} catch (error) {
					if (error instanceof LanguageSettingsError) throw new TranslateError(error.message, 400, 'invalid_language_setting', error.values);
					throw error;
				}
				await saveLanguageSettings(reporting.store, next);
				// Version report `settings_saved` with the key check (background).
				reporting.inBackground('settingsSaved', fromEnv, siteUrl(env, req));
				res.json({ data: next });
			} catch (error) {
				fail(res, error);
			}
		});

		router.post('/test', async (req: any, res: any) => {
			try {
				requireAdmin(req);
				const config = readConfig(env);
				// The automatic key check (SDK): ok, invalid, missing, unreachable or error. Also reports a changed status.
				const result = await reporting.run('testConnection', config, siteUrl(env, req));
				const check = result?.check ?? (await new SupertextClient({ apiKey: config.apiKey, baseUrl: config.baseUrl, userAgent: userAgent() }).checkApiKey());
				res.json({ data: { ok: check.status === 'ok', check } });
			} catch (error) {
				fail(res, error);
			}
		});

		router.get('/info', async (req: any, res: any) => {
			try {
				requireUser(req);
				const { collection, item, field } = req.query as Record<string, string>;
				if (!collection) throw new TranslateError('"collection" is required.');
				const schema = req.schema ?? (await getSchema());
				const { config } = await settings();
				report(req, config);
				const data = await loadItem(services, schema, req.accountability, collection, item && item !== '+' ? item : null, field || undefined);
				res.json({
					data: {
						configured: config.apiKey !== '',
						relation: data.relation,
						defaultSource: data.defaultSource,
						fields: data.fields,
						languages: data.languages,
					},
				});
			} catch (error) {
				fail(res, error);
			}
		});

		// Export for translation: the item's segments as an XLIFF or HTML file (lib: api/files.ts).
		router.post('/export', async (req: any, res: any) => {
			try {
				requireUser(req);
				const body = req.body ?? {};
				if (typeof body.collection !== 'string' || body.item === undefined || body.item === null || body.item === '') {
					throw new TranslateError('"collection" and "item" are required.');
				}
				const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : []);
				const { config } = await settings();
				const file = await exportItem(
					{ services, schema: req.schema ?? (await getSchema()), accountability: req.accountability, config },
					{
						collection: body.collection,
						item: String(body.item),
						field: typeof body.field === 'string' && body.field ? body.field : undefined,
						source: typeof body.source === 'string' ? body.source : undefined,
						targets: list(body.targets),
						format: (body.format === 'html' ? 'html' : 'xliff') as Format,
						fields: Array.isArray(body.fields) && body.fields.length ? body.fields.map(String) : undefined,
					},
				);
				report(req, config);
				res.set({
					'Content-Type': file.contentType,
					'Content-Disposition': `attachment; filename="${file.filename}"`,
					'Cache-Control': 'no-store',
					'X-Content-Type-Options': 'nosniff',
				});
				res.send(file.content);
			} catch (error) {
				fail(res, error);
			}
		});

		// Import translation: reads the uploaded file in memory and returns, per job, the values
		// for the item form (written like a translation: into the form, the editor saves).
		router.post('/import', async (req: any, res: any) => {
			try {
				requireUser(req);
				const q = (req.query ?? {}) as Record<string, string>;
				if (!q.collection || !q.item) throw new TranslateError('"collection" and "item" are required.');
				const content = await readBody(req);
				const { config } = await settings();
				const jobs = await importItem(
					{ services, schema: req.schema ?? (await getSchema()), accountability: req.accountability, config },
					{
						collection: q.collection,
						item: q.item,
						field: q.field || undefined,
						fields: q.fields ? String(q.fields).split(',').filter(Boolean) : undefined,
						content,
						includeChanged: q.includeChanged === '1' || q.includeChanged === 'true',
					},
				);
				report(req, config);
				res.json({ data: { jobs } });
			} catch (error) {
				fail(res, error);
			}
		});

		router.post('/translate', async (req: any, res: any) => {
			try {
				requireUser(req);
				const body = req.body ?? {};
				if (typeof body.collection !== 'string' || body.item === undefined || body.item === null || body.item === '') {
					throw new TranslateError('"collection" and "item" are required.');
				}
				const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : undefined);
				const { config } = await settings();
				const result = await translateItem({
					services,
					schema: req.schema ?? (await getSchema()),
					accountability: req.accountability,
					config,
					collection: body.collection,
					item: body.item,
					field: typeof body.field === 'string' && body.field ? body.field : undefined,
					source: typeof body.source === 'string' ? body.source : undefined,
					targets: list(body.targets),
					fields: list(body.fields),
					save: body.save === true,
				});
				for (const r of result.results) {
					if (!r.ok) logger.warn(`[supertext] ${body.collection}/${body.item} → ${r.language}: ${r.error}`);
				}
				const rejected = result.results.find((r) => !r.ok && r.code === 'authentication_failure');
				if (rejected) reporting.inBackground('authenticationFailed', config, siteUrl(env, req), Number(rejected.values?.status) || 401);
				else report(req, config);
				res.json({ data: result });
			} catch (error) {
				fail(res, error);
			}
		});
	},
});
