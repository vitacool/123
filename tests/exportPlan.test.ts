import { describe, expect, it } from 'vitest'
import { getOutputDimensions } from '../src/editor/core/aspect'
import {
  buildExportArgs,
  buildExportPlan,
  getExportCrf,
} from '../src/editor/core/exportPlan'
import { addTextClipToProject, addTextTrackToProject } from '../src/editor/core/text'
import {
  addOverlayTrackFromClip,
  createClip,
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

  // 语义变更（意图如此）：素材缺失的片段不再静默用主素材顶替，而是输出画布背景。
  // 原先这里断言「回落到主素材并用 split=2 复用同一输入」，那会把别的素材画到这一段上，
  // 与素材库删除素材后的「素材已移除」语义冲突。
  it('renders a missing asset as canvas background instead of reusing the primary source', () => {
    const plan = buildExportPlan(multiSourceProject(), SOURCE, true)
    // 只剩一个可用输入，第二段（素材不在 sources 里）走背景分支
    expect(plan.inputs).toHaveLength(1)
    expect(plan.inputs[0].url).toBe(SOURCE.url)
    expect(plan.graph).not.toContain('[1:v]')
    expect(plan.graph).toContain('color=c=0x000000')
    // 两段仍然各占一个时间片段，用 concat 拼回来
    expect(plan.graph).toContain('concat=n=2:v=1:a=0[outv]')
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

/**
 * 无音轨素材 / 叠加图片的导出正确性。
 *
 * 这两类素材最容易被「乐观假设有音轨」的代码坑到：`[n:a]` 指向不存在的流时
 * FFmpeg 直接退 1，而无声重试以前只关掉主轨音频，叠加轨/音频轨的分支原样再来一遍
 * —— 于是重试也失败，用户看到的是「导出永远失败」。
 */
describe('无音轨素材与叠加图片', () => {
  const IMAGE: SourceInfo = {
    url: 'blob:logo',
    name: 'logo.png',
    size: 1024,
    duration: 3,
    width: 800,
    height: 600,
    kind: 'image',
  }

  /** 主轨视频 + 一条音频轨（用来验证「无声重试必须连音频轨一起关掉」）。 */
  function projectWithAudioTrack(): Project {
    const base = createInitialProject({ url: SOURCE.url, duration: 10 }, 'main')
    return {
      ...base,
      audioTracks: [
        {
          id: 'at',
          name: '配音',
          muted: false,
          hidden: false,
          enabled: true,
          locked: false,
          solo: false,
          volume: 1,
          clips: [
            {
              id: 'ac',
              sourceUrl: SOURCE.url,
              sourceStart: 0,
              sourceEnd: 4,
              start: 0,
              volume: 1,
              fadeIn: 0,
              fadeOut: 0,
            },
          ],
        },
      ],
    }
  }

  it('无声导出（hasAudio=false）不生成任何音频分支，包括音频轨', () => {
    const project = projectWithAudioTrack()
    const withAudio = buildExportPlan(project, [SOURCE], true)
    expect(withAudio.hasAudio).toBe(true)
    expect(withAudio.graph).toContain('[0:a]')

    const silent = buildExportPlan(project, [SOURCE], false)
    expect(silent.hasAudio).toBe(false)
    expect(silent.audioLabel).toBeNull()
    // 关键：音频轨的 filters 也不能出现（否则重试仍会因缺流失败）
    expect(silent.graph).not.toContain('[0:a]')
    expect(silent.graph).not.toContain('atrim=start=0')
    expect(silent.graph).not.toContain('amix')
  })

  it('叠加轨里的图片素材带 kind=image，args 里才会加 -loop 1', () => {
    const base = createInitialProject({ url: SOURCE.url, duration: 10 }, 'main')
    const withOverlay: Project = {
      ...base,
      overlayTracks: [
        {
          id: 'ov',
          name: '叠加 1',
          muted: false,
          hidden: false,
          enabled: true,
          locked: false,
          solo: false,
          clips: [createClip(IMAGE.url, 0, 3, { type: 'image' }, 'logo-clip')],
        },
      ],
    }
    const plan = buildExportPlan(withOverlay, [SOURCE, IMAGE], true)
    const imageInput = plan.inputs.find((input) => input.url === IMAGE.url)
    expect(imageInput, '叠加图片必须注册成一路输入').toBeTruthy()
    expect(imageInput?.kind).toBe('image')

    const args = buildExportArgs(plan, 'graph.txt', 'out.mp4')
    const imageAt = args.indexOf(imageInput!.file)
    expect(imageAt).toBeGreaterThan(0)
    // -loop 1 紧贴在它自己的 -i 之前（逐输入参数，不能靠复用主轨输入继承）
    expect(args.slice(Math.max(0, imageAt - 6), imageAt)).toContain('-loop')
  })

  it('叠加轨里的图片不会被当成音频源去生成 [n:a]', () => {
    const base = createInitialProject({ url: SOURCE.url, duration: 10 }, 'main')
    const withOverlay: Project = {
      ...base,
      overlayTracks: [
        {
          id: 'ov',
          name: '叠加 1',
          muted: false,
          hidden: false,
          enabled: true,
          locked: false,
          solo: false,
          clips: [createClip(IMAGE.url, 0, 3, { type: 'image' }, 'logo-clip')],
        },
      ],
    }
    const plan = buildExportPlan(withOverlay, [SOURCE, IMAGE], true)
    const imageIndex = plan.inputs.findIndex((input) => input.url === IMAGE.url)
    expect(imageIndex).toBeGreaterThanOrEqual(0)
    // 图片那一路的输入不允许出现在任何 [n:a] 引用里
    expect(plan.graph).not.toContain(`[${imageIndex}:a]`)
  })
})

/**
 * 尾部超长：字幕/文字可能被拖到视频结束之后。
 * 预览能播到字幕，成片以前却在视频末尾就停（尾字幕整段丢失）。
 */
describe('字幕超出视频末尾时的成片总长', () => {
  function projectWithTailCaption(): Project {
    const base = createInitialProject({ url: SOURCE.url, duration: 4 }, 'main')
    let project = addTextTrackToProject(base, 'cap', 'caption')
    project = addTextClipToProject(project, 'cap', {
      id: 'tail',
      text: '片尾字幕',
      start: 4,
      end: 7,
      x: 0.5,
      y: 0.86,
      fontSize: 0.05,
      color: '#fff',
      background: 'transparent',
      align: 'center',
      bold: false,
    })!
    return project
  }

  it('totalDuration 覆盖字幕末尾，且视频补黑场到该长度', () => {
    const project = projectWithTailCaption()
    const plan = buildExportPlan(project, [SOURCE], true)
    expect(plan.totalDuration).toBeCloseTo(7, 3)
    // 视频只有 4s，必须补 3s 黑场，否则 -t 7 会把成片截在 4s
    expect(plan.graph).toContain('tpad=stop_mode=add:stop_duration=3')
    expect(plan.videoLabel).toBe('outvpad')
    // -t 用工程总长
    const args = buildExportArgs(plan, 'graph.txt', 'out.mp4')
    const t = args.indexOf('-t')
    expect(t).toBeGreaterThanOrEqual(0)
    expect(Number(args[t + 1])).toBeCloseTo(7, 3)
  })
})

/**
 * 空隙 + 转场：以前的 gapped 路径无条件 concat，导致「只要有一处空隙，
 * 所有转场都变硬切」——预览有淡入淡出、成片全是切。
 */
describe('空隙与转场共存', () => {
  it('gapped 路径仍然生成 xfade，而不是全部硬切', () => {
    const base = createInitialProject({ url: SOURCE.url, duration: 10 }, 'c1')
    const project: Project = {
      ...base,
      clips: [
        { ...createClip(SOURCE.url, 0, 3, {}, 'c1'), transitionOut: { type: 'fade', duration: 0.6 } },
        // 第二段前面留 1s 空隙 → 触发 gapped 路径
        { ...createClip(SOURCE.url, 3, 6, { gapBefore: 1 }, 'c2'), transitionOut: { type: 'fade', duration: 0.5 } },
        createClip(SOURCE.url, 6, 9, {}, 'c3'),
      ],
    }
    const plan = buildExportPlan(project, [SOURCE], true)
    expect(plan.graph).toContain('xfade=transition=fade')
    // 空隙本身仍是硬切（gap 单元与相邻片段之间不叠化）
    expect(plan.graph).toContain('concat=n=2:v=1:a=0')
  })
})
