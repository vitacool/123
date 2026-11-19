import type { AsrWord } from './asr'

/**
 * Common hallucination fragments Whisper tends to emit for empty/music audio.
 * Matching is case-insensitive and ignores whitespace, so "字幕 by" and
 * "字幕by" both hit the same rule.
 */
export const HALLUCINATION_PHRASES: readonly string[] = [
  '字幕by',
  '请不吝点赞',
  '订阅',
  '感谢观看',
  '一键三连',
  '三连',
  '关注主播',
]

/** Word durations beyond this many seconds are treated as hallucinated. */
export const MAX_WORD_DURATION_SECONDS = 3

function normalize(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase()
}

/** True when a word is empty or contains a known hallucination fragment. */
export function isHallucinationWord(text: string): boolean {
  const normalized = normalize(text)
  if (!normalized) return true
  return HALLUCINATION_PHRASES.some((phrase) => normalized.includes(normalize(phrase)))
}

/**
 * Drops runs of three or more *consecutive* identical words. A model stuck on
 * a repeated phrase produces these runs; keeping a run of two is harmless.
 */
export function filterRepeatedWords(
  words: readonly AsrWord[],
  threshold = 3,
): AsrWord[] {
  const kept: AsrWord[] = []
  let run: AsrWord[] = []
  let runKey = ''

  const flush = (): void => {
    if (run.length < threshold) kept.push(...run)
    run = []
    runKey = ''
  }

  for (const word of words) {
    const key = normalize(word.text)
    if (key === runKey && run.length > 0) {
      run.push(word)
    } else {
      flush()
      run = [word]
      runKey = key
    }
  }
  flush()
  return kept
}

/** Clamps over-long or non-positive word durations to a sane range. */
export function repairWordDuration(
  word: AsrWord,
  maxSeconds: number = MAX_WORD_DURATION_SECONDS,
): AsrWord {
  const start = Number.isFinite(word.start) ? Math.max(0, word.start) : 0
  let end = Number.isFinite(word.end) ? word.end : start + 0.2
  if (end - start > maxSeconds) end = start + maxSeconds
  if (end <= start) end = start + 0.2
  return { ...word, start, end }
}

/** Drops blacklisted/hallucinated words, repairs durations, removes repeats. */
export function cleanAsrWords(words: readonly AsrWord[]): AsrWord[] {
  const prepared = words
    .filter((word) => !isHallucinationWord(word.text))
    .map((word) => repairWordDuration(word))
    .map((word) => ({ ...word, text: word.text.trim() }))
  return filterRepeatedWords(prepared)
}