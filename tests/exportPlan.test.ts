import { describe, expect, it } from 'vitest'
import { getOutputDimensions } from '../src/editor/core/aspect'
import {
  buildExportArgs,
  buildExportPlan,
  getExportCrf,
} from '../src/editor/core/exportPlan'
import {
  addOverlayTrackFromClip,
  createInitialProject,
  splitProjectAt,
  trimProjectRight,
} from '../src/editor/core/operations'
import type { Clip, Project, SourceInfo } from '../src/editor/core/types'

const SOURCE: SourceInfo = {
  url: 'blob:test',
  name: 'source.mp4',
  size: 12_000_000,
  duration: 10,
  width: 1920,
  height: 1080,
}

const SECOND: SourceInfo = {
  url: 'blob:second',
  name: 'second.webm',
  size: 4_000_000,
  duration: 6,
  width: 960,
  height: 540,
}

function complexProject(): Project {
  const base = createInitialProject({ url: SOURCE.url, duration: 10 }, 'clip-a')
  const template = base.clips[0]
  const first: Clip = {
    ...template,
    sourceEnd: 4,
    rotation: 90,
    flipH: true,
    crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
    scale: 1.2,
    position: { x: 0.08, y: -0.06 },
  }
  const freeze: Clip = {
    ...template,
    id: 'freeze-a',
    type: 'freeze',
    sourceStart: 4,
    sourceEnd: 7,
    freezeFrameTime: 4,
    flipV: true,
  }
  const last: Clip = {
    ...template,
    id: 'clip-b',
    sourceStart: 4,
    sourceEnd: 10,
    rotation: -45,
    scale: 1.4,
  }
  return {
    ...base,
    aspectRatio: 'original',
    clips: [first, freeze, last],
    exportQuality: { resolution: '720p', fps: 30 },
  }
}

/** Primary clip from SOURCE plus a second clip from a different asset. */
function multiSourceProject(): Project {
  const base = createInitialProject({ url: SOURCE.url, duration: 6 }, 'clip-a')
  const template = base.clips[0]
  return {
    ...base,
    aspectRatio: 'original',
    clips: [
      { ...template, sourceEnd: 6 },
      {
        ...template,
        id: 'clip-b',
        sourceUrl: SECOND.url,
        sourceStart: 0,
        sourceEnd: 4,
      },
    ],
    exportQuality: { resolution: '720p', fps: 30 },
  }
}

describe('getOutputDimensions', () => {
  it('keeps the requested quality and caps it at the source size', () => {
    expect(getOutputDimensions('16:9', '1080p', SOURCE)).toEqual({ width: 1920, height: 1080 })
    expect(getOutputDimensions('16:9', '4K', SOURCE)).toEqual({ width: 1920, height: 1080 })
    expect(getOutputDimensions('original', '720p', SOURCE)).toEqual({ width: 1280, height: 720 })
    expect(getOutputDimensions('1:1', '480p', SOURCE)).toEqual({ width: 480, height: 480 })
  })

  it('caps portrait targets against both source axes', () => {
    const dimensions = getOutputDimensions('9:16', '1080p', SOURCE)
    expect(dimensions.width % 2).toBe(0)
    expect(dimensions.height % 2).toBe(0)
    expect(dimensions.width).toBeLessThanOrEqual(SOURCE.width)
    expect(dimensions.height).toBeLessThanOrEqual(SOURCE.height)
  })

  it('returns even dimensions for 4K source material', () => {
    const dimensions = getOutputDimensions('4:3', '4K', {
      width: 4096,
      height: 2160,
    })
    expect(dimensions.width % 2).toBe(0)
    expect(dimensions.height % 2).toBe(0)
    expect(dimensions.width).toBeLessThanOrEqual(4096)
    expect(dimensions.height).toBeLessThanOrEqual(2160)
  })
})

