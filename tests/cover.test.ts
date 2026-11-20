import { describe, expect, it } from 'vitest'
import {
  COVER_MAX_SHORT_SIDE,
  buildCoverPng,
  coverCropRect,
  coverFrameSeconds,
  coverTargetSize,
  drawCoverInto,
  evenSize,
  normalizeCover,
} from '../src/editor/core/cover'
import { createClearCoverCommand, createSetCoverCommand } from '../src/editor/core/commands'
import { createInitialProject } from '../src/editor/core/operations'
import { normalizeProjectCover } from '../src/editor/core/draft'
import { createProjectFile } from '../src/editor/projectFile'
import { createEditorStore } from '../src/editor/store/editorStore'
import type { Project, ProjectCover, SourceInfo } from '../src/editor/core/types'

const SOURCE: SourceInfo = {
  url: 'blob:test',
  name: 'test.mp4',
  size: 1024,
  duration: 20,
  width: 1920,
  height: 1080,
}

const COVER: ProjectCover = {
  dataUrl: 'data:image/jpeg;base64,AAAA',
  source: { kind: 'frame', time: 3.2 },
  mode: 'separate',
}

const withCover = (cover: ProjectCover | undefined): Project => {
  const base = createInitialProject({ url: SOURCE.url, duration: 20 }, 'c0')
  return cover ? { ...base, cover } : base
}

describe('封面尺寸与裁剪（core/cover）', () => {
  it('强制偶数尺寸', () => {
    expect(evenSize(129)).toBe(128)
    expect(evenSize(130)).toBe(130)
    expect(evenSize(1)).toBe(2)
    expect(evenSize(0)).toBe(2)
  })

  it('跟随画布比例，短边不超过 1280', () => {
    const landscape = coverTargetSize(1920, 1080)
    expect(landscape.width / landscape.height).toBeCloseTo(16 / 9, 2)
    expect(Math.min(landscape.width, landscape.height)).toBeLessThanOrEqual(COVER_MAX_SHORT_SIDE)
    expect(landscape.width % 2).toBe(0)
    expect(landscape.height % 2).toBe(0)

    // 竖屏画布：短边是宽
    const portrait = coverTargetSize(1080, 1920)
    expect(portrait.width).toBeLessThanOrEqual(COVER_MAX_SHORT_SIDE + 2)
    expect(portrait.height % 2).toBe(0)
  })

  it('cover 裁剪：4:3 图片放进 16:9 画布时上下裁掉，不拉伸', () => {
    // 源 4:3，目标 16:9 → 按宽度铺满，裁掉上下
    const crop = coverCropRect(800, 600, 1600, 900)
    expect(crop.width).toBeCloseTo(800, 5)
    expect(crop.height).toBeCloseTo(450, 5)
    expect(crop.x).toBeCloseTo(0, 5)
    expect(crop.y).toBeCloseTo(75, 5)
  })

  it('cover 裁剪：源更宽时左右裁掉', () => {
    const crop = coverCropRect(1920, 800, 1600, 900)
    expect(crop.height).toBeCloseTo(800, 5)
    expect(crop.width).toBeCloseTo(800 * (1600 / 900), 5)
  })

  it('一帧时长按 fps 计算', () => {
    expect(coverFrameSeconds(30)).toBeCloseTo(1 / 30, 6)
    expect(coverFrameSeconds(60)).toBeCloseTo(1 / 60, 6)
    expect(coverFrameSeconds(0)).toBeCloseTo(1 / 30, 6)
  })
})

describe('封面的容错归一化', () => {
  it('合法封面保留字段，mode 缺省 separate', () => {
    expect(normalizeCover({ dataUrl: 'data:image/png;base64,AA', source: { kind: 'image', name: 'a.png' } })).toEqual({
      dataUrl: 'data:image/png;base64,AA',
      source: { kind: 'image', name: 'a.png' },
      mode: 'separate',
    })
  })

  it('非法值当作没有封面', () => {
    expect(normalizeCover(undefined)).toBeUndefined()
    expect(normalizeCover({})).toBeUndefined()
    expect(normalizeCover({ dataUrl: 'https://x/y.jpg' })).toBeUndefined()
    expect(normalizeCover({ dataUrl: 'blob:abc' })).toBeUndefined()
  })

  it('帧来源的 time 被夹到非负', () => {
    const cover = normalizeCover({
      dataUrl: 'data:image/jpeg;base64,AA',
      source: { kind: 'frame', time: -5 },
      mode: 'first-frame',
    })
    expect(cover?.source).toEqual({ kind: 'frame', time: 0 })
    expect(cover?.mode).toBe('first-frame')
  })

  it('normalizeProjectCover 在已合法时保持引用不变', () => {
    const project = withCover(COVER)
    expect(normalizeProjectCover(project)).toBe(project)
    // 非法封面被清掉，且没有封面时引用不变
    const broken = withCover({ ...COVER, dataUrl: 'not-a-data-url' })
    expect(normalizeProjectCover(broken).cover).toBeUndefined()
    const bare = withCover(undefined)
    expect(normalizeProjectCover(bare)).toBe(bare)
  })
})

