import { describe, expect, it } from 'vitest'
import { assessMemoryRisk } from '../src/editor/core/memoryRisk'

/**
 * 导出内存风险分级。
 *
 * 守的重点：
 * 1. 分辨率必须参与判断（同样素材量，4K 比 480p 危险得多）——这是原来缺的维度；
 * 2. 只有真的接近上限才报警（不要对着 20MB 素材喊内存不足，那样提示会失去可信度）；
 * 3. 建议要按收益排序（降分辨率 > 减少动画 > 分段）。
 */
describe('assessMemoryRisk', () => {
  const gb = (value: number) => value * 1024 * 1024 * 1024

  it('小素材 + 低分辨率 → ok，不给任何提示', () => {
    const risk = assessMemoryRisk({
      assetBytes: 20 * 1024 * 1024,
      resolution: '480p',
      durationSeconds: 10,
    })
    expect(risk.level).toBe('ok')
    expect(risk.message).toBeNull()
    expect(risk.suggestions).toEqual([])
  })

  it('同样的素材量，4K 会升级风险等级而 1080p 不会', () => {
    const assetBytes = gb(0.3)
    const low = assessMemoryRisk({ assetBytes, resolution: '1080p', durationSeconds: 60 })
    const high = assessMemoryRisk({ assetBytes, resolution: '4K', durationSeconds: 60 })
    expect(low.level).toBe('ok')
    // 0.3GB × 20 = 6GB 压力 → risk
    expect(high.level).toBe('risk')
    expect(high.message).toContain('4K')
  })

  it('risk 级别时建议按收益排序：先降画质，再动画，再分段', () => {
    const risk = assessMemoryRisk({
      assetBytes: gb(0.5),
      resolution: '4K',
      durationSeconds: 240,
      animationFrames: 500,
    })
    expect(risk.level).toBe('risk')
    expect(risk.suggestions[0]).toContain('1080P')
    expect(risk.suggestions[1]).toContain('关键帧动画')
    expect(risk.suggestions[2]).toContain('分段')
  })

  it('动画帧数本身可以触发 risk（即使素材很小）', () => {
    // 2800 帧 × 2MiB ≈ 5.5GiB，超过 risk 阈值（5GiB）
    const risk = assessMemoryRisk({
      assetBytes: 10 * 1024 * 1024,
      resolution: '720p',
      durationSeconds: 80,
      animationFrames: 2800,
    })
    expect(risk.level).toBe('risk')
    expect(risk.suggestions.some((item) => item.includes('关键帧动画'))).toBe(true)
  })

  it('中间地带给 warn（提示但不劝退）', () => {
    // 0.55GB × 5（1080p）= 2.75GB，落在 warn 区间
    const risk = assessMemoryRisk({
      assetBytes: gb(0.55),
      resolution: '1080p',
      durationSeconds: 60,
    })
    expect(risk.level).toBe('warn')
    expect(risk.message).toContain('1080P')
    expect(risk.suggestions.length).toBeGreaterThan(0)
  })

  it('非法/负数输入按 0 处理，不抛错', () => {
    expect(() =>
      assessMemoryRisk({
        assetBytes: Number.NaN,
        resolution: '1080p',
        durationSeconds: -10,
        animationFrames: -5,
      }),
    ).not.toThrow()
    const risk = assessMemoryRisk({
      assetBytes: Number.NaN,
      resolution: '1080p',
      durationSeconds: -10,
    })
    expect(risk.level).toBe('ok')
  })
})