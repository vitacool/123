import { describe, expect, it } from 'vitest'
import {
  COLOR_MAX,
  COLOR_MIN,
  clampColorValue,
  clipColor,
  colorAlphaOf,
  colorToHex,
  cssColorFilter,
  ffmpegColorFilters,
  isNeutralColor,
  isSameColor,
  NEUTRAL_COLOR,
  normalizeColor,
  recolorKeepingAlpha,
  temperatureTint,
} from '../src/editor/core/color'
import { normalizeProjectColors } from '../src/editor/core/draft'
import { createClip, createInitialProject } from '../src/editor/core/operations'
import type { Project, SourceInfo } from '../src/editor/core/types'

const SOURCE: SourceInfo = {
  url: 'blob:test',
  name: 'source.mp4',
  size: 1000,
  duration: 10,
  width: 1920,
  height: 1080,
}

describe('调色参数归一化', () => {
  it('缺省 / 非法值一律为 0', () => {
    expect(normalizeColor(undefined)).toEqual(NEUTRAL_COLOR)
    expect(normalizeColor(null)).toEqual(NEUTRAL_COLOR)
    expect(normalizeColor({})).toEqual(NEUTRAL_COLOR)
    expect(normalizeColor({ brightness: Number.NaN, contrast: Number.POSITIVE_INFINITY })).toEqual(
      NEUTRAL_COLOR,
    )
    expect(isNeutralColor(NEUTRAL_COLOR)).toBe(true)
  })

  it('部分字段只补齐缺的那几项（其它保持用户值）', () => {
    expect(normalizeColor({ saturation: 30 })).toEqual({
      brightness: 0,
      contrast: 0,
      saturation: 30,
      temperature: 0,
    })
  })

  it('边界夹取到 ±100，并保留两位小数', () => {
    expect(clampColorValue(999)).toBe(COLOR_MAX)
    expect(clampColorValue(-999)).toBe(COLOR_MIN)
    expect(clampColorValue(100)).toBe(100)
    expect(clampColorValue(-100)).toBe(-100)
    expect(clampColorValue(12.345)).toBe(12.35)
    expect(clampColorValue(12.344)).toBe(12.34)
    expect(clampColorValue(undefined)).toBe(0)
    expect(clampColorValue('50')).toBe(0)
  })

  it('clipColor 读取缺失字段为 0，isSameColor 比较四项', () => {
    const base = createClip(SOURCE.url, 0, 5, {}, 'c1')
    expect(clipColor(base)).toEqual(NEUTRAL_COLOR)
    expect(clipColor({ ...base, color: { brightness: 10 } }).brightness).toBe(10)
    expect(
      isSameColor({ brightness: 1, contrast: 2, saturation: 3, temperature: 4 }, {
        brightness: 1,
        contrast: 2,
        saturation: 3,
        temperature: 4,
      }),
    ).toBe(true)
    expect(
      isSameColor(NEUTRAL_COLOR, { ...NEUTRAL_COLOR, temperature: 1 }),
    ).toBe(false)
  })
})

describe('调色到预览 / 导出的映射', () => {
  it('CSS filter：0 值不写，非 0 才写', () => {
    expect(cssColorFilter(NEUTRAL_COLOR)).toBe('')
    expect(cssColorFilter({ ...NEUTRAL_COLOR, saturation: 80 })).toBe('saturate(1.8)')
    expect(
      cssColorFilter({ brightness: 100, contrast: -100, saturation: 0, temperature: 0 }),
    ).toBe('brightness(2) contrast(0)')
  })

  it('色温叠加层：暖橙 / 冷蓝，强度 |t|/400 上限 0.25', () => {
    expect(temperatureTint(NEUTRAL_COLOR)).toBeNull()
    expect(temperatureTint({ ...NEUTRAL_COLOR, temperature: 80 })).toEqual({
      color: 'rgb(255, 160, 60)',
      alpha: 0.2,
    })
    expect(temperatureTint({ ...NEUTRAL_COLOR, temperature: -100 })).toEqual({
      color: 'rgb(60, 160, 255)',
      alpha: 0.25,
    })
  })

  it('FFmpeg 滤镜：全 0 无滤镜，非 0 才追加 eq / colorbalance', () => {
    expect(ffmpegColorFilters(NEUTRAL_COLOR)).toEqual([])
    expect(ffmpegColorFilters({ ...NEUTRAL_COLOR, temperature: 80 })).toEqual([
      'colorbalance=rs=0.4:bs=-0.4',
    ])
    expect(
      ffmpegColorFilters({ brightness: 50, contrast: 20, saturation: 80, temperature: 0 }),
    ).toEqual(['eq=brightness=0.25:contrast=1.2:saturation=1.4653'])
  })
})

