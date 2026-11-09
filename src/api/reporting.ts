/**
 * Version reports to the Supertext Commando Center, the automatic API key check and the
 * callback ping (Commando-Center-Supertext-Translation → docs/DEVELOPER.md → Report protocol).
 * The protocol is Supertext Plugin Health's (`InstallationReporter`, `pingResponse`; bundled
 * from vendor/supertext-plugin-health), the key check the Supertext SDK's (`checkApiKey()`,
 * `apiKeyFingerprint`). This file only gives them what Directus knows: the site URL, the Directus and extension versions, and a place to keep
 * the reporter's state (the table `supertext_state`, created on first use, which also holds the saved language mapping).
 *
 * The only settings form is the language mapping on the Supertext page; saving it reports
 * `settings_saved`. The key itself is in the environment, so the key check runs when the key
 * from SUPERTEXT_API_KEY changed (fingerprint), on "Test connection", after saving the
 * languages and after a 401/403 from Supertext.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Knex } from 'knex';
import { InstallationReporter, pingResponse, reporterState, reportsEnabled, type KeyCheck, type PingResponse, type ReporterOptions, type ReporterResult, type ReporterState } from 'supertext-plugin-health';
import { SDK_VERSION } from 'supertext-sdk';
import { apiKeyFingerprint, SupertextClient, type SupertextClientOptions } from 'supertext-sdk/v1';
import type { SupertextConfig } from './config.js';
import { extensionVersion } from './version.js';

export const PLUGIN_NAME = 'Directus-Supertext-Translation';
export const STATE_TABLE = 'supertext_state';
const STATE_KEY = 'reporter';
/** Path of the ping route below Directus' public URL (endpoint id `supertext`). */
export const PING_PATH = 'supertext/ping';

type Env = Record<string, unknown>;
type Logger = { debug: (msg: string) => void; warn: (msg: string) => void };

/** Whether version reports are on: SUPERTEXT_VERSION_REPORTS (default on). */
export function versionReportsEnabled(env: Env, processEnv: Record<string, string | undefined> = globalThis.process?.env ?? {}): boolean {
	const raw = processEnv.SUPERTEXT_VERSION_REPORTS ?? env.SUPERTEXT_VERSION_REPORTS;
	// Directus casts env values: `0`/`false` may arrive as a number or boolean.
	return reportsEnabled(null, raw === undefined || raw === null ? null : String(raw));
}

/** Directus' PUBLIC_URL as an absolute http(s) URL without trailing slash, else null. */
export function publicUrl(env: Env): string | null {
	const value = String(env.PUBLIC_URL ?? '').trim();
	if (!/^https?:\/\/[^/]/i.test(value)) return null;
	return value.replace(/\/+$/, '');
}

/** The site's base URL: PUBLIC_URL, else what the request was sent to. */
export function siteUrl(env: Env, req?: { protocol?: string; get?: (name: string) => string | undefined }): string | null {
	const configured = publicUrl(env);
	if (configured) return configured;
	const host = req?.get?.('host');
	if (!host) return null;
	return `${req?.protocol === 'https' ? 'https' : 'http'}://${host}`;
}

let directusVersionCache: string | null | undefined;

/** The installed Directus version (the `directus` package that runs, or the one next to the project), or null. */
export function directusVersion(): string | null {
	if (directusVersionCache !== undefined) return directusVersionCache;
	directusVersionCache = null;
	// `directus start` runs node_modules/directus/cli.js: its package.json is the running Directus.
	try {
		for (let dir = dirname(realpathSync(process.argv[1] ?? '')), i = 0; i < 4; i++, dir = dirname(dir)) {
			const file = join(dir, 'package.json');
			if (!existsSync(file)) continue;
			const pkg = JSON.parse(readFileSync(file, 'utf8'));
			if (pkg?.name === 'directus' && typeof pkg.version === 'string') return (directusVersionCache = pkg.version);
		}
	} catch {
		// no script path (tests, REPL)
	}
	for (const base of [process.cwd(), join(process.cwd(), 'node_modules')]) {
		try {
			const version = createRequire(join(base, 'package.json'))('directus/package.json')?.version;
			if (typeof version === 'string') {
				directusVersionCache = version;
				break;
			}
		} catch {
			// not found from here
		}
	}
	return directusVersionCache ?? null;
}

/** Reads and writes the extension's state in `supertext_state` (one JSON row per key: `reporter`, `languages`). */
export class StateStore {
	#ready: Promise<void> | null = null;

	constructor(private readonly database: Knex) {}