describe('buildExportPlan', () => {
  it('builds video and audio graphs for mixed video/freeze clips', () => {
    const plan = buildExportPlan(complexProject(), SOURCE, true)
    expect(plan.width).toBe(1280)
    expect(plan.height).toBe(720)
    expect(plan.totalDuration).toBe(13)
    expect(plan.hasAudio).toBe(true)
    expect(plan.audioLabel).toBe('outa')
    expect(plan.crf).toBe(22)
    expect(plan.inputs).toHaveLength(1)
    expect(plan.graph).toContain('[0:v]split=3')
    expect(plan.graph).toContain('trim=start=0:end=4')
    expect(plan.graph).toContain('hflip')
    expect(plan.graph).toContain('vflip')
    expect(plan.graph).toContain('rotate=1.5708')
    expect(plan.graph).toContain('crop=')
    expect(plan.graph).toContain('scale=')
    expect(plan.graph).toContain('pad=1280:720')
    expect(plan.graph).toContain('tpad=stop_mode=clone')
    expect(plan.graph).toContain('concat=n=3:v=1:a=0[outv]')
    expect(plan.graph).toContain('[0:a]asplit=2')
    expect(plan.graph).toContain('anullsrc=r=48000:cl=stereo')
    expect(plan.graph).toContain('concat=n=3:v=0:a=1[outa]')
    expect(plan.graph).not.toContain('undefined')
  })

  it('omits audio branches when the source has no audio', () => {
    const plan = buildExportPlan(complexProject(), SOURCE, false)
    expect(plan.hasAudio).toBe(false)
    expect(plan.audioLabel).toBeNull()
    expect(plan.graph).not.toContain('[0:a]')
    expect(plan.graph).not.toContain('anullsrc')

    const args = buildExportArgs(plan, 'graph.txt', 'out.mp4')
    expect(args).toContain('-filter_complex_script')
    expect(args).toContain('libx264')
    expect(args).not.toContain('-c:a')
  })

  it('treats a freeze-only project as video-only', () => {
    const project = complexProject()
    project.clips = [project.clips[1]]
    const plan = buildExportPlan(project, SOURCE, true)
    expect(plan.hasAudio).toBe(false)
    expect(plan.graph).toContain('tpad=stop_mode=clone')
    expect(plan.graph).not.toContain('anullsrc')
  })

  it('creates a mappable MP4 command with filters and quality settings', () => {
    const plan = buildExportPlan(complexProject(), SOURCE, true)
    const args = buildExportArgs(plan, 'graph.txt', 'result.mp4')
    expect(args[0]).toBe('-i')
    expect(args).toContain(plan.inputs[0].file)
    expect(args).toContain('-filter_complex_script')
    expect(args).toContain('graph.txt')
    expect(args).toContain('[outv]')
    expect(args).toContain('[outa]')
    expect(args).toContain('30')
    expect(args).toContain('-pix_fmt')
    expect(args).toContain('yuv420p')
    expect(args).toContain('-movflags')
    expect(args.at(-1)).toBe('result.mp4')
  })

  it('throws for an empty timeline and exposes quality crf values', () => {
    const empty = createInitialProject({ url: SOURCE.url, duration: 10 }, 'clip-a')
    empty.clips = []
    expect(() => buildExportPlan(empty, SOURCE, true)).toThrow()
    expect(getExportCrf('480p')).toBe(23)
    expect(getExportCrf('4K')).toBe(20)
  })

  it('builds an overlay graph with a second source input', () => {
    const base = createInitialProject({ url: SOURCE.url, duration: 10 }, 'clip-a')
    const project = addOverlayTrackFromClip(base, 'clip-a', 'track-over', 'overlay-a')!.project
    const plan = buildExportPlan(project, SOURCE, true)
    expect(plan.usesOverlaySource).toBe(true)
    expect(plan.totalDuration).toBe(10)
    expect(plan.inputs).toHaveLength(2)
    expect(plan.inputs[1].file).toBe(plan.inputs[0].file)
    expect(plan.graph).toContain('[1:v]')
    expect(plan.graph).toContain('overlay=0:0')
    expect(plan.graph).toContain('eof_action=pass')
    const args = buildExportArgs(plan, 'graph.txt', 'out.mp4')
    expect(args.filter((value) => value === '-i')).toHaveLength(2)
  })

  it('renders leading and middle gaps as black video with silent audio', () => {
    const leading = createInitialProject({ url: SOURCE.url, duration: 10 }, 'clip-a')
    leading.clips[0] = { ...leading.clips[0], gapBefore: 2 }
    const leadingPlan = buildExportPlan(leading, SOURCE, true)
    expect(leadingPlan.totalDuration).toBe(12)
    expect(leadingPlan.graph).toContain('color=c=black')
    expect(leadingPlan.graph).toContain('anullsrc=r=48000:cl=stereo')
    expect(leadingPlan.graph).toContain('concat=n=2:v=1:a=0[outv]')
    expect(leadingPlan.graph).toContain('concat=n=2:v=0:a=1[outa]')
    expect(leadingPlan.graph).not.toContain('undefined')

    const split = splitProjectAt(
      createInitialProject({ url: SOURCE.url, duration: 10 }, 'clip-a'),
      'clip-a',
      4,
      'clip-b',
    )!
    const trimmed = trimProjectRight(split, 'clip-a', 3)!
    const middlePlan = buildExportPlan(trimmed, SOURCE, true)
    expect(middlePlan.totalDuration).toBe(10)
    expect(middlePlan.graph).toContain('[0:v]split=2')
    expect(middlePlan.graph).toContain('[vsrc0_0]')
    expect(middlePlan.graph).toContain('concat=n=3:v=1:a=0[outv]')
    expect(middlePlan.graph).toContain('concat=n=3:v=0:a=1[outa]')
    expect(middlePlan.graph).toContain('color=c=black')
    expect(middlePlan.graph).toContain('anullsrc')
  })
})