describe('旧草稿的调色归一化（读取入口统一处理一次）', () => {
  const projectWith = (color: unknown): Project => {
    const base = createInitialProject({ url: SOURCE.url, duration: 10 }, 'c1')
    return {
      ...base,
      clips: [{ ...base.clips[0], color: color as never }],
    }
  }

  it('旧草稿没有 color 字段时补齐为四个 0', () => {
    const legacy = projectWith(undefined)
    const normalized = normalizeProjectColors(legacy)
    expect(normalized.clips[0].color).toEqual(NEUTRAL_COLOR)
    expect(normalized).not.toBe(legacy)
  })

  it('已归一化的工程保持引用不变（不产生多余渲染）', () => {
    const already = projectWith({ brightness: 0, contrast: 0, saturation: 0, temperature: 0 })
    expect(normalizeProjectColors(already)).toBe(already)
  })

  it('越界 / 缺失字段在读取时被夹取补齐', () => {
    const partial = projectWith({ saturation: 500 })
    expect(normalizeProjectColors(partial).clips[0].color).toEqual({
      brightness: 0,
      contrast: 0,
      saturation: 100,
      temperature: 0,
    })
  })
})
describe('阴影配色：选色保留不透明度（C13a）', () => {
  it('解析 CSS 颜色的 alpha', () => {
    expect(colorAlphaOf('rgba(0, 0, 0, 0.55)')).toBeCloseTo(0.55, 6)
    expect(colorAlphaOf('rgba(10,20,30,1)')).toBe(1)
    expect(colorAlphaOf('rgba(10,20,30,0)')).toBe(0)
    expect(colorAlphaOf('#000000')).toBe(1)
    expect(colorAlphaOf('#00000088')).toBeCloseTo(136 / 255, 6)
    expect(colorAlphaOf('transparent')).toBe(0)
    expect(colorAlphaOf('')).toBeNull()
    expect(colorAlphaOf(undefined)).toBeNull()
  })

  it('颜色选择器取值：rgba 也能回填成 #rrggbb', () => {
    expect(colorToHex('rgba(17, 34, 51, 0.55)')).toBe('#112233')
    expect(colorToHex('#abc')).toBe('#aabbcc')
    expect(colorToHex('transparent', '#123456')).toBe('#123456')
    expect(colorToHex(undefined, '#123456')).toBe('#123456')
  })

  it('选新颜色时保留旧不透明度，写成 rgba', () => {
    // 默认阴影 rgba(0,0,0,0.55) → 选蓝色后仍然是 0.55 的透明度（而不是不透明）。
    expect(recolorKeepingAlpha('#0000ff', 'rgba(0, 0, 0, 0.55)')).toBe('rgba(0, 0, 255, 0.55)')
    // 已经是 8 位十六进制也能读到 alpha。
    expect(recolorKeepingAlpha('#00ff00', '#11223388')).toBe('rgba(0, 255, 0, 0.533)')
    // 不透明颜色保持不透明。
    expect(recolorKeepingAlpha('#ff0000', '#000000')).toBe('rgb(255, 0, 0)')
    // 读不到 alpha 时用回退值。
    expect(recolorKeepingAlpha('#ffffff', undefined, 0.4)).toBe('rgba(255, 255, 255, 0.4)')
  })

  it('两次选色不会把透明度丢掉（幂等）', () => {
    const first = recolorKeepingAlpha('#336699', 'rgba(0, 0, 0, 0.55)')
    const second = recolorKeepingAlpha('#993366', first)
    expect(colorAlphaOf(second)).toBeCloseTo(0.55, 6)
    expect(colorToHex(second)).toBe('#993366')
  })
})
