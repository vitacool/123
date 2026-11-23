import { describe, expect, it } from 'vitest'
import {
  blendModeLabel,
  BLEND_MODES,
  canvasCompositeOperation,
  clipBlendMode,
  clipOpacity,
  DEFAULT_BLEND_MODE,
  DEFAULT_OPACITY,
  ffmpegBlendMode,
  hasBlendSettings,
  normalizeBlendMode,
  opacityFilters,
} from '../src/editor/core/blend'
import { buildExportPlan } from '../src/editor/core/exportPlan'
import { createUpdateAnyClipCommand } from '../src/editor/core/commands'
import { createClip, createInitialProject } from '../src/editor/core/operations'
import type { Clip, Project, SourceInfo } from '../src/editor/core/types'

const SOURCE: SourceInfo = {
  url: 'blob:v',
  name: 'v.mp4',
  size: 1_000_000,
  duration: 10,
  width: 1920,
  height: 1080,
}

describe('叠加片段裁剪（CropRect 打通）', () => {
  it('updateAnyClip 能改叠加片段的 crop', () => {
    const project = projectWithOverlay()
    const crop = { x: 0.1, y: 0.2, w: 0.6, h: 0.5 }
    const next = createUpdateAnyClipCommand('ovc', { crop }, '确认画面裁剪').execute(project)
    const overlayClip = next.overlayTracks![0].clips[0]
    expect(overlayClip.crop).toEqual(crop)
    // 主轨片段不受影响
    expect(next.clips[0].crop).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    // 原工程未被就地修改
    expect(project.overlayTracks![0].clips[0].crop).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })

  it('裁剪后的叠加片段导出仍然生成叠加分支', () => {
    const project = projectWithOverlay()
    const cropped = createUpdateAnyClipCommand(
      'ovc',
      { crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } },
      '确认画面裁剪',
    ).execute(project)
    const plan = buildExportPlan(cropped, SOURCE, true)
    // crop 滤镜参数应反映裁剪区域（1920x1080 的一半）
    expect(plan.graph).toContain('crop=960:540:')
  })
})

describe('不透明度', () => {
  it('缺省 1，越界夹取，非法值回退 1', () => {
    expect(clipOpacity(createClip('a', 0, 4))).toBe(DEFAULT_OPACITY)
    expect(clipOpacity(createClip('a', 0, 4, { opacity: 0.4 }))).toBeCloseTo(0.4)
    expect(clipOpacity(createClip('a', 0, 4, { opacity: -1 }))).toBe(0)
    expect(clipOpacity(createClip('a', 0, 4, { opacity: 9 }))).toBe(1)
    expect(clipOpacity(createClip('a', 0, 4, { opacity: Number.NaN }))).toBe(1)
  })
})

describe('混合模式映射（预览 = 导出）', () => {
  it('缺省 normal', () => {
    expect(clipBlendMode(createClip('a', 0, 4))).toBe(DEFAULT_BLEND_MODE)
    expect(normalizeBlendMode('nope')).toBe('normal')
    expect(normalizeBlendMode(undefined)).toBe('normal')
  })

  it('六种模式都有 Canvas 与 FFmpeg 映射', () => {
    expect(BLEND_MODES.map((mode) => mode.value)).toEqual([
      'normal',
      'screen',
      'multiply',
      'overlay',
      'lighten',
      'darken',
    ])
    for (const mode of BLEND_MODES) {
      expect(mode.canvas).toBeTruthy()
      expect(mode.ffmpeg).toBeTruthy()
      expect(blendModeLabel(mode.value)).toBe(mode.label)
    }
  })

  it('具体映射值正确', () => {
    expect(canvasCompositeOperation('screen')).toBe('screen')
    expect(canvasCompositeOperation('multiply')).toBe('multiply')
    expect(canvasCompositeOperation('overlay')).toBe('overlay')
    expect(canvasCompositeOperation('lighten')).toBe('lighten')
    expect(canvasCompositeOperation('darken')).toBe('darken')
    expect(canvasCompositeOperation('normal')).toBe('source-over')
    expect(ffmpegBlendMode('darken')).toBe('darken')
    expect(ffmpegBlendMode('normal')).toBe('normal')
  })

  it('hasBlendSettings 只在非默认值时返回 true', () => {
    expect(hasBlendSettings(createClip('a', 0, 4))).toBe(false)
    expect(hasBlendSettings(createClip('a', 0, 4, { opacity: 0.5 }))).toBe(true)
    expect(hasBlendSettings(createClip('a', 0, 4, { blendMode: 'screen' }))).toBe(true)
  })
})

describe('导出侧滤镜', () => {
  it('opacityFilters：1 不产出，<1 转 yuva420p 并缩放 alpha', () => {
    expect(opacityFilters(1)).toEqual([])
    expect(opacityFilters(0.5)).toEqual(['format=yuva420p', 'colorchannelmixer=aa=0.5'])
    expect(opacityFilters(0)).toEqual(['format=yuva420p', 'colorchannelmixer=aa=0'])
    expect(opacityFilters(0.333333)).toEqual(['format=yuva420p', 'colorchannelmixer=aa=0.3333'])
  })
})

function projectWithOverlay(overrides = {}): Project {
  const base = createInitialProject({ url: SOURCE.url, duration: 10 }, 'c1')
  return {
    ...base,
    clips: [createClip(SOURCE.url, 0, 10, {}, 'c1')],
    overlayTracks: [
      {
        id: 'ov1',
        name: '叠加 1',
        muted: false,
        hidden: false,
        clips: [createClip(SOURCE.url, 0, 4, { gapBefore: 1, ...overrides }, 'ovc')],
      },
    ],
  }
}

