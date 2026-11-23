import { describe, expect, it } from 'vitest'
import {
  CHROMA_KEY_DEFAULTS,
  chromaAlphaAtNeighborhood,
  chromaAlphaAtPixel,
  chromaAlphaFromDiff,
  chromaKeyFilter,
  despillFilter,
  despillParams,
  despillPixel,
  despillTypeFor,
  guessKeyColor,
  normalizeChromaKey,
  rgbToChromaUV,
} from '../src/editor/core/chromaKey'
import { buildExportPlan } from '../src/editor/core/exportPlan'
import { createClip, createInitialProject } from '../src/editor/core/operations'
import { normalizeProjectChromaKeys } from '../src/editor/core/draft'
import { captureVisualAttrs } from '../src/editor/core/attributeClipboard'
import type { ChromaKey } from '../src/editor/core/chromaKey'
import type { Clip, Project, SourceInfo } from '../src/editor/core/types'

const SOURCE: SourceInfo = {
  url: 'blob:chroma',
  name: 'src.mp4',
  size: 1_000_000,
  duration: 30,
  width: 1920,
  height: 1080,
}

const KEY = (patch: Partial<ChromaKey> = {}): ChromaKey => ({
  ...CHROMA_KEY_DEFAULTS,
  ...patch,
})

describe('RGB → U/V：与 FFmpeg 的定点公式一致', () => {
  it('纯绿 #00ff00 → U=44, V=21（手算自 vf_chromakey.c 的 RGB_TO_U/V）', () => {
    expect(rgbToChromaUV(0, 255, 0)).toEqual({ u: 44, v: 21 })
  })

  it('纯红 / 纯白 / 中灰的 U/V 与手算一致', () => {
    expect(rgbToChromaUV(255, 0, 0)).toEqual({ u: 85, v: 255 })
    expect(rgbToChromaUV(255, 255, 255)).toEqual({ u: 128, v: 128 })
    expect(rgbToChromaUV(128, 128, 128)).toEqual({ u: 128, v: 128 })
  })
})

describe('alpha：FFmpeg chromakey 公式', () => {
  it('幕布绿完全透明，红/白/灰完全不透明', () => {
    const key = KEY()
    expect(chromaAlphaAtPixel(0, 255, 0, key)).toBe(0)
    expect(chromaAlphaAtPixel(255, 0, 0, key)).toBe(1)
    expect(chromaAlphaAtPixel(255, 255, 255, key)).toBe(1)
    expect(chromaAlphaAtPixel(128, 128, 128, key)).toBe(1)
  })

  it('接近幕布绿的颜色落在 blend 斜坡上（手算 diff=0.09484）', () => {
    const diff = Math.sqrt((21 * 21 + 27 * 27) / (255 * 255 * 2))
    expect(diff).toBeCloseTo(0.09485, 4)
    // sim=0.1 → 低于阈值 → 全透明
    expect(chromaAlphaAtPixel(64, 255, 64, KEY({ similarity: 0.1, blend: 0.08 }))).toBe(0)
    // sim=0.05 → (0.09484-0.05)/0.08 = 0.5605
    expect(chromaAlphaAtPixel(64, 255, 64, KEY({ similarity: 0.05, blend: 0.08 }))).toBeCloseTo(
      0.5605,
      3,
    )
  })

  it('blend=0 时是二值硬边（diff>similarity）', () => {
    const hard = KEY({ similarity: 0.1, blend: 0 })
    expect(chromaAlphaFromDiff(0.09, hard)).toBe(0)
    expect(chromaAlphaFromDiff(0.1, hard)).toBe(0)
    expect(chromaAlphaFromDiff(0.11, hard)).toBe(1)
  })

  it('blend 边界夹取：结果永远在 0..1', () => {
    for (const diff of [-1, 0, 0.05, 0.5, 2]) {
      const alpha = chromaAlphaFromDiff(diff, KEY({ similarity: 0.01, blend: 0.5 }))
      expect(alpha).toBeGreaterThanOrEqual(0)
      expect(alpha).toBeLessThanOrEqual(1)
    }
  })

  it('3×3 邻域平均：均匀色块等于单像素，混合邻域取平均', () => {
    const key = KEY()
    const uniform: [number, number, number][] = Array.from({ length: 9 }, () => [0, 255, 0])
    expect(chromaAlphaAtNeighborhood(uniform, key)).toBe(0)
    // 一半幕布绿 + 一半纯红 → 平均色差约为纯红的一半
    const mixed: [number, number, number][] = Array.from({ length: 9 }, (_, i) =>
      i < 5 ? [0, 255, 0] : [255, 0, 0],
    )
    const alpha = chromaAlphaAtNeighborhood(mixed, KEY({ blend: 0.5 }))
    expect(alpha).toBeGreaterThan(0)
    expect(alpha).toBeLessThan(1)
  })
})

