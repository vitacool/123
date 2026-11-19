import { describe, expect, it } from 'vitest'
import {
  IMAGE_DEFAULT_DURATION,
  IMAGE_MAX_DURATION,
  IMAGE_MIN_DURATION,
  imageClipSpan,
  imageDurationBounds,
  isImageClip,
} from '../src/editor/core/image'
import { clipFrameSourceAt, clipLocalAt, clipTimelineDuration } from '../src/editor/core/clipTime'
import { createClip } from '../src/editor/core/operations'
import { getTimeline } from '../src/editor/core/timeline'
import { buildExportArgs, buildExportPlan } from '../src/editor/core/exportPlan'
import { createInitialProject } from '../src/editor/core/operations'
import type { Clip, Project, SourceInfo } from '../src/editor/core/types'

const IMAGE_SOURCE: SourceInfo = {
  url: 'blob:image',
  name: 'photo.png',
  size: 120_000,
  duration: IMAGE_DEFAULT_DURATION,
  width: 1080,
  height: 1920,
  kind: 'image',
}

function imageClip(overrides: Partial<Clip> = {}): Clip {
  return createClip(
    IMAGE_SOURCE.url,
    0,
    IMAGE_DEFAULT_DURATION,
    { type: 'image', volume: 0, ...overrides },
    'img-1',
  )
}

function imageProject(overrides: Partial<Clip> = {}): Project {
  const base = createInitialProject({ url: IMAGE_SOURCE.url, duration: 3 }, 'img-1')
  return { ...base, aspectRatio: '9:16', clips: [imageClip(overrides)] }
}

describe('image 素材与片段', () => {
  it('识别图片片段', () => {
    expect(isImageClip(imageClip())).toBe(true)
    expect(isImageClip(createClip('a', 0, 3))).toBe(false)
  })

  it('默认 3 秒，span 从 0 开始', () => {
    expect(imageClipSpan()).toEqual({ sourceStart: 0, sourceEnd: IMAGE_DEFAULT_DURATION })
    expect(IMAGE_DEFAULT_DURATION).toBe(3)
  })

  it('时长夹在允许范围内', () => {
    expect(imageClipSpan(0).sourceEnd).toBe(IMAGE_MIN_DURATION)
    expect(imageClipSpan(IMAGE_MAX_DURATION * 2).sourceEnd).toBe(IMAGE_MAX_DURATION)
    expect(imageClipSpan(Number.NaN).sourceEnd).toBe(IMAGE_DEFAULT_DURATION)
    expect(imageDurationBounds()).toEqual({ min: IMAGE_MIN_DURATION, max: IMAGE_MAX_DURATION })
  })
})

describe('图片片段的时间映射（静帧）', () => {
  it('时间轴时长 = sourceEnd - sourceStart，可任意拉伸', () => {
    expect(clipTimelineDuration(imageClip({ sourceEnd: 10 }))).toBe(10)
  })

  it('显示帧恒定（不随局部时间变化）', () => {
    const clip = imageClip({ sourceEnd: 8 })
    expect(clipFrameSourceAt(clip, 0)).toBe(0)
    expect(clipFrameSourceAt(clip, 3.5)).toBe(0)
    expect(clipFrameSourceAt(clip, 8)).toBe(0)
  })

  it('源时间 → 局部时间对静帧返回 0', () => {
    expect(clipLocalAt(imageClip(), 1.2)).toBe(0)
  })

  it('时间轴按片段时长占位', () => {
    const project = imageProject({ sourceEnd: 5 })
    const timeline = getTimeline(project.clips)
    expect(timeline[0].start).toBe(0)
    expect(timeline[0].end).toBe(5)
  })
})

describe('首个素材为图片时的初始工程', () => {
  it('图片素材建成静帧片段，而不是视频片段', () => {
    const project = createInitialProject(
      { url: IMAGE_SOURCE.url, duration: 3 },
      'img-1',
      'image',
    )
    expect(project.clips).toHaveLength(1)
    expect(project.clips[0].type).toBe('image')
    expect(project.clips[0].volume).toBe(0)
    expect(clipTimelineDuration(project.clips[0])).toBe(3)
  })

  it('视频素材行为不变（缺省 video）', () => {
    const project = createInitialProject({ url: 'blob:v', duration: 12 }, 'c1')
    expect(project.clips[0].type).toBe('video')
    expect(project.clips[0].sourceEnd).toBe(12)
    expect(project.clips[0].volume).toBeUndefined()
  })
})

describe('图片片段导出计划', () => {
  it('图片输入使用 -loop 1，并补静音音频', () => {
    const project = imageProject()
    const plan = buildExportPlan(project, IMAGE_SOURCE, true)
    expect(plan.inputs).toHaveLength(1)
    expect(plan.inputs[0].kind).toBe('image')
    expect(plan.hasAudio).toBe(true)

    const args = buildExportArgs(plan, 'graph.txt', 'out.mp4')
    // 图片输入前应有 -loop 1
    const loopIdx = args.indexOf('-loop')
    expect(loopIdx).toBeGreaterThanOrEqual(0)
    expect(args[loopIdx + 1]).toBe('1')
    // 滤镜图里图片分支按帧率对齐并裁剪时长
    expect(plan.graph).toContain('fps=')
    expect(plan.graph).toContain('trim=duration=')
  })

  it('图片片段没有音频分支（静音），但整体仍有音轨保证时长', () => {
    const plan = buildExportPlan(imageProject({ sourceEnd: 6 }), IMAGE_SOURCE, true)
    expect(plan.totalDuration).toBeCloseTo(6)
    expect(plan.audioLabel).not.toBeNull()
  })
})