import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_FALLBACK,
  backgroundBlurPx,
  backgroundCssColor,
  backgroundFfmpegColor,
  backgroundLabel,
  clipBackground,
  DEFAULT_BACKGROUND,
  DEFAULT_BLUR_AMOUNT,
  isDefaultBackground,
  needsBackgroundLayer,
  normalizeBackground,
  projectBackground,
  withClipBackground,
} from '../src/editor/core/background'
import { buildExportPlan } from '../src/editor/core/exportPlan'
import { pruneProjectUrls, projectMediaUrls, remapProjectUrls } from '../src/editor/core/draft'
import { createSetCanvasBackgroundCommand, createSetClipBackgroundCommand } from '../src/editor/core/commands'
import { createClip, createInitialProject } from '../src/editor/core/operations'
import type { Project, SourceInfo } from '../src/editor/core/types'

const SOURCE: SourceInfo = {
  url: 'blob:v',
  name: 'v.mp4',
  size: 1_000_000,
  duration: 10,
  width: 1920,
  height: 1080,
}

function projectWith(background?: Project['canvasBackground']): Project {
  const base = createInitialProject({ url: SOURCE.url, duration: 10 }, 'c1')
  const project: Project = { ...base, clips: [createClip(SOURCE.url, 0, 5, {}, 'c1')] }
  if (background) project.canvasBackground = background
  return project
}

describe('背景归一化（旧草稿兼容）', () => {
  it('缺字段回退黑色', () => {
    expect(normalizeBackground(undefined)).toEqual(DEFAULT_BACKGROUND)
    expect(normalizeBackground(null)).toEqual(DEFAULT_BACKGROUND)
    expect(normalizeBackground({ type: 'nope' })).toEqual({ type: 'black' })
  })

  it('纯色补齐默认色', () => {
    expect(normalizeBackground({ type: 'color' })).toEqual({ type: 'color', color: '#000000' })
    expect(normalizeBackground({ type: 'color', color: '#ff0000' })).toEqual({
      type: 'color',
      color: '#ff0000',
    })
  })

  it('模糊补齐默认强度并夹取', () => {
    expect(normalizeBackground({ type: 'blur' }).blurAmount).toBe(DEFAULT_BLUR_AMOUNT)
    expect(normalizeBackground({ type: 'blur', blurAmount: 999 }).blurAmount).toBe(80)
    expect(normalizeBackground({ type: 'blur', blurAmount: -5 }).blurAmount).toBe(0)
  })

  it('图片背景已下线：归一化一律回退黑场（旧草稿也不会再出现「预览有、导出黑」）', () => {
    expect(normalizeBackground({ type: 'image' })).toEqual({ type: 'black' })
    expect(normalizeBackground({ type: 'image', imageUrl: 'blob:x' })).toEqual({ type: 'black' })
  })

  it('工程级与片段级解析', () => {
    const project = projectWith({ type: 'color', color: '#123456' })
    expect(projectBackground(project).color).toBe('#123456')
    const clip = createClip(SOURCE.url, 0, 5)
    expect(clipBackground(clip, project).type).toBe('color')
    const overridden = createClip(SOURCE.url, 0, 5, {
      background: { type: 'blur', blurAmount: 10 },
    })
    expect(clipBackground(overridden, project).type).toBe('blur')
  })

  it('中文名与默认判定', () => {
    expect(backgroundLabel('blur')).toBe('模糊填充')
    expect(backgroundLabel('image')).toBe('黑色')
    expect(isDefaultBackground({ type: 'black' })).toBe(true)
    expect(isDefaultBackground({ type: 'color', color: '#fff' })).toBe(false)
  })

  it('预览颜色映射：黑场用画布底色', () => {
    expect(backgroundCssColor({ type: 'black' })).toBe(BACKGROUND_FALLBACK)
    expect(backgroundCssColor({ type: 'color', color: '#abcdef' })).toBe('#abcdef')
  })

  it('FFmpeg 颜色映射', () => {
    expect(backgroundFfmpegColor({ type: 'color', color: '#ff8800' })).toBe('0xff8800')
    expect(backgroundFfmpegColor({ type: 'black' })).toBe('0x000000')
    expect(backgroundFfmpegColor({ type: 'color', color: 'bad' })).toBe('0x000000')
  })

  it('是否需要独立背景层', () => {
    expect(needsBackgroundLayer({ type: 'black' })).toBe(false)
    expect(needsBackgroundLayer({ type: 'color', color: '#fff' })).toBe(false)
    expect(needsBackgroundLayer({ type: 'blur' })).toBe(true)
    expect(needsBackgroundLayer({ type: 'image' })).toBe(false)
    expect(needsBackgroundLayer({ type: 'image', imageUrl: 'blob:x' })).toBe(false)
    expect(backgroundBlurPx({ type: 'blur', blurAmount: 30 })).toBe(30)
    // 1080p 为参考高度：540p 减半、4K 翻倍（相对观感一致）。
    expect(backgroundBlurPx({ type: 'blur', blurAmount: 30 }, 540)).toBe(15)
    expect(backgroundBlurPx({ type: 'blur', blurAmount: 30 }, 2160)).toBe(60)
    expect(backgroundBlurPx({ type: 'black' })).toBe(0)
  })

  it('withClipBackground 在黑场时清除覆盖', () => {
    const clip = createClip('a', 0, 5, { background: { type: 'blur' } })
    expect(withClipBackground(clip, { type: 'black' }).background).toBeUndefined()
    expect(withClipBackground(clip, { type: 'color', color: '#fff' }).background).toEqual({
      type: 'color',
      color: '#fff',
    })
  })
})

