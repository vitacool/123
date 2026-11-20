import { describe, expect, it } from 'vitest'
import { createInitialProject } from '../src/editor/core/operations'
import { setKeyframeInProject } from '../src/editor/core/keyframes'
import { evalAnimation } from '../src/editor/core/animation'
import { relinkCaptions } from '../src/editor/core/captionLink'
import {
  buildTextOverlayRenderSegments,
  estimateTextAnimationFrames,
  hasAnyTextAnimation,
  hasTextAnimation,
  resolveTextOverrides,
  textAnimationFrameCount,
  textAnimationPerformanceHint,
  TEXT_ANIMATION_FRAME_WARNING,
} from '../src/editor/core/textAnimation'
import { buildTextOverlayTimeline } from '../src/editor/core/textOverlay'
import { drawTextClip } from '../src/editor/core/textRender'
import { resolveCaptionStyle, textClipDuration, updateCaptionStyleInProject } from '../src/editor/core/text'
import type { Project, SourceInfo, TextClip, TextTrack } from '../src/editor/core/types'

const SOURCE: SourceInfo = {
  url: 'blob:text-animation',
  name: 'text.mp4',
  size: 1024,
  duration: 20,
  width: 1920,
  height: 1080,
  kind: 'video',
  hasAudio: false,
}

function textClip(id: string, extra: Partial<TextClip> = {}): TextClip {
  return {
    id,
    text: id,
    start: 0,
    end: 2,
    x: 0.5,
    y: 0.8,
    fontSize: 0.08,
    color: '#ffffff',
    background: 'transparent',
    align: 'center',
    bold: false,
    ...extra,
  }
}

function textTrack(id: string, clips: TextClip[], kind: 'text' | 'caption' = 'text'): TextTrack {
  return { id, name: id, muted: false, hidden: false, enabled: true, clips, kind }
}

function textProject(clips: TextClip[], extra: Partial<Project> = {}): Project {
  const base = createInitialProject({ url: SOURCE.url, duration: 20 }, 'c1')
  return {
    ...base,
    aspectRatio: '16:9',
    exportQuality: { resolution: '480p', fps: 30 },
    textTracks: [textTrack('text-1', clips)],
    ...extra,
  }
}

const SCALE_KEYS = [
  { t: 0, value: 1, ease: 'linear' as const },
  { t: 1, value: 1.3, ease: 'linear' as const },
]
const OPACITY_KEYS = [
  { t: 0, value: 1, ease: 'linear' as const },
  { t: 1, value: 0, ease: 'linear' as const },
]
const POSITION_KEYS = [
  { t: 0, value: 0.8, ease: 'linear' as const },
  { t: 1, value: 0.2, ease: 'linear' as const },
]

describe('文本关键帧求值（commit 2 验收 #1/#2）', () => {
  it('按字幕自身 start/end 归一化求值 position/scale/opacity', () => {
    const clip = textClip('t1', {
      start: 10,
      end: 14,
      scale: 1,
      opacity: 1,
      anim: {
        'position.y': POSITION_KEYS,
        scale: SCALE_KEYS,
        opacity: OPACITY_KEYS,
      },
    })
    const project = textProject([clip])
    const style = resolveCaptionStyle(clip, project.textTracks![0].captionStyle)
    const atStart = resolveTextOverrides(clip, 0, style)
    const atMid = resolveTextOverrides(clip, 2, style)
    const atEnd = resolveTextOverrides(clip, 4, style)
    expect(atStart.position?.y).toBeCloseTo(0.8)
    expect(atStart.scale).toBeCloseTo(1)
    expect(atStart.opacity).toBeCloseTo(1)
    expect(atMid.position?.y).toBeCloseTo(0.5)
    expect(atMid.scale).toBeCloseTo(1.15)
    expect(atMid.opacity).toBeCloseTo(0.5)
    expect(atEnd.position?.y).toBeCloseTo(0.2)
    expect(atEnd.scale).toBeCloseTo(1.3)
    expect(atEnd.opacity).toBeCloseTo(0)
  })

  it('位置/缩放/不透明度插值与 evalAnimation 逐点一致', () => {
    const clip = textClip('t1', {
      start: 2,
      end: 6,
      anim: {
        'position.y': POSITION_KEYS,
        scale: SCALE_KEYS,
        opacity: OPACITY_KEYS,
      },
    })
    const style = resolveCaptionStyle(clip)
    const samples = [0, 1, 2, 3, 4].map((time) => time)
    for (const local of samples) {
      const t = local / 4
      const overrides = resolveTextOverrides(clip, local, style)
      expect(overrides.position!.y).toBeCloseTo(
        evalAnimation(POSITION_KEYS, t, style.y),
        5,
      )
      expect(overrides.scale).toBeCloseTo(evalAnimation(SCALE_KEYS, t, 1), 5)
      expect(overrides.opacity).toBeCloseTo(evalAnimation(OPACITY_KEYS, t, 1), 5)
    }
  })

  it('旧草稿 / 无动画文本按缺省 scale=1 opacity=1 绘制', () => {
    const clip = textClip('t1', { anim: undefined })
    const overrides = resolveTextOverrides(clip, 1, clip)
    expect(overrides.scale).toBe(1)
    expect(overrides.opacity).toBe(1)
    expect(overrides.position).toEqual({ x: clip.x, y: clip.y })
  })
})

