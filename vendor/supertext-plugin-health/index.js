/**
 * Supertext Plugin Health: version reports to the Supertext Plugin Health dashboard, the API key check
 * result and the plugin's ping endpoint (../spec/reporter.json; protocol: the dashboard's
 * docs/DEVELOPER.md → Report protocol).
 *
 * The reporter is stateless: the plugin loads its `ReporterState` (a plain JSON object), passes it
 * in, and stores the state it gets back. It never talks to Supertext itself: the plugin passes a
 * key checker built on the Supertext SDK (`client.checkApiKey()` and `apiKeyFingerprint()`).
 *
 * One key: pass it as a string (reported as api_key_configured and api_key_check). Several keys
 * (e.g. AI translation and professional orders): pass `{ name: key }` in the order the settings show
 * them; each is checked and reported by name in api_keys.
 */
// Inlined from config.json by scripts/vendor-plugin-health.sh.
const config = {"reportUrl":"https://pluginhealth.supertext.com/api/v1/report"};
export const PLUGIN_HEALTH_VERSION = '0.4.0';
/** The live Plugin Health dashboard, from config.json (plugin-health/config.json). SUPERTEXT_REPORT_URL overrides it. */
export const DEFAULT_REPORT_URL = config.reportUrl;
export const REPORT_TIMEOUT_MS = 3_000;
export const FAILURE_BACKOFF_MS = 3_600_000;
/** At most this many named keys are checked and reported; the rest are ignored. */
export const MAX_API_KEYS = 20;
/** At most this many installed plugins are sent; the rest are left out. */
export const MAX_EXTENSIONS = 500;
/**
 * The list as it is sent: names and versions trimmed (100 and 50 characters), types in lower case
 * (30), blank names and repeats (same type and name, ignoring case) dropped, at most MAX_EXTENSIONS.
 */
export function normalizeExtensions(list) {
    const out = [];
    const seen = new Set();
    for (const e of list) {
        if (out.length >= MAX_EXTENSIONS)
            break;
        if (!e || typeof e !== 'object' || typeof e.name !== 'string')
            continue;
        const name = e.name.trim().slice(0, 100);
        if (!name)
            continue;
        const type = typeof e.type === 'string' ? e.type.trim().toLowerCase().slice(0, 30) : '';
        const id = `${type}\u0000${name.toLowerCase()}`;
        if (seen.has(id))
            continue;
        seen.add(id);
        const entry = { name };
        const version = typeof e.version === 'string' ? e.version.trim().slice(0, 50) : '';
        if (version)
            entry.version = version;
        if (typeof e.active === 'boolean')
            entry.active = e.active;
        if (type)
            entry.type = type;
        out.push(entry);
    }
    return out;
}
/** At most this many languages are sent; the rest are left out. */
export const MAX_LANGUAGES = 100;
/**
 * The mapping as it is sent: codes trimmed and cut to 35 characters, a blank Supertext code sent as null,
 * blank codes and repeats (same code, ignoring case) dropped, at most MAX_LANGUAGES.
 */
