import { Languages } from 'supertext-sdk/v1'
import type { Politeness } from './supertext-client.js'

/**
 * Directus language codes → Supertext codes, with the Supertext SDK's rules (the same in every
 * Supertext plugin): the mapping wins (the combo boxes on the Supertext page, with
 * SUPERTEXT_LANGUAGE_MAP as override); otherwise a Directus code that equals a Supertext code
 * apart from case and `_`/`-` is used (`de-CH`, `es`); otherwise the SDK's default where one is
 * obvious (`de` → `de-DE`, `zh-TW` → `zh-Hant`, `es-ES` → `es`); anything else throws
 * `SupertextError('unsupported_language')`. Sources are bare (`en-US` → `en`).
 */
export const SUPERTEXT_TARGETS = Languages.TARGETS

/** What the combo box preselects: exact match, else the SDK default, else null (`en-IE`, `gsw`). */
export const suggestTarget = (locale: string): string | null => Languages.suggestTarget(locale)

/** The combo box's choices, sorted by English name. */
export const targetOptions = () => Languages.targetOptions()

export function targetCode(locale: string, map: Record<string, string> = {}): string {
  return Languages.target(locale, map)
}

/** The target code, or null when the language has no mapping, match or default (for the Supertext page). */
export function targetCodeOrNull(locale: string, map: Record<string, string> = {}): string | null {
  try {
    return Languages.target(locale, map)
  } catch {
    return null
  }
}

export function sourceCode(locale: string, map: Record<string, string> = {}): string {
  return Languages.source(locale, map)
}

export function politenessFor(locale: string, map: Record<string, Politeness> = {}): Politeness {
  return map[locale] ?? 'default'
}

/** Whether Supertext offers formal/informal for a target code (null: not in the SDK's list). */
export const supportsPoliteness = (target: string): boolean | null => Languages.supportsPoliteness(target)
