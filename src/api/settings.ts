/**
 * The language mapping chosen on the Supertext page (one combo box per Directus language),
 * stored as JSON in `supertext_state` (key `languages`) next to the reporter's state.
 * SUPERTEXT_LANGUAGE_MAP / SUPERTEXT_POLITENESS stay as overrides for automated setups:
 * an environment entry wins over the saved one for that language.
 *
 * Plain functions without Directus imports (unit-tested); the endpoint and the Flow
 * operation load the settings with `loadLanguageSettings()` and merge them with `withLanguageSettings()`.
 */
import { Languages } from 'supertext-sdk/v1';
import type { Politeness } from '../shared/supertext-client.js';
import type { SupertextConfig } from './config.js';
import { StateStore } from './reporting.js';

export const LANGUAGES_KEY = 'languages';

export type LanguageSettings = {
	/** Directus language code → Supertext target code. */
	codes: Record<string, string>;
	/** Directus language code → tone; only `more`/`less` are stored. */
	politeness: Record<string, Politeness>;
	/** Directus language code → true where *Translation review* is on (translations into it go through the review service). */
	review: Record<string, true>;
};

const POLITENESS: readonly Politeness[] = ['default', 'more', 'less'];
const TARGET_CODES = new Set(Languages.TARGETS.map((t) => t.code));

export const emptyLanguageSettings = (): LanguageSettings => ({ codes: {}, politeness: {}, review: {} });

/** Reads stored JSON leniently: anything that isn't a valid entry is dropped. */
export function parseLanguageSettings(raw: string | null | undefined): LanguageSettings {
	const settings = emptyLanguageSettings();
	if (!raw) return settings;
	let value: any;
	try {
		value = JSON.parse(raw);
	} catch {
		return settings;
	}
	for (const [lang, code] of Object.entries(value?.codes ?? {})) {
		if (typeof code === 'string' && TARGET_CODES.has(code)) settings.codes[lang] = code;
	}
	for (const [lang, p] of Object.entries(value?.politeness ?? {})) {
		if (p === 'more' || p === 'less') settings.politeness[lang] = p;
	}
	for (const [lang, on] of Object.entries(value?.review ?? {})) {
		if (on === true) settings.review[lang] = true;
	}
	return settings;
}

/** A rejected entry of a save request; the endpoint turns it into HTTP 400. */
export class LanguageSettingsError extends Error {
	constructor(
		message: string,
		readonly values: Record<string, string>,
	) {
		super(message);
		this.name = 'LanguageSettingsError';
	}
}

export type LanguageChange = { language: string; target: string | null; politeness?: string; /** *Translation review*; omitted: unchanged. */ review?: boolean };

/**
 * Applies the rows the Supertext page sends (`target` null or '' clears the language) to the
 * saved settings (`review` other than true/false keeps the language's *Translation review*). Every target must be one of Supertext's codes; a tone is kept only where
 * the target offers formal/informal.
 */
export function applyLanguageChanges(current: LanguageSettings, changes: unknown): LanguageSettings {
	if (!Array.isArray(changes)) throw new LanguageSettingsError('"languages" must be a list.', { language: '', code: '' });
	const next: LanguageSettings = { codes: { ...current.codes }, politeness: { ...current.politeness }, review: { ...current.review } };
	for (const change of changes as LanguageChange[]) {
		const language = typeof change?.language === 'string' ? change.language.trim() : '';
		if (!language) throw new LanguageSettingsError('Each entry needs a "language".', { language: '', code: '' });
		const target = change.target === null || change.target === undefined ? '' : String(change.target).trim();
		if (target && !TARGET_CODES.has(target)) {
			throw new LanguageSettingsError(`"${target}" is not a Supertext language code.`, { language, code: target });
		}
		const politeness = (change.politeness ?? 'default') as Politeness;
		if (!POLITENESS.includes(politeness)) throw new LanguageSettingsError(`Tone "${politeness}" must be default, more or less.`, { language, code: String(politeness) });
		if (target) next.codes[language] = target;
		else delete next.codes[language];
		const effective = target || Languages.suggestTarget(language);
		if (politeness !== 'default' && effective && Languages.supportsPoliteness(effective)) next.politeness[language] = politeness;
		else delete next.politeness[language];
		if (change.review === true) next.review[language] = true;
		else if (change.review === false) delete next.review[language];
	}
	return next;
}

/** The configuration with the saved mapping, tones and *Translation review*; environment entries win per language. */
export function withLanguageSettings(config: SupertextConfig, saved: LanguageSettings): SupertextConfig {
	return {
		...config,
		languageMap: { ...saved.codes, ...config.languageMap },
		politeness: { ...saved.politeness, ...config.politeness },
		review: { ...config.review, ...saved.review },
	};
}

type Logger = { warn: (msg: string) => void };

/** The saved settings; empty (environment and defaults only) when they can't be read. */
export async function loadLanguageSettings(store: StateStore, logger?: Logger): Promise<LanguageSettings> {
	try {
		return parseLanguageSettings(await store.read(LANGUAGES_KEY));
	} catch (error) {
		logger?.warn(`[supertext] language settings not readable: ${(error as Error)?.message ?? error}`);
		return emptyLanguageSettings();
	}
}

export async function saveLanguageSettings(store: StateStore, settings: LanguageSettings): Promise<void> {
	await store.write(LANGUAGES_KEY, JSON.stringify(settings));
}