describe('multi-source export plan', () => {
  it('maps every clip to its own asset input', () => {
    const plan = buildExportPlan(multiSourceProject(), [SOURCE, SECOND], true)
    expect(plan.inputs).toHaveLength(2)
    expect(plan.inputs[0].url).toBe(SOURCE.url)
    expect(plan.inputs[0].file).toBe('input0.mp4')
    expect(plan.inputs[1].url).toBe(SECOND.url)
    expect(plan.inputs[1].file).toBe('input1.webm')
    expect(plan.inputs[1].duration).toBe(6)
    expect(plan.graph).toContain('[0:v]trim=start=0:end=6')
    expect(plan.graph).toContain('[1:v]trim=start=0:end=4')
    expect(plan.graph).toContain('[v0][v1]concat=n=2:v=1:a=0[outv]')
    expect(plan.graph).toContain('[0:a]atrim=start=0:end=6')
    expect(plan.graph).toContain('[1:a]atrim=start=0:end=4')
    expect(plan.graph).not.toContain('undefined')
  })

  it('splits only the input that feeds several clips', () => {
    const template = createInitialProject({ url: SOURCE.url, duration: 10 }, 'clip-a').clips[0]
    const project: Project = {
      ...createInitialProject({ url: SOURCE.url, duration: 10 }, 'clip-a'),
      clips: [
        { ...template, id: 'a1', sourceEnd: 3 },
        { ...template, id: 'a2', sourceStart: 3, sourceEnd: 6 },
        {
          ...template,
          id: 'b1',
          sourceUrl: SECOND.url,
          sourceStart: 0,
          sourceEnd: 4,
        },
      ],
    }
    const plan = buildExportPlan(project, [SOURCE, SECOND], true)
    expect(plan.graph).toContain('[0:v]split=2')
    expect(plan.graph).toContain('[vsrc0_0]')
    expect(plan.graph).toContain('[vsrc0_1]')
    expect(plan.graph).toContain('[1:v]trim=start=0:end=4')
    expect(plan.graph).not.toContain('[1:v]split')
    const args = buildExportArgs(plan, 'graph.txt', 'out.mp4')
    expect(args.filter((value) => value === '-i')).toHaveLength(2)
  })

  it('keeps audio from silent-capable inputs and fills a silent asset with anullsrc', () => {
    const silentSecond: SourceInfo = { ...SECOND, hasAudio: false }
    const plan = buildExportPlan(multiSourceProject(), [SOURCE, silentSecond], true)
    expect(plan.hasAudio).toBe(true)
    expect(plan.inputs[1].hasAudio).toBe(false)
    expect(plan.graph).toContain('[0:a]atrim')
    expect(plan.graph).not.toContain('[1:a]')
    expect(plan.graph).toContain('anullsrc=r=48000:cl=stereo,atrim=duration=4')
  })

  it('uses each asset resolution when fitting it to the canvas', () => {
    const portrait: SourceInfo = {
      url: 'blob:portrait',
      name: 'portrait.mp4',
      size: 1_000_000,
      duration: 8,
      width: 540,
      height: 960,
    }
    const template = createInitialProject({ url: SOURCE.url, duration: 10 }, 'clip-a').clips[0]
    const project: Project = {
      ...createInitialProject({ url: SOURCE.url, duration: 10 }, 'clip-a'),
      aspectRatio: 'original',
      clips: [
        { ...template, id: 'wide', sourceEnd: 6 },
        {
          ...template,
          id: 'tall',
          sourceUrl: portrait.url,
          sourceStart: 0,
          sourceEnd: 4,
        },
      ],
      exportQuality: { resolution: '720p', fps: 30 },
    }
    const plan = buildExportPlan(project, [SOURCE, portrait], true)
    expect(plan.width).toBe(1280)
    expect(plan.height).toBe(720)
    // 540x960 fits to 405x720 and is centered at x=438, which only happens if
    // the second clip is measured with its own asset dimensions.
    expect(plan.graph).toContain('pad=1280:720:438:0:black')
  })

  it('falls back to the primary source when only one source is provided', () => {
    const plan = buildExportPlan(multiSourceProject(), SOURCE, true)
    expect(plan.inputs).toHaveLength(1)
    expect(plan.inputs[0].url).toBe(SOURCE.url)
    expect(plan.graph).toContain('[0:v]split=2')
    expect(plan.graph).not.toContain('[1:v]')
  })

  it('keeps per-asset branches when the timeline has gaps', () => {
    const project = multiSourceProject()
    project.clips[0] = { ...project.clips[0], gapBefore: 2 }
    const plan = buildExportPlan(project, [SOURCE, SECOND], true)
    expect(plan.inputs).toHaveLength(2)
    expect(plan.totalDuration).toBe(12)
    expect(plan.graph).toContain('color=c=black')
    expect(plan.graph).toContain('[1:v]trim=start=0:end=4')
    expect(plan.graph).toContain('concat=n=3:v=1:a=0[outv]')
    expect(plan.graph).toContain('[0:a]atrim=start=0:end=6')
    expect(plan.graph).toContain('concat=n=3:v=0:a=1[outa]')
  })

  it('reads an overlay from its own asset input', () => {
    const base = createInitialProject({ url: SOURCE.url, duration: 10 }, 'clip-a')
    const overlay = addOverlayTrackFromClip(base, 'clip-a', 'track-over', 'overlay-a')!.project
    const project: Project = {
      ...overlay,
      overlayTracks: overlay.overlayTracks!.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => ({ ...clip, sourceUrl: SECOND.url })),
      })),
    }
    const plan = buildExportPlan(project, [SOURCE, SECOND], true)
    expect(plan.inputs).toHaveLength(2)
    expect(plan.inputs[1].url).toBe(SECOND.url)
    expect(plan.inputs[1].file).toBe('input1.webm')
    expect(plan.inputs[1].hasAudio).toBe(false)
    expect(plan.usesOverlaySource).toBe(true)
    expect(plan.graph).toContain('[1:v]')
    expect(plan.graph).not.toContain('[0:v]overlay')
    const args = buildExportArgs(plan, 'graph.txt', 'out.mp4')
    expect(args.filter((value) => value === '-i')).toHaveLength(2)
    expect(args).toContain('input1.webm')
  })

  it('duplicates a base input for an overlay that uses the same asset', () => {
    const project = addOverlayTrackFromClip(
      multiSourceProject(),
      'clip-a',
      'track-over',
      'overlay-a',
    )!.project
    const plan = buildExportPlan(project, [SOURCE, SECOND], true)
    expect(plan.inputs).toHaveLength(3)
    expect(plan.inputs[0].file).toBe('input0.mp4')
    expect(plan.inputs[1].file).toBe('input1.webm')
    expect(plan.inputs[2].file).toBe('input0.mp4')
    expect(plan.inputs[2].url).toBe(SOURCE.url)
    const args = buildExportArgs(plan, 'graph.txt', 'out.mp4')
    expect(args.filter((value) => value === '-i')).toHaveLength(3)
    expect(args).toContain('input1.webm')
  })
})
describe('调色滤镜（eq / colorbalance）', () => {
  const chainOf = (graph: string, label: string): string =>
    graph.split(';').find((part) => part.includes(label)) ?? ''

  it('四项全 0 时不生成 eq / colorbalance 滤镜', () => {
    const base = createInitialProject({ url: SOURCE.url, duration: 10 }, 'clip-a')
    const neutral: Project = {
      ...base,
      clips: base.clips.map((clip) => ({
        ...clip,
        color: { brightness: 0, contrast: 0, saturation: 0, temperature: 0 },
      })),
    }
    const plan = buildExportPlan(neutral, [SOURCE], true)
    expect(plan.graph).not.toContain('eq=')
    expect(plan.graph).not.toContain('colorbalance=')
    // 与完全不带 color 字段的工程生成同一张图
    expect(plan.graph).toBe(buildExportPlan(base, [SOURCE], true).graph)
  })

  it('非 0 时滤镜串按系数写入（亮度 / 对比度 / 饱和度 / 色温）', () => {
    const base = createInitialProject({ url: SOURCE.url, duration: 10 }, 'clip-a')
    const project: Project = {
      ...base,
      clips: base.clips.map((clip) => ({
        ...clip,
        color: { brightness: 50, contrast: 20, saturation: 80, temperature: 80 },
      })),
    }
    const plan = buildExportPlan(project, [SOURCE], true)
    // brightness 取 b/200（±0.5 区间）；contrast/saturation 取 1+c/100
    expect(plan.graph).toContain(
      'eq=brightness=0.25:contrast=1.2:saturation=1.4653',
    )
    // 暖调：加红减蓝
    expect(plan.graph).toContain('colorbalance=rs=0.4:bs=-0.4')
    // 冷调符号相反
    const cool: Project = {
      ...base,
      clips: base.clips.map((clip) => ({
        ...clip,
        color: { temperature: -80 },
      })),
    }
    expect(buildExportPlan(cool, [SOURCE], true).graph).toContain(
      'colorbalance=rs=-0.4:bs=0.4',
    )
  })

  it('叠加轨的调色只作用于叠加链，主轨不受影响', () => {
    const base = createInitialProject({ url: SOURCE.url, duration: 10 }, 'clip-a')
    const overlay = addOverlayTrackFromClip(base, 'clip-a', 'track-over', 'overlay-a')!.project

    // 只有叠加片段带调色
    const overlayColored: Project = {
      ...overlay,
      overlayTracks: overlay.overlayTracks!.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => ({ ...clip, color: { saturation: 80 } })),
      })),
    }
    const plan = buildExportPlan(overlayColored, [SOURCE], true)
    expect(chainOf(plan.graph, '[ov0]')).toContain('saturation=1.4653')
    expect(chainOf(plan.graph, '[basev]')).not.toContain('eq=')

    // 只有主轨片段带调色：叠加链不带该参数
    const mainColored: Project = {
      ...overlay,
      clips: overlay.clips.map((clip) => ({ ...clip, color: { saturation: 80 } })),
      overlayTracks: overlay.overlayTracks!.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => ({ ...clip, color: undefined })),
      })),
    }
    const plan2 = buildExportPlan(mainColored, [SOURCE], true)
    expect(chainOf(plan2.graph, '[basev]')).toContain('saturation=1.4653')
    expect(chainOf(plan2.graph, '[ov0]')).not.toContain('eq=')
  })
})
