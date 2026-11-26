export const CORRECTIONS_PAGE_SIZE = 500;
export const CORRECTIONS_MAX_PAGES = 100;
export const ACKNOWLEDGE_BATCH_SIZE = 1000;
const VERSION = /^[0-9a-f]{16}$/;
const DIGITS = /^[0-9]+$/;
/** The path of one page of pending corrections. */
export function correctionsPath(options, after) {
    const query = [];
    const add = (name, value) => {
        if (value !== undefined && value !== null)
            query.push(`${name}=${encodeURIComponent(value)}`);
    };
    add('target_lang', options.targetLang);
    add('source_lang', options.sourceLang);
    add('politeness', options.politeness);
    add('after', after);
    add('limit', String(CORRECTIONS_PAGE_SIZE));
    return `review/corrections?${query.join('&')}`;
}
/** One page: its valid corrections and the `after` for the next page (null: last page). */
export function parseCorrectionsPage(body) {
    let data;
    try {
        data = JSON.parse(body);
    }
    catch {
        return { corrections: [], nextAfter: null };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data))
        return { corrections: [], nextAfter: null };
    const page = data;
    if (!Array.isArray(page.corrections))
        return { corrections: [], nextAfter: null };
    const str = (v) => (typeof v === 'string' ? v : '');
    const corrections = page.corrections.flatMap((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            return [];
        const o = raw;
        const required = [o.id, o.st_id, o.target_lang, o.html];
        if (!required.every((v) => typeof v === 'string' && v !== ''))
            return [];
        if (typeof o.version !== 'string' || !VERSION.test(o.version))
            return [];
        return [
            {
                id: o.id,
                segmentId: o.st_id,
                sourceLang: typeof o.source_lang === 'string' && o.source_lang !== '' ? o.source_lang : null,
                targetLang: o.target_lang,
                politeness: o.politeness === 'more' || o.politeness === 'less' ? o.politeness : 'default',
                sourceHtml: str(o.source_html),
                previousHtml: str(o.previous_html),
                html: o.html,
                status: str(o.status),
                correctedAt: str(o.corrected_at),
                version: o.version,
            },
        ];
    });
    const next = page.next_after;
    return { corrections, nextAfter: typeof next === 'string' && DIGITS.test(next) ? next : null };
}
/** The acknowledge request body, byte-exact. */
export function acknowledgeBody(corrections) {
    return JSON.stringify({ corrections: corrections.map((c) => ({ id: c.id, version: c.version })) });
}
/** The answer's `acknowledged` (0 when it isn't a non-negative integer). */
export function acknowledgedCount(body) {
    try {
        const n = JSON.parse(body)?.acknowledged;
        return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : 0;
    }
    catch {
        return 0;
    }
}