describe('文本导出逐帧分块（commit 2 验收 #3/#4/#6）', () => {
  it('静态区间只出 1 帧，含动画的区间才逐帧；总帧数与输出对齐', () => {
    const staticClip = textClip('s1', { start: 0, end: 2 })
    const animatedClip = textClip('a1', {
      start: 4,
      end: 6,
      anim: { scale: SCALE_KEYS },
    })
    const project = textProject([staticClip, animatedClip])
    const intervals = buildTextOverlayTimeline(project, { duration: 8 })
    const segments = buildTextOverlayRenderSegments(intervals, 8, 30)
    expect(segments.reduce((sum, segment) => sum + segment.frames, 0)).toBe(240)
    expect(segments.filter((segment) => segment.animated)).toHaveLength(1)
    expect(segments.find((segment) => segment.animated)?.frames).toBe(60)
    // 240 帧里只有 60 帧动画需要逐帧 PNG，其余 3 个静态段各 1 张。
    const pngCount = segments.reduce(
      (sum, segment) => sum + (segment.animated ? segment.frames : 1),
      0,
    )
    expect(pngCount).toBe(63)
  })

  it('全静态项目没有文本动画，走原状态变化路径', () => {
    const project = textProject([textClip('s1', { start: 0, end: 2 })])
    expect(hasAnyTextAnimation(project)).toBe(false)
    const segments = buildTextOverlayRenderSegments(
      buildTextOverlayTimeline(project, { duration: 2 }),
      2,
      30,
    )
    expect(segments).toHaveLength(1)
    expect(segments[0].animated).toBe(false)
    expect(segments[0].frames).toBe(60)
  })

  it('字幕 link 裁剪后 anim.t 不重映射，归一化位置保持不变', () => {
    const base = textProject([], {})
    const clip = {
      ...base.clips[0],
      sourceStart: 0,
      sourceEnd: 10,
      volume: 1,
    }
    const caption = textClip('cap1', {
      start: 2,
      end: 4,
      anim: { scale: SCALE_KEYS, opacity: OPACITY_KEYS },
      link: {
        clipId: clip.id,
        sourceUrl: clip.sourceUrl,
        sourceStart: 2,
        sourceEnd: 4,
        padStart: 0,
        padEnd: 0,
      },
    })
    const project: Project = {
      ...base,
      clips: [clip],
      textTracks: [textTrack('caption-1', [caption], 'caption')],
    }
    const trimmed: Project = {
      ...project,
      clips: [{ ...clip, sourceStart: 3, sourceEnd: 10 }],
    }
    const relinked = relinkCaptions(trimmed)
    const after = relinked.textTracks![0].clips[0]
    expect(after.anim).toEqual(caption.anim)
    expect(after.start).not.toBe(caption.start)
    const beforeStyle = resolveCaptionStyle(caption)
    const afterStyle = resolveCaptionStyle(after)
    const beforeMid = resolveTextOverrides(
      caption,
      textClipDuration(caption) / 2,
      beforeStyle,
    )
    const afterMid = resolveTextOverrides(after, textClipDuration(after) / 2, afterStyle)
    expect(afterMid.scale).toBeCloseTo(beforeMid.scale!, 5)
    expect(afterMid.opacity).toBeCloseTo(beforeMid.opacity!, 5)
  })

  it('20 条字幕只有 3 条动画时帧数只统计动画片段', () => {
    const clips = Array.from({ length: 20 }, (_, index) =>
      textClip(`cap-${index}`, {
        start: index * 2,
        end: index * 2 + 2,
        anim: index < 3 ? { scale: SCALE_KEYS } : undefined,
      }),
    )
    const project = textProject([], {
      textTracks: [textTrack('caption-1', clips, 'caption')],
    })
    expect(estimateTextAnimationFrames(project, 30)).toBe(3 * 60)
    expect(textAnimationPerformanceHint(project, 30)).toBeNull()
  })

  it('动画文本总帧数 > 900 时导出对话框会警告', () => {
    const clips = Array.from({ length: 3 }, (_, index) =>
      textClip(`cap-${index}`, {
        start: index * 12,
        end: index * 12 + 11,
        anim: { opacity: OPACITY_KEYS },
      }),
    )
    const project = textProject([], {
      textTracks: [textTrack('caption-1', clips, 'caption')],
    })
    expect(estimateTextAnimationFrames(project, 30)).toBe(990)
    expect(990).toBeGreaterThan(TEXT_ANIMATION_FRAME_WARNING)
    expect(textAnimationPerformanceHint(project, 30)).toContain('990 帧')
    expect(textAnimationFrameCount(clips[0], 30)).toBe(330)
  })
})