describe('despill：与 FFmpeg vf_despill.c 一致', () => {
  it('抠像颜色决定 type（偏绿 green / 偏蓝 blue）', () => {
    expect(despillTypeFor('#00ff00')).toBe('green')
    expect(despillTypeFor('#0000ff')).toBe('blue')
    expect(despillTypeFor('#000080')).toBe('blue')
    expect(despillTypeFor('#00ff80')).toBe('green')
  })

  it('spill=0 不生成 despill；spill>0 时 mix=0.5、expand=spill', () => {
    expect(despillParams(KEY({ spill: 0 }))).toBeNull()
    expect(chromaKeyFilter(KEY({ spill: 0 }))).not.toContain('despill')
    expect(despillParams(KEY({ spill: 0.6 }))).toEqual({
      type: 'green',
      mix: 0.5,
      expand: 0.6,
    })
    expect(despillParams(KEY({ color: '#0000ff', spill: 0.4 }))).toEqual({
      type: 'blue',
      mix: 0.5,
      expand: 0.4,
    })
  })

  it('纯绿像素被去溢色压成黑色（绿幕默认参数）', () => {
    const params = { type: 'green' as const, mix: 0.5, expand: 0.5 }
    // spillmap = 1 - (0*0.5 + 0*0.25) = 1 → g' = max(1 - 1, 0) = 0
    expect(despillPixel([0, 255, 0], params)).toEqual([0, 0, 0])
  })

  it('纯蓝像素在 green 模式下不受影响（只有 b 高、g 低）', () => {
    const params = { type: 'green' as const, mix: 0.5, expand: 0.5 }
    // spillmap = max(0 - (0*0.5 + 1*0.25), 0) = 0
    expect(despillPixel([0, 0, 255], params)).toEqual([0, 0, 255])
  })

  it('blue 模式下纯蓝像素：spillmap 命中但默认只减绿通道（蓝不变）', () => {
    const params = { type: 'blue' as const, mix: 0.5, expand: 0.5 }
    // spillmap = 1 - (0*0.5 + 0*0.25) = 1 → g' = max(0 - 1, 0) = 0；r/b 的 scale 都是 0
    expect(despillPixel([0, 0, 255], params)).toEqual([0, 0, 255])
  })

  it('肤色像素：green 模式轻微减绿，blue 模式不动（与 FFmpeg 默认参数一致）', () => {
    const skin: [number, number, number] = [222, 170, 140]
    const green = despillPixel(skin, { type: 'green', mix: 0.5, expand: 0.5 })
    // spillmap = 0.667 - (0.871*0.5 + 0.549*0.25) = 0.0945 → 绿通道降到 146
    expect(green[0]).toBe(222)
    expect(green[2]).toBe(140)
    expect(green[1]).toBeLessThan(170)
    expect(green[1]).toBeGreaterThan(140)
    // blue 模式：spillmap = 0.549 - (0.4355 + 0.667*0.25) < 0 → 原样
    expect(despillPixel(skin, { type: 'blue', mix: 0.5, expand: 0.5 })).toEqual(skin)
  })

  it('去溢色强度随 spill 增大（expand 越大减得越多）', () => {
    const pixel: [number, number, number] = [120, 255, 120]
    const weak = despillPixel(pixel, { type: 'green', mix: 0.5, expand: 0.1 })[1]
    const strong = despillPixel(pixel, { type: 'green', mix: 0.5, expand: 0.9 })[1]
    expect(strong).toBeLessThan(weak)
  })
})

describe('归一化 / 夹取 / 草稿兼容', () => {
  it('缺失或空值 → undefined（不抠像）', () => {
    expect(normalizeChromaKey(undefined)).toBeUndefined()
    expect(normalizeChromaKey(null)).toBeUndefined()
    expect(normalizeChromaKey({})).toBeUndefined()
    expect(normalizeChromaKey('#00ff00')).toBeUndefined()
  })

  it('similarity 夹到 0.01..0.5，blend 夹到 0..0.5，spill 夹到 0..1', () => {
    const key = normalizeChromaKey({ color: '#00ff00', similarity: 99, blend: -1, spill: 9 })!
    expect(key.similarity).toBe(0.5)
    expect(key.blend).toBe(0)
    expect(key.spill).toBe(1)
    const low = normalizeChromaKey({ color: '#00ff00', similarity: 0.0001 })!
    expect(low.similarity).toBe(0.01)
  })

  it('颜色规范成 #rrggbb（支持简写与非法值回退纯绿）', () => {
    expect(normalizeChromaKey({ color: '0F0' })!.color).toBe('#00ff00')
    expect(normalizeChromaKey({ color: 'nope' })!.color).toBe('#00ff00')
    expect(normalizeChromaKey({ color: '#123456' })!.color).toBe('#123456')
  })

  it('normalizeProjectChromaKeys：旧草稿保持 undefined，非法值被夹取且引用稳定', () => {
    const clip = createClip(SOURCE.url, 0, 5, {}, 'a')
    const project = { ...createInitialProject({ url: SOURCE.url, duration: 30 }, 'a'), clips: [clip] }
    const once = normalizeProjectChromaKeys(project)
    expect(once.clips[0].chromaKey).toBeUndefined()
    expect(once.clips[0]).toBe(clip)

    const key = normalizeChromaKey(KEY())!
    const withKey: Clip = { ...clip, chromaKey: key }
    const stable = normalizeProjectChromaKeys({ ...project, clips: [withKey] })
    expect(stable.clips[0]).toBe(withKey)

    const bad: Clip = { ...clip, chromaKey: { ...key, similarity: 9 } }
    expect(normalizeProjectChromaKeys({ ...project, clips: [bad] }).clips[0].chromaKey!.similarity).toBe(0.5)
  })

  it('属性复制包含 chromaKey，没有抠像时不写字段', () => {
    const key = normalizeChromaKey(KEY())!
    const clip = createClip(SOURCE.url, 0, 5, {}, 'a')
    expect(captureVisualAttrs({ ...clip, chromaKey: key }).chromaKey).toEqual(key)
    expect(captureVisualAttrs(clip).chromaKey).toBeUndefined()
  })

  it('四角取样猜背景色：绿幕/蓝幕/灰底', () => {
    expect(guessKeyColor([[0, 255, 0], [0, 250, 0], [0, 255, 10], [0, 240, 0]])).toBe('#00ff00')
    expect(guessKeyColor([[0, 0, 255], [0, 0, 250], [10, 0, 255], [0, 0, 240]])).toBe('#0000ff')
    expect(guessKeyColor([[128, 128, 128], [130, 130, 130], [128, 128, 128], [129, 129, 129]])).toBeNull()
    expect(guessKeyColor([])).toBeNull()
  })
})

