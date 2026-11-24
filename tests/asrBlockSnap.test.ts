import { describe, expect, it } from 'vitest'
import { buildSpeechBlocks, snapSpeechBlockBoundaries } from '../src/editor/core/asrVad'

/**
 * 人声块切点对齐。
 *
 * 真实问题：`buildSpeechBlocks` 对超过 28s 的连续人声是**纯算术**切分，
 * 切点经常落在词中间 —— 一个词被拆到前后两块分别识别，字幕出现重复半句/残词，
 * 每 28 秒一次。`snapSpeechBlockBoundaries` 把切点挪到最近的低能量（停顿）处，
 * 但不能破坏「块首尾相接」这个前提（否则会丢音频或重复音频）。
 */

const RATE = 16000

function pcmWithSilence(seconds: number, silence: Array<[number, number]>): Float32Array {
  const pcm = new Float32Array(Math.round(seconds * RATE))
  pcm.fill(0.5)
  for (const [from, to] of silence) {
    for (let index = Math.round(from * RATE); index < Math.round(to * RATE); index += 1) {
      pcm[index] = 0
    }
  }
  return pcm
}

describe('snapSpeechBlockBoundaries', () => {
  it('把 28s 的算术切点挪到静音段（词不再被切两半）', () => {
    const pcm = pcmWithSilence(32, [
      [13.9, 14.4],
      [27.6, 28.2],
    ])
    const blocks = buildSpeechBlocks([{ start: 0, end: 32 }], 32, {
      padSeconds: 0.2,
      mergeGapSeconds: 2,
      maxBlockSeconds: 28,
    })
    expect(blocks).toHaveLength(2)
    expect(blocks[0].end).toBeCloseTo(28, 6)

    const snapped = snapSpeechBlockBoundaries(blocks, pcm)
    expect(snapped[0].end).toBeGreaterThan(27.55)
    expect(snapped[0].end).toBeLessThan(28.25)
    // 相邻块必须仍然首尾相接：不丢音频，也不重复识别同一段。
    expect(snapped[1].start).toBe(snapped[0].end)
    for (const block of snapped) expect(block.end - block.start).toBeGreaterThan(0.2)
  })

  it('全程有声（没有可用停顿）时保持原切点，不随机挪动', () => {
    const pcm = new Float32Array(32 * RATE).fill(0.5)
    const blocks = [{ start: 0, end: 28 }, { start: 28, end: 32 }]
    const snapped = snapSpeechBlockBoundaries(blocks, pcm)
    expect(snapped[0].end).toBeCloseTo(28, 6)
    expect(snapped[1].start).toBeCloseTo(28, 6)
  })

  it('不紧邻的块（中间本来就有间隔）完全不处理', () => {
    const pcm = pcmWithSilence(12, [[5.1, 5.6]])
    const snapped = snapSpeechBlockBoundaries(
      [
        { start: 0, end: 5 },
        { start: 6, end: 9 },
      ],
      pcm,
    )
    expect(snapped[0].end).toBe(5)
    expect(snapped[1].start).toBe(6)
  })

  it('空输入 / 单块 / 空音频都安全返回副本', () => {
    expect(snapSpeechBlockBoundaries([], new Float32Array(0))).toEqual([])
    const single = [{ start: 0, end: 3 }]
    const copy = snapSpeechBlockBoundaries(single, new Float32Array(3 * RATE))
    expect(copy).toEqual(single)
    expect(copy).not.toBe(single)
  })

  it('不会把切点推到块外（每块至少保留 minBlockSeconds）', () => {
    const pcm = new Float32Array(20 * RATE) // 全静音：窗口内处处能量相同
    const snapped = snapSpeechBlockBoundaries(
      [
        { start: 0, end: 10 },
        { start: 10, end: 10.25 },
      ],
      pcm,
      RATE,
      { maxShiftSeconds: 0.25, minBlockSeconds: 0.2 },
    )
    expect(snapped[0].end - snapped[0].start).toBeGreaterThanOrEqual(0.2 - 1e-6)
    expect(snapped[1].end - snapped[1].start).toBeGreaterThanOrEqual(0.2 - 1e-6)
  })
})