describe('叠加片段的不透明度与混合模式导出', () => {
  it('不透明度生成 colorchannelmixer=aa=', () => {
    const plan = buildExportPlan(projectWithOverlay({ opacity: 0.4 }), SOURCE, true)
    expect(plan.graph).toContain('format=yuva420p')
    expect(plan.graph).toContain('colorchannelmixer=aa=0.4')
  })

  it('混合模式使用 blend=all_mode', () => {
    const plan = buildExportPlan(projectWithOverlay({ blendMode: 'screen' }), SOURCE, true)
    expect(plan.graph).toContain('blend=all_mode=screen')
  })

  it('每个模式都映射到对应 all_mode', () => {
    for (const mode of ['screen', 'multiply', 'overlay', 'lighten', 'darken'] as const) {
      const plan = buildExportPlan(projectWithOverlay({ blendMode: mode }), SOURCE, true)
      expect(plan.graph).toContain(`blend=all_mode=${ffmpegBlendMode(mode)}`)
    }
  })

  it('正常模式仍走 overlay 合成（不引入 blend）', () => {
    const plan = buildExportPlan(projectWithOverlay(), SOURCE, true)
    expect(plan.graph).toContain('overlay=0:0')
    expect(plan.graph).not.toContain('blend=all_mode')
  })
})
function projectWithMainClip(
  overrides: Partial<Clip> = {},
  background?: Project['canvasBackground'],
): Project {
  const base = createInitialProject({ url: SOURCE.url, duration: 10 }, 'c1')
  return {
    ...base,
    ...(background ? { canvasBackground: background } : {}),
    clips: [createClip(SOURCE.url, 0, 10, overrides, 'c1')],
  }
}

/**
 * 主轨片段和叠加轨一样，预览里会应用 opacity / blendMode（clipRender 设置
 * globalAlpha 与 globalCompositeOperation），导出必须跟着做，否则「预览半透明、
 * 导出不透明」。
 *
 * 预览里主轨片段下面铺的是该片段的画布背景（black → 画布底色 #070808、
 * color → 纯色、blur → 自身画面模糊），所以导出也要先生成这层背景再合成。
 */
describe('主轨片段的不透明度与混合模式导出', () => {
  it('不透明度：画面层带 alpha，并叠在画布背景上', () => {
    const plan = buildExportPlan(projectWithMainClip({ opacity: 0.4 }), SOURCE, true)
    expect(plan.graph).toContain('colorchannelmixer=aa=0.4')
    expect(plan.graph).toContain('overlay=0:0')
    // 预览黑场用的是画布底色 #070808，导出对齐它（不是纯黑）。
    expect(plan.graph).toContain('0x070808')
    expect(plan.graph).not.toContain('blend=all_mode')
  })

  it('纯色背景：合成到工程背景色上', () => {
    const plan = buildExportPlan(
      projectWithMainClip({ opacity: 0.5 }, { type: 'color', color: '#1b3b6f' }),
      SOURCE,
      true,
    )
    expect(plan.graph).toContain('colorchannelmixer=aa=0.5')
    expect(plan.graph).toContain('0x1b3b6f')
  })

  it('混合模式：blend=all_mode，并用画面 alpha 还原透明度', () => {
    const plan = buildExportPlan(projectWithMainClip({ blendMode: 'multiply' }), SOURCE, true)
    expect(plan.graph).toContain('blend=all_mode=multiply')
    // 混合模式不能把背景整体替换掉（透明区域 / 半透明区域都要按 alpha 混合）。
    expect(plan.graph).toContain('alphaextract')
    expect(plan.graph).toContain('alphamerge')
    expect(plan.graph).toContain('overlay=0:0')
  })

  it('不透明度 + 混合模式同时生效', () => {
    const plan = buildExportPlan(
      projectWithMainClip({ opacity: 0.6, blendMode: 'screen' }),
      SOURCE,
      true,
    )
    expect(plan.graph).toContain('colorchannelmixer=aa=0.6')
    expect(plan.graph).toContain('blend=all_mode=screen')
  })

  it('默认（不透明度 1 / 正常模式）不改变原有滤镜图', () => {
    const plan = buildExportPlan(projectWithMainClip(), SOURCE, true)
    expect(plan.graph).not.toContain('colorchannelmixer')
    expect(plan.graph).not.toContain('blend=all_mode')
    expect(plan.graph).toContain('pad=')
  })
})

describe('主轨合成：特殊背景 / 空隙时间轴', () => {
  it('模糊背景 + 不透明度：背景来自同一画面模糊层，画面按 alpha 叠加', () => {
    const plan = buildExportPlan(
      projectWithMainClip({ opacity: 0.5 }, { type: 'blur', blurAmount: 24 }),
      SOURCE,
      true,
    )
    expect(plan.graph).toContain('gblur=sigma=12')
    expect(plan.graph).toContain('colorchannelmixer=aa=0.5')
    expect(plan.graph).toContain('overlay=0:0')
  })

  it('有空隙的时间轴（gapBefore）：同样先垫背景再合成', () => {
    const plan = buildExportPlan(
      projectWithMainClip({ opacity: 0.5, gapBefore: 1 }),
      SOURCE,
      true,
    )
    expect(plan.graph).toContain('colorchannelmixer=aa=0.5')
    expect(plan.graph).toContain('color=c=0x070808')
    expect(plan.graph).toContain('overlay=0:0')
  })
})