describe('文本关键帧编辑 / 应用到全部字幕', () => {
  it('文本片段可以在 scale/opacity/position 上增删关键帧', () => {
    const project = textProject([textClip('t1')])
    const withKey = setKeyframeInProject(project, 't1', 'scale', 0.5, 1.4)
    expect(withKey).not.toBeNull()
    expect(withKey!.textTracks![0].clips[0].anim?.scale).toEqual([
      { t: 0.5, value: 1.4, ease: 'linear' },
    ])
    expect(hasTextAnimation(withKey!.textTracks![0].clips[0])).toBe(true)
  })

  it('应用到全部字幕只改静态样式，不复制 anim', () => {
    const first = textClip('t1', {
      anim: { scale: SCALE_KEYS },
      styleOverride: { color: '#ff0000' },
    })
    const second = textClip('t2', { start: 2, end: 4 })
    const project: Project = {
      ...textProject([first, second]),
      textTracks: [textTrack('caption-1', [first, second], 'caption')],
    }
    const updated = updateCaptionStyleInProject(project, 'caption-1', {
      color: '#00ff00',
      fontSize: 0.1,
    })
    expect(updated).not.toBeNull()
    const clips = updated!.textTracks![0].clips
    expect(clips[0].anim).toEqual(first.anim)
    expect(clips[0].styleOverride).toBeUndefined()
    expect(clips[1].anim).toBeUndefined()
    expect(updated!.textTracks![0].captionStyle?.color).toBe('#00ff00')
  })
})

describe('drawTextClip overrides（预览与导出共用）', () => {
  const makeContext = () => {
    const calls: { text: string; x: number; y: number; font: string; alpha: number }[] = []
    const context = {
      font: '',
      textBaseline: 'middle',
      textAlign: 'center',
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      lineJoin: 'round',
      miterLimit: 2,
      globalAlpha: 1,
      save: () => undefined,
      restore: () => undefined,
      measureText: (text: string) => ({ width: Math.max(1, text.length * 10) }),
      beginPath: () => undefined,
      roundRect: () => undefined,
      rect: () => undefined,
      fill: () => undefined,
      fillText(this: Record<string, unknown>, text: string, x: number, y: number) {
        calls.push({
          text,
          x,
          y,
          font: String(this.font),
          alpha: Number(this.globalAlpha),
        })
      },
      strokeText: () => undefined,
    }
    return { context: context as unknown as CanvasRenderingContext2D, calls }
  }

  it('scale 叠加在 fontSize 上，position/opacity 覆盖基础值', () => {
    const clip = textClip('t1', {
      text: 'Hi',
      x: 0.5,
      y: 0.8,
      fontSize: 0.1,
      scale: 1,
      opacity: 1,
    })
    const { context, calls } = makeContext()
    drawTextClip(context, clip, 1000, 1000, {
      position: { x: 0.25, y: 0.75 },
      scale: 1.5,
      opacity: 0.6,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].font).toContain('150px')
    expect(calls[0].alpha).toBeCloseTo(0.6)
    expect(calls[0].x).toBeCloseTo(250)
    expect(calls[0].y).toBeGreaterThan(600)
  })

  it('无 overrides 时也应用 TextClip 自身的 scale/opacity', () => {
    const clip = textClip('t1', {
      text: 'Hi',
      fontSize: 0.1,
      scale: 2,
      opacity: 0.5,
    })
    const { context, calls } = makeContext()
    drawTextClip(context, clip, 1000, 1000)
    expect(calls[0].font).toContain('200px')
    expect(calls[0].alpha).toBeCloseTo(0.5)
  })
})