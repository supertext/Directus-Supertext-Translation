/**
 * Corrections for the CMS (spec/corrections.json): reviewers correct translations on
 * the website in Supertext Localization Review; its review service (a drop-in proxy
 * for the API) remembers where each segment sits by the integration's `data-st-id`.
 * The integration fetches the corrections it hasn't written yet and acknowledges them.
 * Only the review service answers these calls; Supertext's API answers 404 (`not_found`).
 */
import type { Politeness } from './client.js';
export interface Correction {
    /** The review service's id of this place (send back with `acknowledgeCorrections`). */
    id: string;
    /** The `data-st-id` the integration gave the segment (its own reference to the field). */
    segmentId: string;
    /** null: the source language was detected. */
    sourceLang: string | null;
    targetLang: string;
    politeness: Politeness;
    sourceHtml: string;
    /** What the integration received for this place last: check the field still holds it before overwriting an editor's change. */
    previousHtml: string;
    /** The corrected translation: write this into the field. */
    html: string;
    /** `corrected`, `approved`, … */
    status: string;
    /** ISO time of the latest change. */
    correctedAt: string;
    /** Changes with every new correction: acknowledge the version you wrote. */
    version: string;
}
export interface PendingCorrectionsOptions {
    targetLang?: string | null;
    sourceLang?: string | null;
    politeness?: Politeness | null;
}
export declare const CORRECTIONS_PAGE_SIZE = 500;
export declare const CORRECTIONS_MAX_PAGES = 100;
export declare const ACKNOWLEDGE_BATCH_SIZE = 1000;
/** The path of one page of pending corrections. */
export declare function correctionsPath(options: PendingCorrectionsOptions, after: string | null): string;
/** One page: its valid corrections and the `after` for the next page (null: last page). */
export declare function parseCorrectionsPage(body: string): {
    corrections: Correction[];
    nextAfter: string | null;
};
/** The acknowledge request body, byte-exact. */
export declare function acknowledgeBody(corrections: readonly Pick<Correction, 'id' | 'version'>[]): string;
/** The answer's `acknowledged` (0 when it isn't a non-negative integer). */
export declare function acknowledgedCount(body: string): number;
