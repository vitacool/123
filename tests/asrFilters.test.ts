import { describe, expect, it } from 'vitest'
import {
  cleanAsrWords,
  filterRepeatedWords,
  isHallucinationWord,
  repairWordDuration,
} from '../src/editor/core/asrFilters'
import type { AsrWord } from '../src/editor/core/asr'

function word(text: string, start: number, end: number): AsrWord {
  return { text, start, end }
}

describe('isHallucinationWord', () => {
  it('flags blacklisted fragments case-insensitively and ignoring spaces', () => {
    expect(isHallucinationWord('字幕 by 某某')).toBe(true)
    expect(isHallucinationWord('字幕by')).toBe(true)
    expect(isHallucinationWord('请不吝点赞')).toBe(true)
    expect(isHallucinationWord('订阅')).toBe(true)
    expect(isHallucinationWord('')).toBe(true)
    expect(isHallucinationWord('今天天气不错')).toBe(false)
  })
})

describe('filterRepeatedWords', () => {
  it('drops runs of three or more consecutive identical words', () => {
    const words = [word('谢谢', 0, 1), word('谢谢', 1, 2), word('谢谢', 2, 3)]
    expect(filterRepeatedWords(words)).toEqual([])
  })

  it('keeps runs shorter than the threshold', () => {
    const words = [word('谢谢', 0, 1), word('谢谢', 1, 2), word('好的', 2, 3)]
    expect(filterRepeatedWords(words).map((item) => item.text)).toEqual(['谢谢', '谢谢', '好的'])
  })
})

describe('repairWordDuration', () => {
  it('clamps over-long words to the maximum duration', () => {
    const repaired = repairWordDuration(word('长', 1, 11), 3)
    expect(repaired.start).toBe(1)
    expect(repaired.end).toBe(4)
  })

  it('repairs non-positive durations', () => {
    const repaired = repairWordDuration(word('短', 2, 2), 3)
    expect(repaired.end).toBeGreaterThan(repaired.start)
  })
})

describe('cleanAsrWords', () => {
  it('removes hallucinated words, repairs durations and drops repeats', () => {
    const words: AsrWord[] = [
      word('字幕by', 0, 1),
      word('长词', 1, 9),
      word('嗡嗡', 2, 3),
      word('嗡嗡', 3, 4),
      word('嗡嗡', 4, 5),
    ]
    const cleaned = cleanAsrWords(words)
    // '字幕by' + the repeated run are gone; '长词' duration clamped.
    expect(cleaned.map((item) => item.text)).toEqual(['长词'])
    expect(cleaned[0].end - cleaned[0].start).toBeLessThanOrEqual(3)
  })
})