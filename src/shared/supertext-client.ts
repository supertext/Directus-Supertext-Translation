/**
 * The extension's access to the Supertext AI file translation API (v1), built on the
 * shared Supertext SDK (`supertext-sdk`, bundled from vendor/supertext-sdk into dist/).
 * The SDK does the protocol:
 *   1. POST   translate/ai/file                     multipart upload of an HTML file → { file_id }
 *   2. GET    translate/ai/file/{id}/status         poll until `done`
 *   3. GET    translate/ai/file/{id}/translation    download the translated HTML
 *   4. DELETE translate/ai/file/{id}                cleanup, also after errors
 * plus the `Authorization: Supertext-Auth-Key <key>` header (a pasted prefix is stripped),
 * HTTP 429 retries and the language codes (bare source, regional target).
 *
 * No Directus imports here (tested on its own).
 */
import { LIVE_BASE_URL, SupertextClient as SdkClient, SupertextError } from 'supertext-sdk/v1'
import type { ApiKeyCheck, ErrorCode, FetchLike, Politeness } from 'supertext-sdk/v1'

export { SupertextError }
export type { Politeness }
export type SupertextErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

export const SUPERTEXT_ENVIRONMENTS = {
  live: LIVE_BASE_URL,
  staging: 'https://api.staging.supertext.com/v1/',
  testing: 'https://api.testing.supertext.com/v1/',
} as const

export type SupertextEnvironment = keyof typeof SUPERTEXT_ENVIRONMENTS

/**
 * Supertext's review service (translation proxy of Supertext Localization Review). It speaks
 * the same API v1 and forwards to the live Supertext API with the same key, keeping every
 * translation so reviewers can correct them on the website. Used for languages with
 * *Translation review* on.
 */
export const REVIEW_URL = 'https://localizationreview-production.up.railway.app/v1/'

export type SupertextClientOptions = {
  apiKey: string
  /** Base URL with trailing slash. Defaults to the live API. */
  baseUrl?: string
  /** Custom fetch (tests, proxies). Defaults to global fetch. */
  fetch?: typeof fetch
  /** Delay between status polls. Default 2000 ms. */
  pollIntervalMs?: number
  /** Give up waiting after this long. Default 180000 ms. */
  timeoutMs?: number
  /** Per-request HTTP timeout. Default 30000 ms. */
  requestTimeoutMs?: number
  /** Sleep implementation (tests). */
  sleep?: (ms: number) => Promise<void>
  /** User-Agent, e.g. `Directus-Supertext-Translation/0.1.0`. */
  userAgent?: string
  /** Review service for languages with *Translation review* on ('' or omitted: none). */
  reviewUrl?: string
}

export type TranslateFileArgs = {
  html: string
  /** Any form (`de`, `de_ch`): sent as a regional code. */
  targetLang: string
  /** Any form: sent as the bare language; omit for auto-detection. */
  sourceLang?: string
  politeness?: Politeness
}

export class SupertextClient {
  private readonly sdk: SdkClient
  private readonly options: SupertextClientOptions
  private reviewClient: SupertextClient | null = null

  constructor(options: SupertextClientOptions) {
    this.options = options
    const pollIntervalMs = Math.max(100, options.pollIntervalMs ?? 2000)
    this.sdk = new SdkClient(options.apiKey, {
      baseUrl: options.baseUrl ?? SUPERTEXT_ENVIRONMENTS.live,
      pollIntervalMs,
      timeoutMs: Math.max(pollIntervalMs, options.timeoutMs ?? 180_000),
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      userAgent: options.userAgent ?? 'Directus-Supertext-Translation',
      ...(options.fetch ? { fetch: options.fetch as FetchLike } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    })
  }

  /**
   * The client for a target language: the review service when its *Translation review* is on
   * (same key, timeouts, fetch and User-Agent), else this one. Without a review URL, or with
   * the same URL as the API, always this one. Each round trip (upload, status, download,
   * delete) runs on one client, so a job is collected where it was submitted.
   */
  forReview(review: boolean): SupertextClient {
    const reviewUrl = (this.options.reviewUrl ?? '').trim()
    const baseUrl = this.options.baseUrl ?? SUPERTEXT_ENVIRONMENTS.live
    if (!review || !reviewUrl || reviewUrl.replace(/\/+$/, '') === baseUrl.replace(/\/+$/, '')) return this
    this.reviewClient ??= new SupertextClient({ ...this.options, baseUrl: reviewUrl, reviewUrl: '' })
    return this.reviewClient
  }

  /** Full round trip: upload, wait, download, delete. Returns the translated HTML. */
  translateHtml({ html, targetLang, sourceLang, politeness }: TranslateFileArgs): Promise<string> {
    return this.sdk.translateHtml(html, targetLang, { sourceLang: sourceLang ?? null, politeness: politeness ?? 'default' })
  }

  /** Cost-free check that the API key is accepted (`GET features`). */
  validateApiKey(): Promise<void> {
    return this.sdk.validateApiKey()
  }

  /** The automatic key check: ok, invalid, missing, unreachable or error. Never throws. */
  checkApiKey(): Promise<ApiKeyCheck> {
    return this.sdk.checkApiKey()
  }
}