export function normalizeLanguages(list) {
    const out = [];
    const seen = new Set();
    for (const l of list) {
        if (out.length >= MAX_LANGUAGES)
            break;
        if (!l || typeof l !== 'object' || typeof l.code !== 'string')
            continue;
        const code = l.code.trim().slice(0, 35);
        if (!code || seen.has(code.toLowerCase()))
            continue;
        seen.add(code.toLowerCase());
        const supertext = typeof l.supertext === 'string' ? l.supertext.trim().slice(0, 35) : '';
        out.push({ code, supertext: supertext || null });
    }
    return out;
}
export const EMPTY_REPORTER_STATE = Object.freeze({
    reportedVersions: null,
    reportedKeyStatus: null,
    lastFailureAt: null,
    keyCheck: null,
    keyChecks: null,
    reportedKeyStatuses: null,
});
/** A key check from any object with the KeyCheck fields (e.g. the SDK's ApiKeyCheck); null if it has none. */
export function keyCheck(value) {
    const k = value && typeof value === 'object' ? value : null;
    if (!k || typeof k.status !== 'string' || typeof k.checkedAt !== 'string')
        return null;
    return {
        status: k.status,
        checkedAt: k.checkedAt,
        httpStatus: typeof k.httpStatus === 'number' ? k.httpStatus : null,
        errorCode: typeof k.errorCode === 'string' ? k.errorCode : null,
        fingerprint: typeof k.fingerprint === 'string' ? k.fingerprint : '',
    };
}
/** A stored state (parsed JSON, a JSON string, or anything) as a `ReporterState`; unknown or broken values become empty. */
export function reporterState(value) {
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        }
        catch {
            value = null;
        }
    }
    const o = value && typeof value === 'object' ? value : {};
    const s = (v) => (typeof v === 'string' ? v : null);
    const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
    let keyChecks = null;
    const kc = obj(o.keyChecks);
    if (kc) {
        keyChecks = {};
        for (const [name, value] of Object.entries(kc)) {
            const c = keyCheck(value);
            if (c)
                keyChecks[name] = c;
        }
    }
    let reportedKeyStatuses = null;
    const rk = obj(o.reportedKeyStatuses);
    if (rk) {
        reportedKeyStatuses = {};
        for (const [name, value] of Object.entries(rk))
            if (typeof value === 'string')
                reportedKeyStatuses[name] = value;
    }
    return {
        reportedVersions: s(o.reportedVersions),
        reportedKeyStatus: s(o.reportedKeyStatus),
        lastFailureAt: s(o.lastFailureAt),
        keyCheck: keyCheck(o.keyCheck),
        keyChecks,
        reportedKeyStatuses,
    };
}
/** The named keys as [name, key] pairs (at most MAX_API_KEYS, names trimmed, blank and repeated names dropped). */
function namedKeys(apiKeys) {
    const out = [];
    for (const [raw, key] of Object.entries(apiKeys)) {
        const name = raw.trim().slice(0, 60);
        if (!name || out.some(([n]) => n === name))
            continue;
        out.push([name, typeof key === 'string' ? key : '']);
        if (out.length >= MAX_API_KEYS)
            break;
    }
    return out;
}
/**
 * Whether version reports are on: `SUPERTEXT_VERSION_REPORTS` (0/false/off/no, 1/true/on/yes)
 * wins over the setting; the setting defaults to on.
 */
export function reportsEnabled(setting, env = processEnv('SUPERTEXT_VERSION_REPORTS')) {
    const value = (env ?? '').trim().toLowerCase();
    if (['0', 'false', 'off', 'no'].includes(value))
        return false;
    if (['1', 'true', 'on', 'yes'].includes(value))
        return true;
    return setting ?? true;
}
const CHALLENGE = /^[A-Za-z0-9_-]{16,64}$/;
/**
 * The answer of the plugin's public ping endpoint (`GET <callback>?challenge=<c>`).
 * Only while reporting is on (else 404). Nothing a caller sends is reflected unless it matches the pattern.
 */
