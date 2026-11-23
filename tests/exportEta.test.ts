import { describe, expect, it } from 'vitest'
import {
  estimateRemainingSeconds,
  formatEta,
  type ExportProgressSample,
} from '../src/editor/core/exportEta'

/**
 * 导出 ETA：用最近窗口的实际速率外推。
 *
 * 重点守三件事：
 * 1. 信息不足 / 进度没推进时**不给估计**（宁可不显示，也别给假数字）；
 * 2. 稳定推进时估计要贴近真实剩余时间；
 * 3. 异常速率（几乎不动）不能给出荒谬的大数。
 */
describe('estimateRemainingSeconds', () => {
  const sample = (at: number, progress: number): ExportProgressSample => ({ at, progress })

  it('样本不足时返回 null', () => {
    expect(estimateRemainingSeconds([], 1000)).toBeNull()
    expect(estimateRemainingSeconds([sample(0, 0)], 1000)).toBeNull()
    expect(estimateRemainingSeconds([sample(0, 0), sample(500, 0.1)], 1000)).toBeNull()
  })

  it('进度完全没推进时返回 null（例如正在封装/等待）', () => {
    const samples = [sample(0, 0.3), sample(2000, 0.3), sample(4000, 0.3)]
    expect(estimateRemainingSeconds(samples, 5000)).toBeNull()
  })

  it('稳定推进时按速率外推（10%/2s → 剩余 90% 约 18s）', () => {
    const samples = [sample(0, 0), sample(2000, 0.1), sample(4000, 0.2)]
    expect(estimateRemainingSeconds(samples, 4000)).toBe(16)
  })

  it('换了速度时只看窗口内的新样本（旧慢速不拖累）', () => {
    // 前一段很慢（0→10% 用了 40s，已在窗口外），后一段很快（10%→50% 用 4s）
    const samples = [
      sample(0, 0),
      sample(20_000, 0.05),
      sample(40_000, 0.1),
      sample(42_000, 0.3),
      sample(44_000, 0.5),
    ]
    const eta = estimateRemainingSeconds(samples, 44_000)
    // 窗口 20s 内包含 40s 之后的样本：10%→50% 用 4s → 剩余 50% 约 5s
    expect(eta).toBe(5)
  })

  it('速率极低时超过上限就不显示，而不是给一个荒谬的大数', () => {
    // 100 秒只推进 0.2% → 剩余约 5 万秒（> 6 小时上限）→ 不显示
    const slow = [sample(0, 0), sample(50_000, 0.001), sample(100_000, 0.002)]
    expect(estimateRemainingSeconds(slow, 100_000)).toBeNull()

    // 更极端的速率同样不显示
    const huge = [
      sample(0, 0),
      sample(60_000, 0.0001),
      sample(120_000, 0.0002),
    ]
    expect(estimateRemainingSeconds(huge, 120_000)).toBeNull()
  })

  it('已经 100% 时返回 0', () => {
    const samples = [sample(0, 0.5), sample(1000, 0.8), sample(2000, 1)]
    expect(estimateRemainingSeconds(samples, 2000)).toBe(0)
  })

  it('忽略未来时间戳与非法值', () => {
    const samples = [sample(0, 0), sample(2000, 0.1), sample(99_999, 0.9), sample(Number.NaN, 0.5)]
    expect(estimateRemainingSeconds(samples, 4000)).toBeNull()
  })
})

describe('formatEta', () => {
  it('不足 1 分钟、分钟级、小时级各自的写法', () => {
    expect(formatEta(1)).toBe('约 1 秒')
    expect(formatEta(45)).toBe('约 45 秒')
    expect(formatEta(60)).toBe('约 1 分钟')
    expect(formatEta(95)).toBe('约 1 分 35 秒')
    expect(formatEta(3600)).toBe('约 1 小时')
    expect(formatEta(5400)).toBe('约 1 小时 30 分')
  })

  it('0 或负数按最小 1 秒处理（不要让 UI 出现「约 0 秒」）', () => {
    expect(formatEta(0)).toBe('约 1 秒')
    expect(formatEta(-5)).toBe('约 1 秒')
  })
})