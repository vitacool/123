import { describe, expect, it } from 'vitest'
import { peakBucketsForDuration, samplePeakRange } from '../src/editor/services/audioWaveform'

const peaks = {
  duration: 10,
  peaks: new Float32Array([0, 0.5, 1, 0.25]),
}

describe('peakBucketsForDuration（长素材波形精度）', () => {
  it('短素材至少 600 桶，长素材按 ~40 桶/秒提升', () => {
    expect(peakBucketsForDuration(10)).toBe(600)
    expect(peakBucketsForDuration(60)).toBe(2400)
  })

  it('超长素材封顶 12 万桶，非法时长回退 600', () => {
    expect(peakBucketsForDuration(3600)).toBe(120_000)
    expect(peakBucketsForDuration(Number.NaN)).toBe(600)
    expect(peakBucketsForDuration(0)).toBe(600)
  })
})

describe('samplePeakRange（波形按源区间采样）', () => {
  it('整段映射：列数与峰值一一对应', () => {
    expect(samplePeakRange(peaks, 0, 10, 4)).toEqual([0, 0.5, 1, 0.25])
  })

  it('越界区间先夹到素材范围内', () => {
    expect(samplePeakRange(peaks, -5, 20, 4)).toEqual([0, 0.5, 1, 0.25])
  })

  it('非法区间（end <= start）返回全 0，不画假波形', () => {
    expect(samplePeakRange(peaks, 5, 5, 3)).toEqual([0, 0, 0])
    expect(samplePeakRange(peaks, 6, 4, 3)).toEqual([0, 0, 0])
  })

  it('空峰值/零时长返回全 0', () => {
    expect(
      samplePeakRange({ duration: 10, peaks: new Float32Array([]) }, 0, 5, 2),
    ).toEqual([0, 0])
    expect(samplePeakRange({ duration: 0, peaks: peaks.peaks }, 0, 5, 2)).toEqual([0, 0])
  })

  it('只取一段区间时按比例取样', () => {
    // 5..10 对应最后两个峰值（1, .25）
    expect(samplePeakRange(peaks, 5, 10, 2)).toEqual([1, 0.25])
  })
})