export function pingResponse(challenge, options) {
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    if (!options.enabled)
        return { status: 404, headers, body: '{"ok":false}' };
    if (typeof challenge !== 'string' || !CHALLENGE.test(challenge))
        return { status: 400, headers, body: '{"ok":false}' };
    return { status: 200, headers, body: JSON.stringify({ ok: true, plugin: options.plugin, challenge }) };
}
export class InstallationReporter {
    #options;
    #now;
    #fetch;
    reportUrl;
    constructor(options) {
        this.#options = options;
        this.#now = options.now ?? Date.now;
        this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
        this.reportUrl = options.reportUrl || processEnv('SUPERTEXT_REPORT_URL') || DEFAULT_REPORT_URL;
    }
    /** Whether reports are sent (the ping endpoint answers only then). */
    get enabled() {
        return this.#options.enabled;
    }
    /** `<plugin>|<system>|<runtime>` versions. */
    get versions() {
        return [this.#options.plugin.version, this.#options.system.version ?? '', this.#runtime().version ?? ''].join('|');
    }
    /** After the plugin's settings were saved: checks the key(s), reports `installed` or `settings_saved`. */
    async afterSettingsSaved(state, apiKeys) {
        const current = await this.#withChecks(state ?? EMPTY_REPORTER_STATE, apiKeys, true);
        return this.#reportIfDue(current, current.reportedVersions === null ? 'installed' : 'settings_saved');
    }
    /** On back-end requests that run the plugin's code: checks changed keys, reports what changed. */
    async onRequest(state, apiKeys) {
        const current = await this.#withChecks(state ?? EMPTY_REPORTER_STATE, apiKeys, false);
        return this.#reportIfDue(current, this.#dueEvent(current));
    }
    /**
     * A translation was rejected with 401/403: the key is invalid (no check against Supertext). With
     * several keys, `keyName` says which one (the others keep their result).
     */
    async authenticationFailed(state, apiKeys, httpStatus = 401, keyName) {
        const invalid = (key) => ({
            status: 'invalid',
            checkedAt: isoSeconds(this.#now()),
            httpStatus,
            errorCode: null,
            fingerprint: this.#options.keyChecker.fingerprint(key),
        });
        const base = state ?? EMPTY_REPORTER_STATE;
        let current;
        if (typeof apiKeys === 'string') {
            current = { ...base, keyCheck: invalid(apiKeys), keyChecks: null, reportedKeyStatuses: null, reportedKeyStatus: base.keyChecks !== null ? null : base.reportedKeyStatus };
        }
        else {
            current = await this.#withChecks(base, apiKeys, false);
            const keyChecks = { ...(current.keyChecks ?? {}) };
            for (const [name, key] of namedKeys(apiKeys))
                if (keyName == null || name === keyName.trim())
                    keyChecks[name] = invalid(key);
            current = { ...current, keyChecks };
        }
        return this.#reportIfDue(current, this.#dueEvent(current));
    }
    /** The "Test connection" button: checks the key(s), reports a change. */
    async testConnection(state, apiKeys) {
        const current = await this.#withChecks(state ?? EMPTY_REPORTER_STATE, apiKeys, true);
        return this.#reportIfDue(current, this.#dueEvent(current));
    }
    /** Sends a `check` report now (commands, tests), even after a recent failure. */
    async reportCheck(state) {
        return this.#send(state ?? EMPTY_REPORTER_STATE, 'check');
    }
    /**
     * The plugin's "Send installed plugins to Supertext" button: sends event `extensions` with the list
     * now, even after a recent failure, but only while reporting is on (`sent` false otherwise).
     */
    async sendExtensions(state, extensions) {
        return this.#send(state ?? EMPTY_REPORTER_STATE, 'extensions', normalizeExtensions(extensions));
    }
    /**
     * The plugin's "Send language settings to Supertext" button: sends event `languages` with the mapping
     * now, even after a recent failure, but only while reporting is on (`sent` false otherwise).
     */
    async sendLanguages(state, languages) {
        return this.#send(state ?? EMPTY_REPORTER_STATE, 'languages', null, normalizeLanguages(languages));
    }
    /**
     * The report body for an event and state (`extensions`, `languages`: the lists to send; default: the
     * extensions and languages functions', if any).
     */
    buildReport(event, state, extensions, languages) {
        const o = this.#options;
        const body = {
            schema: 1,
            event,
            site_url: o.siteUrl,
            plugin: { name: o.plugin.name, version: o.plugin.version },
            system: nameVersion(o.system),
            runtime: nameVersion(this.#runtime()),
        };
        if (o.sdkVersion)
            body.sdk_version = o.sdkVersion;
        if (state.keyChecks) {
            body.api_keys = Object.entries(state.keyChecks).map(([name, check]) => ({ name, configured: check.fingerprint !== '', check: checkBody(check) }));
        }
        else if (state.keyCheck) {
            body.api_key_configured = state.keyCheck.fingerprint !== '';
            body.api_key_check = checkBody(state.keyCheck);
        }
        if (o.callbackUrl)
            body.callback = { url: o.callbackUrl };
        const list = extensions ?? this.#extensions();
        if (list)
            body.extensions = list;
        const mapping = languages ? normalizeLanguages(languages) : this.#languages();
        if (mapping)
            body.languages = mapping;
        return body;
    }
    #languages() {
        if (!this.#options.languages)
            return null;
        try {
            return normalizeLanguages(this.#options.languages());
        }
        catch {
            return null; // never fails the report: the mapping is extra information
        }
    }
    #extensions() {
        if (!this.#options.extensions)
            return null;
        try {
            return normalizeExtensions(this.#options.extensions());
        }
        catch {
            return null; // never fails the report: the list is extra information
        }
    }
    #runtime() {
        return this.#options.runtime ?? detectRuntime();
    }
    #dueEvent(state) {
        if (state.reportedVersions === null)
            return 'installed';
        if (state.reportedVersions !== this.versions)
            return 'upgraded';
        if (state.keyChecks !== null) {
            const reported = state.reportedKeyStatuses ?? {};
            const names = Object.keys(state.keyChecks);
            if (names.length !== Object.keys(reported).length || names.some((n) => state.keyChecks[n].status !== reported[n]))
                return 'api_key_check';
            return null;
        }
        if (state.keyCheck !== null && state.keyCheck.status !== state.reportedKeyStatus)
            return 'api_key_check';
        return null;
    }
    /** The state with fresh checks: always (`force`), else only for keys that are new or changed. */
    async #withChecks(state, apiKeys, force) {
        const fp = (key) => this.#options.keyChecker.fingerprint(key);
        if (typeof apiKeys === 'string') {
            if (!force && state.keyChecks === null && state.keyCheck !== null && state.keyCheck.fingerprint === fp(apiKeys))
                return state;
            // Coming from several keys: report the single key even if its status is the one reported before.
            const reportedKeyStatus = state.keyChecks !== null ? null : state.reportedKeyStatus;
            return { ...state, keyCheck: await this.#check(apiKeys), keyChecks: null, reportedKeyStatuses: null, reportedKeyStatus };
        }
        const keyChecks = {};
        for (const [name, key] of namedKeys(apiKeys)) {
            const old = state.keyChecks?.[name];
            keyChecks[name] = !force && old && old.fingerprint === fp(key) ? old : await this.#check(key);
        }
        return { ...state, keyCheck: null, keyChecks };
    }
    async #check(apiKey) {
        try {
            const check = keyCheck(await this.#options.keyChecker.check(apiKey));
            if (check)
                return check;
        }
        catch {
            // the SDK's check never throws; a plugin's own checker might
        }
        return { status: 'error', checkedAt: isoSeconds(this.#now()), httpStatus: null, errorCode: null, fingerprint: this.#options.keyChecker.fingerprint(apiKey) };
    }
    async #reportIfDue(state, event) {
        const idle = { state, check: state.keyCheck, checks: state.keyChecks, event: null, sent: false };
        if (event === null || !this.#options.enabled)
            return idle;
        if (state.lastFailureAt !== null) {
            const failed = Date.parse(state.lastFailureAt);
            if (!Number.isNaN(failed) && this.#now() - failed < FAILURE_BACKOFF_MS)
                return idle;
        }
        return this.#send(state, event);
    }
    async #send(state, event, extensions = null, languages = null) {
        if (!this.#options.enabled)
            return { state, check: state.keyCheck, checks: state.keyChecks, event: null, sent: false };
        let ok = false;
        try {
            const response = await this.#fetch(this.reportUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'User-Agent': `supertext-plugin-health/${PLUGIN_HEALTH_VERSION} (typescript) ${this.#options.plugin.name}/${this.#options.plugin.version}`,
                },
                body: JSON.stringify(this.buildReport(event, state, extensions, languages)),
                signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
            });
            ok = response.status >= 200 && response.status < 300;
            await response.body?.cancel().catch(() => undefined);
        }
        catch {
            ok = false; // never fails the caller: the center is optional
        }
        const next = ok
            ? {
                ...state,
                reportedVersions: this.versions,
                reportedKeyStatus: state.keyCheck?.status ?? state.reportedKeyStatus,
                reportedKeyStatuses: state.keyChecks
                    ? Object.fromEntries(Object.entries(state.keyChecks).map(([name, check]) => [name, check.status]))
                    : state.reportedKeyStatuses,
                lastFailureAt: null,
            }
            : { ...state, lastFailureAt: isoSeconds(this.#now()) };
        return { state: next, check: next.keyCheck, checks: next.keyChecks, event, sent: ok };
    }
}
/** `2026-10-13T08:00:00Z` for a time in milliseconds. */
export function isoSeconds(ms) {
    return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}
function checkBody(check) {
    const c = { status: check.status, checked_at: check.checkedAt };
    if (check.httpStatus !== null)
        c.http_status = check.httpStatus;
    if (check.errorCode !== null)
        c.error_code = check.errorCode;
    return c;
}
function nameVersion(value) {
    return value.version ? { name: value.name, version: value.version } : { name: value.name };
}
function detectRuntime() {
    const g = globalThis;
    if (g.Deno?.version?.deno)
        return { name: 'Deno', version: g.Deno.version.deno };
    if (g.Bun?.version)
        return { name: 'Bun', version: g.Bun.version };
    return { name: 'Node.js', version: g.process?.versions?.node ?? null };
}
function processEnv(name) {
    return globalThis.process?.env?.[name];
}