describe('封面命令（1 步撤销）', () => {
  it('设置封面后可以撤销回无封面', () => {
    const project = withCover(undefined)
    const next = createSetCoverCommand(COVER).execute(project)
    expect(next.cover).toEqual(COVER)
    // 卸载封面命令本身不改其它字段
    expect(next.clips).toBe(project.clips)
  })

  it('没有封面时移除命令返回原 project（不产生历史）', () => {
    const project = withCover(undefined)
    expect(createClearCoverCommand().execute(project)).toBe(project)
    const withOne = createSetCoverCommand(COVER).execute(project)
    expect(createClearCoverCommand().execute(withOne).cover).toBeUndefined()
  })
})

describe('封面随草稿与工程文件一起序列化', () => {
  it('工程文件包含封面字段', () => {
    const project = withCover(COVER)
    const file = createProjectFile({
      project,
      assets: [],
      sourceUrl: SOURCE.url,
      timelineZoom: 92,
      timelineSettings: {
        mainTrackMagnet: true,
        autoSnap: true,
        linkage: true,
        previewAxis: false,
        captionFollow: true,
      },
      playhead: 0,
    })
    expect(file.project.cover).toEqual(COVER)
    // JSON 往返后仍然完整（dataURL 不会被丢）
    const restored = JSON.parse(JSON.stringify(file))
    expect(restored.project.cover.dataUrl).toBe(COVER.dataUrl)
    expect(restored.project.cover.mode).toBe('separate')
  })
})

describe('store：封面 action', () => {
  const makeStore = () => {
    const store = createEditorStore()
    store.getState().loadSource(SOURCE)
    return store
  }

  it('没有画面可截时只给警告，不写状态、不产生历史', () => {
    const store = makeStore()
    store.getState().setCoverFromFrame(999)
    const state = store.getState()
    expect(state.project.cover).toBeUndefined()
    expect(state.canUndo).toBe(false)
    expect(state.toast?.message).toContain('没有可截取的画面')
  })

  it('拒绝非图片类型（只接受 jpg / png / webp）', () => {
    const store = makeStore()
    const file = new File(['x'], 'a.txt', { type: 'text/plain' })
    store.getState().setCoverFromImage(file)
    expect(store.getState().project.cover).toBeUndefined()
    expect(store.getState().toast?.message).toContain('只支持 JPG / PNG / WebP')
  })

  it('切换导出模式与移除封面都可撤销', () => {
    const store = makeStore()
    const state = store.getState()
    // 用公开的 hydrateDraft 载入一份带封面的草稿（等价于重载草稿后的状态）。
    const withCoverProject: Project = { ...state.project, cover: COVER }
    state.hydrateDraft({
      project: withCoverProject,
      assets: state.assets,
      source: state.source,
      timelineZoom: state.timelineZoom,
      timelineSettings: { ...state.timelineSettings, captionFollow: true },
      playhead: 0,
    })
    expect(store.getState().project.cover?.mode).toBe('separate')

    store.getState().setCoverMode('first-frame')
    expect(store.getState().project.cover?.mode).toBe('first-frame')
    store.getState().undo()
    expect(store.getState().project.cover?.mode).toBe('separate')

    store.getState().clearCover()
    expect(store.getState().project.cover).toBeUndefined()
    store.getState().undo()
    expect(store.getState().project.cover?.dataUrl).toBe(COVER.dataUrl)
  })

  it('封面面板开关与预览标志互不影响工程', () => {
    const store = makeStore()
    const before = store.getState().project
    store.getState().openCoverPanel()
    expect(store.getState().coverPanelOpen).toBe(true)
    store.getState().setCoverPreview(true)
    expect(store.getState().coverPreview).toBe(true)
    store.getState().closeCoverPanel()
    expect(store.getState().coverPanelOpen).toBe(false)
    expect(store.getState().coverPreview).toBe(false)
    expect(store.getState().project).toBe(before)
  })
})

// 说明：canvas / Image 在 jsdom 里不可用，这里只验证「渲染入口存在且失败信息明确」。
describe('封面 PNG 渲染入口', () => {
  it('读不到图片时抛出明确错误（不静默返回空）', async () => {
    await expect(buildCoverPng(1280, 720, COVER)).rejects.toThrow(/封面/)
  })

  it('drawCoverInto 使用 cover 裁剪（不拉伸）', () => {
    const calls: number[][] = []
    const context = {
      drawImage: (...args: number[]) => calls.push(args),
    } as unknown as CanvasRenderingContext2D
    drawCoverInto(context, {} as CanvasImageSource, 800, 600, 1600, 900)
    expect(calls).toHaveLength(1)
    const [, sx, sy, sw, sh, dx, dy, dw, dh] = calls[0]
    expect(sw / sh).toBeCloseTo(1600 / 900, 4) // 裁出的区域与目标同比例
    expect(dw).toBe(1600)
    expect(dh).toBe(900)
    expect(dx).toBe(0)
    expect(dy).toBe(0)
    expect(sx).toBeCloseTo(0, 4)
    expect(sy).toBeCloseTo(75, 4)
  })
})