	async #ensureTable(): Promise<void> {
		this.#ready ??= (async () => {
			if (!(await this.database.schema.hasTable(STATE_TABLE))) {
				await this.database.schema.createTable(STATE_TABLE, (t) => {
					t.string('key', 64).primary();
					t.text('value');
				});
			}
		})().catch((error) => {
			this.#ready = null;
			throw error;
		});
		return this.#ready;
	}

	/** The stored JSON of a key, or null. */
	async read(key: string): Promise<string | null> {
		await this.#ensureTable();
		const row = await this.database(STATE_TABLE).where({ key }).first('value');
		return row?.value ?? null;
	}

	async write(key: string, value: string): Promise<void> {
		await this.#ensureTable();
		const updated = await this.database(STATE_TABLE).where({ key }).update({ value });
		if (!updated) await this.database(STATE_TABLE).insert({ key, value });
	}

	async load(): Promise<ReporterState> {
		return reporterState(await this.read(STATE_KEY));
	}

	async save(state: ReporterState): Promise<void> {
		await this.write(STATE_KEY, JSON.stringify(state));
	}
}

export type ReportingContext = {
	env: Env;
	database: Knex;
	logger: Logger;
	/** For tests: options passed to Plugin Health's reporter (fetch, report URL, clock) and the SDK client of the key check. */
	reporterOverrides?: Partial<ReporterOptions> & { clientOptions?: SupertextClientOptions };
};

type Action = 'onRequest' | 'testConnection' | 'authenticationFailed' | 'settingsSaved';

/**
 * The extension's side of the Commando Center: one per endpoint/operation registration.
 * Calls are serialized (one at a time per process) so two requests don't report twice.
 */
export class Reporting {
	readonly store: StateStore;
	#queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly ctx: ReportingContext) {
		this.store = new StateStore(ctx.database);
	}

	get enabled(): boolean {
		return versionReportsEnabled(this.ctx.env);
	}

	/** The ping route's answer. */
	ping(challenge: unknown): PingResponse {
		return pingResponse(typeof challenge === 'string' ? challenge : null, { plugin: PLUGIN_NAME, enabled: this.enabled });
	}

	reporter(config: SupertextConfig, url: string): InstallationReporter {
		const { clientOptions: overrideClientOptions, ...overrides } = this.ctx.reporterOverrides ?? {};
		const clientOptions: SupertextClientOptions = {
			baseUrl: config.baseUrl,
			userAgent: `${PLUGIN_NAME}/${extensionVersion() ?? '0.0.0'}`,
			...(overrides.now ? { now: overrides.now } : {}),
			...overrideClientOptions,
		};
		return new InstallationReporter({
			enabled: this.enabled,
			siteUrl: url,
			plugin: { name: PLUGIN_NAME, version: extensionVersion() ?? '0.0.0' },
			system: { name: 'Directus', version: directusVersion() },
			sdkVersion: SDK_VERSION,
			callbackUrl: `${url}/${PING_PATH}`,
			keyChecker: { check: (apiKey) => new SupertextClient(apiKey, clientOptions).checkApiKey(), fingerprint: apiKeyFingerprint },
			...overrides,
		});
	}

	/** Runs one reporter action with the stored state and stores the result. Never throws. */
	run(action: Action, config: SupertextConfig, url: string | null, httpStatus?: number): Promise<ReporterResult | null> {
		const task = this.#queue.then(async () => {
			if (!url) return null;
			try {
				const reporter = this.reporter(config, url);
				const state = await this.store.load();
				const result =
					action === 'authenticationFailed'
						? await reporter.authenticationFailed(state, config.apiKey, httpStatus ?? 401)
						: action === 'testConnection'
							? await reporter.testConnection(state, config.apiKey)
							: action === 'settingsSaved'
								? await reporter.afterSettingsSaved(state, config.apiKey)
								: await reporter.onRequest(state, config.apiKey);
				await this.store.save(result.state);
				if (result.event) this.ctx.logger.debug(`[supertext] version report ${result.event}: ${result.sent ? 'sent' : 'not sent'}`);
				return result;
			} catch (error) {
				this.ctx.logger.debug(`[supertext] version report skipped: ${(error as Error)?.message ?? error}`);
				return null;
			}
		});
		this.#queue = task;
		return task;
	}

	/** For back-end requests: runs in the background, so the request doesn't wait for Supertext or the center. */
	inBackground(action: Action, config: SupertextConfig, url: string | null, httpStatus?: number): void {
		void this.run(action, config, url, httpStatus);
	}

	/** The latest stored key check (for the status page). */
	async lastCheck(): Promise<KeyCheck | null> {
		try {
			return (await this.store.load()).keyCheck;
		} catch {
			return null;
		}
	}
}
