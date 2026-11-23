import { describe, expect, it } from 'vitest'
import {
  frameCaptureSize,
  frameCompositionAt,
  frameFileName,
} from '../src/editor/core/frameCompose'
import { frameCaptureWarning } from '../src/editor/services/frameCapture'
import {
  addOverlayTrackFromClip,
  createClip,
  createInitialProject,
} from '../src/editor/core/operations'
import type { Project, SourceInfo, TextClip, TextTrack } from '../src/editor/core/types'

const SOURCE: SourceInfo = {
  url: 'blob:frame-source',
  name: 'frame.mp4',
  size: 8_000_000,
  duration: 20,
  width: 1920,
  height: 1080,
  kind: 'video',
  hasAudio: true,
}

const PORTRAIT: SourceInfo = {
  url: 'blob:portrait',
  name: 'portrait.mp4',
  size: 8_000_000,
  duration: 20,
  width: 1080,
  height: 1920,
  kind: 'video',
}

function project(duration = 10): Project {
  return {
    ...createInitialProject({ url: SOURCE.url, duration }, 'clip-a'),
    aspectRatio: '16:9',
    exportQuality: { resolution: '1080p', fps: 30 },
  }
}

function textClip(overrides: Partial<TextClip> = {}): TextClip {
  return {
    id: 'text-a',
    text: '字幕',
    start: 2,
    end: 6,
    x: 0.5,
    y: 0.9,
    fontSize: 0.05,
    color: '#ffffff',
    background: 'transparent',
    align: 'center',
    bold: false,
    ...overrides,
  }
}

function textTrack(clips: TextClip[], overrides: Partial<TextTrack> = {}): TextTrack {
  return {
    id: 'text-track',
    name: '字幕',
    muted: false,
    hidden: false,
    clips,
    ...overrides,
  }
}

describe('frameCaptureWarning（缺失汇总提示）', () => {
  it('没有失败时返回 null，多条失败压成一句', () => {
    expect(frameCaptureWarning([])).toBeNull()
    expect(frameCaptureWarning(['素材「a」无法解码画面'])).toBe('素材「a」无法解码画面')
    expect(frameCaptureWarning(['素材「a」无法解码画面', '素材「b」已不在素材库'])).toBe(
      '素材「a」无法解码画面（共 2 处画面缺失）',
    )
  })
})

describe('frameCaptureSize（截帧尺寸 = 导出分辨率）', () => {
  it('横屏工程按导出分辨率出图', () => {
    const target = frameCaptureSize(
      { ...project(), exportQuality: { resolution: '720p', fps: 30 } },
      SOURCE,
    )
    expect(target).toEqual({ width: 1280, height: 720 })
  })

  it('1080p 16:9 工程出 1920×1080', () => {
    expect(frameCaptureSize(project(), SOURCE)).toEqual({ width: 1920, height: 1080 })
  })

  it('4K 不会放大超过参考素材', () => {
    const target = frameCaptureSize(
      { ...project(), exportQuality: { resolution: '4K', fps: 30 } },
      SOURCE,
    )
    expect(target).toEqual({ width: 1920, height: 1080 })
  })

  it('9:16 工程出竖图（宽 < 高，且宽高为偶数）', () => {
    const target = frameCaptureSize(
      { ...project(), aspectRatio: '9:16', exportQuality: { resolution: '1080p', fps: 30 } },
      PORTRAIT,
    )
    expect(target.width).toBeLessThan(target.height)
    expect(target.width % 2).toBe(0)
    expect(target.height % 2).toBe(0)
    expect(target).toEqual({ width: 1080, height: 1920 })
  })

  it('没有参考素材时按 1920×1080 兜底', () => {
    const target = frameCaptureSize(
      { ...project(), aspectRatio: '1:1', exportQuality: { resolution: '480p', fps: 30 } },
      null,
    )
    expect(target).toEqual({ width: 480, height: 480 })
  })
})

describe('frameFileName（<素材名>-<时间码>.png）', () => {
  it('时间码复用 formatPlayhead，冒号换成 -', () => {
    expect(frameFileName('demo.mp4', 83.5, 30)).toBe('demo-00-01-23-15.png')
    expect(frameFileName('demo.mp4', 0, 30)).toBe('demo-00-00-00-00.png')
    expect(frameFileName('demo.mp4', 3.5, 24)).toBe('demo-00-00-03-12.png')
  })

  it('去掉扩展名并替换文件名非法字符', () => {
    const name = frameFileName('a/b:c*?"<>|.mov', 1, 30)
    expect(name.endsWith('-00-00-01-00.png')).toBe(true)
    expect(name.startsWith('a-b-c-')).toBe(true)
    // 文件名里不允许出现 : / * ? " < > | 等非法字符。
    expect(name.replace(/-/g, '')).toBe('abc00000100.png')
  })

  it('空素材名回退 framecut，非法时间按 0 处理', () => {
    expect(frameFileName(undefined, 5, 30)).toBe('framecut-00-00-05-00.png')
    expect(frameFileName('  ', 5, 30)).toBe('framecut-00-00-05-00.png')
    expect(frameFileName('demo.mp4', Number.NaN, 30)).toBe('demo-00-00-00-00.png')
    expect(frameFileName('demo.mp4', -4, 30)).toBe('demo-00-00-00-00.png')
  })

  it('超长素材名截断到 64 字符', () => {
    const name = `${'x'.repeat(120)}.mp4`
    expect(frameFileName(name, 0, 30)).toBe(`${'x'.repeat(64)}-00-00-00-00.png`)
  })
})

