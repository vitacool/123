/**
 * Pure, framework-free primitives shared by the built-in ASR provider and the
 * offline caption mapping. Kept out of `services/` so `core/captionMapping.ts`
 * and the hallucination filters can import them without pulling in browser
 * side effects.
 */

export type AsrLanguage = 'auto' | 'zh' | 'en'

/**
 * Bumped whenever the VAD / hallucination filter / sentence-break pipeline
 * changes in a way that changes output. Invalidates previously cached results.
 */
export const ASR_CACHE_VERSION = 2

/** A single recognised word with word-level timing, in seconds. */
export interface AsrWord {
  text: string
  start: number
  end: number
  /** Optional model confidence in [0, 1]. */
  confidence?: number
}

/** Identifies a cached transcription result. */
export interface AsrCacheKey {
  /** Stable media asset id. */
  assetId: string
  /** Source-time interval [start, end] that was transcribed. */
  start: number
  end: number
  /** Provider id (e.g. the model id or a host-provided engine id). */
  providerId: string
  language: AsrLanguage
}

/** Builds a deterministic IndexedDB key from a cache-key tuple. */
export function buildAsrCacheKey(key: AsrCacheKey): string {
  const round = (value: number): string => String(Number(value.toFixed(3)))
  return [
    `v${ASR_CACHE_VERSION}`,
    key.assetId,
    round(key.start),
    round(key.end),
    key.providerId,
    key.language,
  ].join('|')
}