describe('草稿：背景图 URL 的保存与重建', () => {
  it('工程级与片段级背景图都进入媒体 URL 集合', () => {
    const base = projectWith({ type: 'image', imageUrl: 'blob:bg' })
    const project: Project = {
      ...base,
      clips: [
        createClip(SOURCE.url, 0, 5, {}, 'c1'),
        createClip(SOURCE.url, 0, 5, {
          background: { type: 'image', imageUrl: 'blob:clipbg' },
        }, 'c2'),
      ],
    }
    const urls = projectMediaUrls(project)
    expect(urls.has('blob:bg')).toBe(true)
    expect(urls.has('blob:clipbg')).toBe(true)
    expect(urls.has(SOURCE.url)).toBe(true)
  })

  it('重载后背景图 URL 一起重映射', () => {
    const base = projectWith({ type: 'image', imageUrl: 'blob:old' })
    const project: Project = {
      ...base,
      clips: [
        createClip(SOURCE.url, 0, 5, {
          background: { type: 'image', imageUrl: 'blob:old' },
        }, 'c1'),
      ],
    }
    const next = remapProjectUrls(project, new Map([['blob:old', 'blob:new']]))
    expect(next.canvasBackground?.imageUrl).toBe('blob:new')
    expect(next.clips[0].background?.imageUrl).toBe('blob:new')
  })

  it('背景图丢失时退回黑场', () => {
    const project = projectWith({ type: 'image', imageUrl: 'blob:gone' })
    const next = pruneProjectUrls(project, new Set([SOURCE.url]))
    expect(next.canvasBackground).toEqual({ type: 'black' })
  })

  it('背景图存在时保持不变', () => {
    const project = projectWith({ type: 'image', imageUrl: 'blob:keep' })
    const next = pruneProjectUrls(project, new Set([SOURCE.url, 'blob:keep']))
    expect(next.canvasBackground?.imageUrl).toBe('blob:keep')
  })
})

describe('背景命令', () => {
  it('设置工程背景，黑场则清除字段（不产生空值噪声）', () => {
    const project = projectWith()
    const colored = createSetCanvasBackgroundCommand({ type: 'color', color: '#00ff00' }).execute(
      project,
    )
    expect(colored.canvasBackground).toEqual({ type: 'color', color: '#00ff00' })
    const back = createSetCanvasBackgroundCommand({ type: 'black' }).execute(colored)
    expect(back.canvasBackground).toBeUndefined()
  })

  it('设置片段背景可跨主轨与叠加轨', () => {
    const base = projectWith()
    const project: Project = {
      ...base,
      overlayTracks: [
        {
          id: 'ov1',
          name: '叠加',
          muted: false,
          hidden: false,
          clips: [createClip(SOURCE.url, 0, 4, {}, 'ovc')],
        },
      ],
    }
    const next = createSetClipBackgroundCommand(['c1', 'ovc'], {
      type: 'blur',
      blurAmount: 12,
    }).execute(project)
    expect(next.clips[0].background).toEqual({ type: 'blur', blurAmount: 12 })
    expect(next.overlayTracks![0].clips[0].background).toEqual({ type: 'blur', blurAmount: 12 })
    // 原工程未被就地修改
    expect(project.clips[0].background).toBeUndefined()
  })
})

describe('导出侧背景', () => {
  it('纯色背景写进 pad 颜色', () => {
    const plan = buildExportPlan(
      projectWith({ type: 'color', color: '#ff8800' }),
      SOURCE,
      false,
    )
    expect(plan.graph).toContain('0xff8800')
  })

  it('黑场保持原来的 black 字面量', () => {
    const plan = buildExportPlan(projectWith(), SOURCE, false)
    expect(plan.graph).toContain(':black')
    expect(plan.graph).not.toContain('0x000000,')
  })

  it('模糊背景生成 split + gblur + overlay', () => {
    const plan = buildExportPlan(projectWith({ type: 'blur', blurAmount: 20 }), SOURCE, false)
    expect(plan.graph).toContain('split=2[bg00][fg00]')
    expect(plan.graph).toContain('gblur=sigma=10')
    expect(plan.graph).toContain('[bg0][fg0]overlay=0:0')
    expect(plan.graph).toContain('format=yuva420p')
  })

  it('片段级背景覆盖工程级', () => {
    const base = projectWith({ type: 'color', color: '#ff0000' })
    const project: Project = {
      ...base,
      clips: [
        createClip(SOURCE.url, 0, 5, { background: { type: 'blur', blurAmount: 8 } }, 'c1'),
      ],
    }
    const plan = buildExportPlan(project, SOURCE, false)
    expect(plan.graph).toContain('gblur=sigma=4')
    expect(plan.graph).not.toContain('0xff0000')
  })
})