describe('frameCompositionAt（图层排序）', () => {
  it('单片段工程：只有一层主轨，背景跟随该片段', () => {
    const base = project()
    const composition = frameCompositionAt(base, 3)
    expect(composition.mainVisible).toBe(true)
    expect(composition.main).toHaveLength(1)
    expect(composition.main[0].clip.id).toBe('clip-a')
    expect(composition.main[0].trackId).toBeNull()
    expect(composition.backgroundClip?.id).toBe('clip-a')
    expect(composition.overlays).toHaveLength(0)
    expect(composition.texts).toHaveLength(0)
  })

  it('叠加轨按数组顺序自下而上（trackId 标记来源）', () => {
    const first = addOverlayTrackFromClip(project(), 'clip-a', 'track-low', 'overlay-low')!.project
    const second = addOverlayTrackFromClip(first, 'clip-a', 'track-high', 'overlay-high')!.project
    const composition = frameCompositionAt(second, 1)
    expect(composition.overlays.map((layer) => layer.trackId)).toEqual(['track-low', 'track-high'])
    expect(composition.overlays.map((layer) => layer.clip.id)).toEqual([
      'overlay-low',
      'overlay-high',
    ])
  })

  it('遵守叠加轨的 hidden / enabled', () => {
    const overlay = addOverlayTrackFromClip(project(), 'clip-a', 'track-over', 'overlay-a')!.project
    const hidden: Project = {
      ...overlay,
      overlayTracks: overlay.overlayTracks!.map((track) => ({ ...track, hidden: true })),
    }
    expect(frameCompositionAt(hidden, 1).overlays).toHaveLength(0)

    const disabled: Project = {
      ...overlay,
      overlayTracks: overlay.overlayTracks!.map((track) => ({ ...track, enabled: false })),
    }
    expect(frameCompositionAt(disabled, 1).overlays).toHaveLength(0)
  })

  it('主轨 hidden 时不出主轨图层，但叠加轨与文字仍在', () => {
    const overlay = addOverlayTrackFromClip(project(), 'clip-a', 'track-over', 'overlay-a')!.project
    const withText: Project = { ...overlay, textTracks: [textTrack([textClip()])] }
    const hiddenMain: Project = { ...withText, mainTrack: { hidden: true } }
    const composition = frameCompositionAt(hiddenMain, 3)
    expect(composition.mainVisible).toBe(false)
    expect(composition.main).toHaveLength(0)
    expect(composition.backgroundClip).toBeNull()
    expect(composition.overlays).toHaveLength(1)
    expect(composition.texts).toHaveLength(1)
  })

  it('主轨 disabled 等同于不可见', () => {
    const disabled: Project = { ...project(), mainTrack: { enabled: false } }
    const composition = frameCompositionAt(disabled, 3)
    expect(composition.mainVisible).toBe(false)
    expect(composition.main).toHaveLength(0)
  })

  it('转场重叠区返回两层主轨，左段在前、右段在后', () => {
    const base = project()
    const transition: Project = {
      ...base,
      clips: [
        createClip(SOURCE.url, 0, 5, { transitionOut: { type: 'fade', duration: 1 } }, 'left'),
        createClip(SOURCE.url, 5, 10, {}, 'right'),
      ],
    }
    const overlap = frameCompositionAt(transition, 4.5)
    expect(overlap.main.map((layer) => layer.clip.id)).toEqual(['left', 'right'])
    expect(overlap.main[0].start).toBe(0)
    expect(overlap.main[1].start).toBe(4)
    expect(overlap.main[0].duration).toBe(5)
    expect(overlap.backgroundClip?.id).toBe('left')

    // 重叠区之外只有一层。
    const single = frameCompositionAt(transition, 7)
    expect(single.main.map((layer) => layer.clip.id)).toEqual(['right'])
  })

  it('文字 / 字幕：起点含、终点不含，遵守轨道可见与 linkHidden', () => {
    const base = project()
    const visible = textClip({ id: 'visible', start: 2, end: 6 })
    const hiddenLink = textClip({ id: 'linked', start: 2, end: 6, link: { clipId: 'clip-a', sourceStart: 0, sourceEnd: 4, padStart: 0, padEnd: 0, linkHidden: true } })
    const projectWithText: Project = {
      ...base,
      textTracks: [textTrack([visible, hiddenLink])],
    }
    expect(frameCompositionAt(projectWithText, 2).texts.map((item) => item.clip.id)).toEqual([
      'visible',
    ])
    // 与预览一致：终点前 0.001 秒就退出显示（避免与下一段重影）。
    expect(frameCompositionAt(projectWithText, 5.99).texts.map((item) => item.clip.id)).toEqual([
      'visible',
    ])
    expect(frameCompositionAt(projectWithText, 5.999).texts).toHaveLength(0)
    expect(frameCompositionAt(projectWithText, 6).texts).toHaveLength(0)

    const hiddenTrack: Project = {
      ...projectWithText,
      textTracks: [{ ...textTrack([visible]), hidden: true }],
    }
    expect(frameCompositionAt(hiddenTrack, 3).texts).toHaveLength(0)
  })

  it('字幕组样式合并进解析后的样式', () => {
    const base = project()
    const track = textTrack([textClip({ fontSize: 0.04 })], { captionStyle: { fontSize: 0.08 } })
    const composition = frameCompositionAt({ ...base, textTracks: [track] }, 3)
    expect(composition.texts[0].clip.fontSize).toBe(0.04)
    // resolveCaptionStyle：组样式优先于片段自身字号（与预览一致）。
    expect(composition.texts[0].style.fontSize).toBe(0.08)
  })
})