describe('导出 graph：chromakey / despill 的位置与参数', () => {
  const projectWith = (clip: Clip): Project => ({
    ...createInitialProject({ url: SOURCE.url, duration: 30 }, clip.id),
    aspectRatio: '16:9',
    exportQuality: { resolution: '480p', fps: 30 },
    clips: [clip],
  })

  it('chromakey 在 crop/flip 之后、rotate 之前，参数格式与 FFmpeg 一致', () => {
    const clip = {
      ...createClip(SOURCE.url, 0, 6, { rotation: 20, flipH: true }, 'a'),
      chromaKey: normalizeChromaKey(KEY({ similarity: 0.12, blend: 0.06 }))!,
    }
    const graph = buildExportPlan(projectWith(clip), SOURCE, true).graph
    expect(graph).toContain('chromakey=color=0x00ff00:similarity=0.12:blend=0.06')
    expect(graph).toContain('format=yuva420p')
    expect(graph.indexOf('crop=')).toBeLessThan(graph.indexOf('chromakey='))
    expect(graph.indexOf('hflip')).toBeLessThan(graph.indexOf('chromakey='))
    expect(graph.indexOf('chromakey=')).toBeLessThan(graph.indexOf('rotate='))
    // 抠像后要垫背景层合成（蒙版外/抠掉区域露出画布背景）
    expect(graph).toContain('overlay=0:0:format=auto,format=yuv420p[outv]')
  })

  it('spill>0 时追加 despill，参数按 spill 映射', () => {
    const clip = {
      ...createClip(SOURCE.url, 0, 6, {}, 'a'),
      chromaKey: normalizeChromaKey(KEY({ spill: 0.5 }))!,
    }
    const graph = buildExportPlan(projectWith(clip), SOURCE, true).graph
    expect(graph).toContain('despill=type=green:mix=0.5:expand=0.5')
    expect(graph.indexOf('chromakey=')).toBeLessThan(graph.indexOf('despill='))
  })

  it('同时有蒙版与抠像：chromakey 在 alphamerge 之前', () => {
    const clip = {
      ...createClip(SOURCE.url, 0, 6, {}, 'a'),
      chromaKey: normalizeChromaKey(KEY())!,
      mask: {
        shape: 'ellipse' as const,
        x: 0.5,
        y: 0.5,
        width: 0.6,
        height: 0.6,
        rotation: 0,
        feather: 0.1,
        invert: false,
      },
    }
    const graph = buildExportPlan(projectWith(clip), SOURCE, true, {
      maskInputs: new Map([['a', 1]]),
    }).graph
    expect(graph).toContain('chromakey=')
    expect(graph).toContain('alphamerge')
    expect(graph.indexOf('chromakey=')).toBeLessThan(graph.indexOf('alphamerge'))
    expect(graph).toContain('[1:v]format=rgba,scale=')
  })

  it('没有抠像时 graph 里没有任何 chromakey/despill（快照安全的根据）', () => {
    const clip = createClip(SOURCE.url, 0, 6, {}, 'a')
    const graph = buildExportPlan(projectWith(clip), SOURCE, true).graph
    expect(graph).not.toContain('chromakey')
    expect(graph).not.toContain('despill')
  })

  it('despillFilter / chromaKeyFilter 的字符串形式', () => {
    expect(chromaKeyFilter(KEY({ color: '#00ff00', similarity: 0.1, blend: 0.08 }))).toBe(
      'chromakey=color=0x00ff00:similarity=0.1:blend=0.08',
    )
    expect(despillFilter(KEY({ spill: 0 }))).toBeNull()
    expect(despillFilter(KEY({ color: '#0000ff', spill: 0.25 }))).toBe(
      'despill=type=blue:mix=0.5:expand=0.25',
    )
  })
})