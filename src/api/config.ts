import type { Politeness, SupertextEnvironment } from '../shared/supertext-client.js';
import { REVIEW_URL, SUPERTEXT_ENVIRONMENTS } from '../shared/supertext-client.js';

/** Server-side settings, read from Directus's environment (`.env` / container variables). */
export type SupertextConfig = {
	apiKey: string;
	baseUrl: string;
	/** Review service for languages with *Translation review* on (SUPERTEXT_REVIEW_URL; '' = review off everywhere). */
	reviewUrl: string;
	/** Directus language code → true where *Translation review* is on (saved on the Supertext page). */
	review: Record<string, boolean>;
	languageMap: Record<string, string>;
	politeness: Record<string, Politeness>;
	pollIntervalMs: number;
	timeoutMs: number;
	/** How many languages are translated at the same time. */
	concurrency: number;
};

type Env = Record<string, unknown>;

/** Directus may hand over JSON env values already parsed (`json:` prefix) or as strings. */
function jsonObject(value: unknown, name: string): Record<string, string> {
	if (value === undefined || value === null || value === '') return {};
	// Directus' env parser turns a value containing a comma into an array: join it back.
	let v = Array.isArray(value) ? value.join(',') : value;
	if (typeof v === 'string') {
		try {
			v = JSON.parse(v);
		} catch {
			throw new Error(`${name} must be a JSON object, e.g. {"de-CH":"de-CH"}.`);
		}
	}
	if (typeof v !== 'object' || Array.isArray(v) || v === null) throw new Error(`${name} must be a JSON object.`);
	return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, String(val)]));
}

const num = (value: unknown, fallback: number) => {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Directus casts environment values on its own (a comma makes an array, digits a number),
 * which breaks JSON such as `{"de-CH":"more","fr-CH":"more"}`. The raw process variables
 * win for `SUPERTEXT_*`; Directus' parsed env (e.g. from its `.env` file) is the fallback.
 */
export function readConfig(directusEnv: Env, processEnv: Record<string, string | undefined> = globalThis.process?.env ?? {}): SupertextConfig {
	const env: Env = { ...directusEnv };
	for (const [key, value] of Object.entries(processEnv)) {
		if (key.startsWith('SUPERTEXT_') && value !== undefined) env[key] = value;
	}
	const environment = String(env.SUPERTEXT_ENVIRONMENT ?? 'live').toLowerCase() as SupertextEnvironment;
	const explicitUrl = String(env.SUPERTEXT_API_URL ?? '').trim();
	const baseUrl = explicitUrl || SUPERTEXT_ENVIRONMENTS[environment] || SUPERTEXT_ENVIRONMENTS.live;
	const politeness = jsonObject(env.SUPERTEXT_POLITENESS, 'SUPERTEXT_POLITENESS');
	for (const [lang, p] of Object.entries(politeness)) {
		if (!['default', 'more', 'less'].includes(p)) throw new Error(`SUPERTEXT_POLITENESS: "${lang}" must be default, more or less.`);
	}
	return {
		apiKey: String(env.SUPERTEXT_API_KEY ?? '').trim(),
		baseUrl,
		// Unset: Supertext's review service; set to an empty value: off for every language.
		reviewUrl: env.SUPERTEXT_REVIEW_URL === undefined || env.SUPERTEXT_REVIEW_URL === null ? REVIEW_URL : String(env.SUPERTEXT_REVIEW_URL).trim(),
		review: {},
		languageMap: jsonObject(env.SUPERTEXT_LANGUAGE_MAP, 'SUPERTEXT_LANGUAGE_MAP'),
		politeness: politeness as Record<string, Politeness>,
		pollIntervalMs: num(env.SUPERTEXT_POLL_INTERVAL, 2) * 1000,
		timeoutMs: num(env.SUPERTEXT_TIMEOUT, 180) * 1000,
		concurrency: Math.floor(num(env.SUPERTEXT_CONCURRENCY, 3)),
	};
}
