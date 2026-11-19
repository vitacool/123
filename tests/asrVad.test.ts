import { describe, expect, it } from 'vitest'
import {
  buildSpeechBlocks,
  chunkPcm16k,
  frameVadWindows,
  mapSpanWordsToOriginal,
  maxProbability,
  probsToSpeechSpans,
  VAD_CONTEXT_SAMPLES,
  VAD_FRAME_SAMPLES,
  VAD_WINDOW_SAMPLES,
} from '../src/editor/core/asrVad'

const FRAME = 0.032

describe('probsToSpeechSpans', () => {
  it('returns nothing for pure silence or empty input', () => {
    expect(probsToSpeechSpans(new Float32Array(100))).toEqual([])
    expect(probsToSpeechSpans([])).toEqual([])
  })

  it('returns a single full span for continuous speech', () => {
    const spans = probsToSpeechSpans(new Float32Array(100).fill(1))
    expect(spans).toEqual([{ start: 0, end: 100 * FRAME }])
  })

  it('drops bursts shorter than the minimum speech length', () => {
    const probs = new Float32Array(40)
    probs[10] = 1
    probs[11] = 1 // two frames < minSpeechFrames(3)
    expect(probsToSpeechSpans(probs, { minSpeechFrames: 3, minSilenceFrames: 0 })).toEqual([])
  })

  it('applies a silence hangover to the end of a span', () => {
    const probs = new Float32Array(100)
    for (let index = 10; index < 15; index += 1) probs[index] = 1
    const spans = probsToSpeechSpans(probs, { minSpeechFrames: 3, minSilenceFrames: 8 })
    expect(spans).toEqual([{ start: 10 * FRAME, end: (15 + 8) * FRAME }])
  })

  it('merges nearby spans but keeps distant ones separate', () => {
    const close = new Float32Array(100)
    for (const index of [10, 11, 12, 13, 14]) close[index] = 1
    for (const index of [20, 21, 22, 23, 24]) close[index] = 1
    expect(
      probsToSpeechSpans(close, { minSpeechFrames: 3, minSilenceFrames: 0, mergeGapSeconds: 0.3 }),
    ).toEqual([{ start: 10 * FRAME, end: 25 * FRAME }])

    const distant = new Float32Array(100)
    for (const index of [10, 11, 12, 13, 14]) distant[index] = 1
    for (const index of [40, 41, 42, 43, 44]) distant[index] = 1
    expect(
      probsToSpeechSpans(distant, {
        minSpeechFrames: 3,
        minSilenceFrames: 0,
        mergeGapSeconds: 0.3,
      }),
    ).toEqual([
      { start: 10 * FRAME, end: 15 * FRAME },
      { start: 40 * FRAME, end: 45 * FRAME },
    ])
  })
})

describe('mapSpanWordsToOriginal', () => {
  it('shifts words from the padded window back to original audio time', () => {
    const words = [{ text: '你好', start: 0.2, end: 0.6 }]
    const mapped = mapSpanWordsToOriginal(words, { start: 1.0, end: 2.0 }, 0.2)
    expect(mapped).toEqual([{ text: '你好', start: 1.0, end: 1.4 }])
    // Window starts at 0.8 s (span.start - pad), so 0.2s → 1.0s.
  })
})

describe('VAD v5 帧构建与切块', () => {
  it('frameVadWindows：每帧 [1, 576]，包含上一帧末尾 64 采样上下文，第一帧上下文全零', () => {
    const audio = new Float32Array(VAD_FRAME_SAMPLES * 3)
    audio.fill(1)
    const windows = frameVadWindows(audio)
    expect(windows).toHaveLength(3)
    for (const window of windows) {
      expect(window.length).toBe(VAD_WINDOW_SAMPLES)
    }
    // 第一帧前 64 个采样（上下文）应为 0。
    for (let i = 0; i < VAD_CONTEXT_SAMPLES; i += 1) {
      expect(windows[0][i]).toBe(0)
    }
    // 第一帧第 64..64+512 是当前音频块（全 1）。
    expect(windows[0][VAD_CONTEXT_SAMPLES]).toBe(1)
    // 第二帧的上下文 = 第一帧音频块末尾 64 个采样（全 1）。
    expect(windows[1][0]).toBe(1)
  })

  it('frameVadWindows：末尾不足 512 采样时零填充', () => {
    const audio = new Float32Array(VAD_FRAME_SAMPLES + 10)
    audio.fill(1)
    const windows = frameVadWindows(audio)
    expect(windows).toHaveLength(2)
    // 第二帧只有 10 个真实采样，其余为 0。
    let zeroCount = 0
    for (let i = VAD_CONTEXT_SAMPLES; i < VAD_WINDOW_SAMPLES; i += 1) {
      if (windows[1][i] === 0) zeroCount += 1
    }
    expect(zeroCount).toBeGreaterThan(400)
  })

  it('chunkPcm16k：按秒切块，最后一块可更短', () => {
    const pcm = new Float32Array(16000 * 3 + 8000).fill(1)
    const chunks = chunkPcm16k(pcm, 1)
    expect(chunks).toHaveLength(4)
    expect(chunks[0]).toHaveLength(16000)
    expect(chunks[3]).toHaveLength(8000)
  })

  it('maxProbability：返回概率最大值', () => {
    expect(maxProbability([0.1, 0.9, 0.5])).toBeCloseTo(0.9)
    expect(maxProbability([])).toBe(0)
  })
})

describe('buildSpeechBlocks（送识别的人声块）', () => {
  it('人声从 10s 开始时，块起点锚定在 10s（而不是 0）', () => {
    const blocks = buildSpeechBlocks([{ start: 10, end: 14 }], 30)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].start).toBeCloseTo(9.8) // 前留白 0.2
    expect(blocks[0].end).toBeCloseTo(14.2)
  })

  it('间隔小于合并阈值的相邻人声合并为一块，保留上下文', () => {
    const blocks = buildSpeechBlocks(
      [
        { start: 1, end: 2 },
        { start: 2.5, end: 3 },
      ],
      10,
      { mergeGapSeconds: 2 },
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0].start).toBeCloseTo(0.8)
    expect(blocks[0].end).toBeCloseTo(3.2)
  })

  it('间隔大于合并阈值时保持为多块', () => {
    const blocks = buildSpeechBlocks(
      [
        { start: 1, end: 2 },
        { start: 8, end: 9 },
      ],
      12,
      { mergeGapSeconds: 2 },
    )
    expect(blocks).toHaveLength(2)
    expect(blocks[1].start).toBeCloseTo(7.8)
  })

  it('超长人声块按最大值切分', () => {
    const blocks = buildSpeechBlocks([{ start: 0, end: 70 }], 70, {
      padSeconds: 0,
      maxBlockSeconds: 28,
    })
    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toEqual({ start: 0, end: 28 })
    expect(blocks[1]).toEqual({ start: 28, end: 56 })
    expect(blocks[2].start).toBe(56)
    expect(blocks[2].end).toBeCloseTo(70)
  })

  it('块被夹在音频时长内', () => {
    const blocks = buildSpeechBlocks([{ start: 0.1, end: 9.9 }], 10, { padSeconds: 0.5 })
    expect(blocks[0].start).toBe(0)
    expect(blocks[0].end).toBeCloseTo(10)
  })

  it('无 VAD 结果或时长为 0 时返回空', () => {
    expect(buildSpeechBlocks([], 30)).toEqual([])
    expect(buildSpeechBlocks([{ start: 1, end: 2 }], 0)).toEqual([])
  })
})