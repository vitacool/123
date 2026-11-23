import { describe, expect, it } from 'vitest'
import { addAudioClipToProject, addAudioTrackToProject } from '../src/editor/core/audio'
import {
  EXPORT_RANGE_MIN_DURATION,
  clampExportRange,
  exportRangeDuration,
} from '../src/editor/core/exportRange'
import {
  applyExportRangeTrim,
  buildAudioExportArgs,
  buildAudioExportPlan,
  buildExportArgs,
  buildExportPlan,
} from '../src/editor/core/exportPlan'
import { normalizeDraftExportRange } from '../src/editor/core/draft'
import {
  addOverlayTrackFromClip,
  createClip,
  createInitialProject,
} from '../src/editor/core/operations'
import { getProjectEnd } from '../src/editor/core/timeline'
import { applyCoverOverlayGraph } from '../src/editor/services/ffmpegExporter'
import { restoreDraft, toDraftSnapshot } from '../src/editor/services/draftStore'
import type { AudioClip, Project, SourceInfo } from '../src/editor/core/types'

const SOURCE: SourceInfo = {
  url: 'blob:range-source',
  name: 'range.mp4',
  size: 8_000_000,
  duration: 10,
  width: 1920,
  height: 1080,
  kind: 'video',
  hasAudio: true,
}

const IMAGE: SourceInfo = {
  url: 'blob:range-image',
  name: 'range.png',
  size: 200_000,
  duration: 10,
  width: 1920,
  height: 1080,
  kind: 'image',
}

function videoProject(duration = 10): Project {
  return {
    ...createInitialProject({ url: SOURCE.url, duration }, 'clip-a'),
    aspectRatio: '16:9',
    exportQuality: { resolution: '480p', fps: 30 },
  }
}

/** 两段 5 秒片段 + 1 秒淡入淡出转场：总时长 9 秒。 */
function transitionProject(): Project {
  const base = videoProject()
  return {
    ...base,
    clips: [
      createClip(SOURCE.url, 0, 5, { transitionOut: { type: 'fade', duration: 1 } }, 'clip-a'),
      createClip(SOURCE.url, 5, 10, {}, 'clip-b'),
    ],
  }
}

/** 主轨 10 秒 + 一段 3 秒叠加轨（起点 2 秒）。 */
function overlayProject(): Project {
  const base = createInitialProject({ url: SOURCE.url, duration: 10 }, 'clip-a')
  const overlay = addOverlayTrackFromClip(base, 'clip-a', 'track-over', 'overlay-a')!.project
  return {
    ...overlay,
    aspectRatio: '16:9',
    exportQuality: { resolution: '480p', fps: 30 },
    overlayTracks: overlay.overlayTracks!.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => ({ ...clip, sourceEnd: 3, gapBefore: 2 })),
    })),
  }
}

/** 只有音频轨的工程（主轨空）。 */
function audioOnlyProject(): Project {
  const clip: AudioClip = {
    id: 'audio-a',
    sourceUrl: SOURCE.url,
    sourceStart: 0,
    sourceEnd: 3,
    start: 0,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
  }
  const withTrack = addAudioTrackToProject({ ...videoProject(), clips: [] }, 'track-a').project
  return addAudioClipToProject(withTrack, 'track-a', clip)!
}

describe('导出区间夹取（core/exportRange）', () => {
  it('缺省 / 非法值按「未设置」处理', () => {
    expect(clampExportRange(null, 10)).toBeNull()
    expect(clampExportRange(undefined, 10)).toBeNull()
    expect(clampExportRange({ start: Number.NaN, end: 4 }, 10)).toBeNull()
    expect(clampExportRange({ start: 1, end: Number.POSITIVE_INFINITY }, 10)).toBeNull()
  })

  it('越界区间夹回 [0, 工程时长]', () => {
    expect(clampExportRange({ start: -3, end: 4 }, 10)).toEqual({ start: 0, end: 4 })
    expect(clampExportRange({ start: 6, end: 30 }, 10)).toEqual({ start: 6, end: 10 })
    expect(clampExportRange({ start: 8, end: 30 }, 10)).toEqual({ start: 8, end: 10 })
  })

  it('长度小于 0.1 秒视为无效，等于 0.1 秒仍然有效', () => {
    expect(clampExportRange({ start: 5, end: 5.099 }, 10)).toBeNull()
    expect(clampExportRange({ start: 5, end: 5 + EXPORT_RANGE_MIN_DURATION }, 10)).toEqual({
      start: 5,
      end: 5 + EXPORT_RANGE_MIN_DURATION,
    })
  })

  it('起点在终点之后视为无效', () => {
    expect(clampExportRange({ start: 6, end: 4 }, 10)).toBeNull()
  })

  it('已在有效范围内时保持对象引用不变', () => {
    const range = { start: 2, end: 6 }
    expect(clampExportRange(range, 10)).toBe(range)
  })

  it('区间时长保留 4 位小数，负长度按 0 处理', () => {
    expect(exportRangeDuration({ start: 1.25, end: 6 })).toBe(4.75)
    expect(exportRangeDuration({ start: 6, end: 1 })).toBe(0)
    expect(exportRangeDuration({ start: Number.NaN, end: 2 })).toBe(0)
  })

  it('草稿归一化入口：缺省为 null，越界夹取', () => {
    expect(normalizeDraftExportRange(undefined, 10)).toBeNull()
    expect(normalizeDraftExportRange({ start: 2, end: 4 }, 10)).toEqual({ start: 2, end: 4 })
    expect(normalizeDraftExportRange({ start: 8, end: 20 }, 10)).toEqual({ start: 8, end: 10 })
  })
})

describe('导出计划上的区间', () => {
  it('把 totalDuration 换成区间时长，完整时长留在 fullDuration', () => {
    const plan = buildExportPlan(videoProject(), SOURCE, true, { range: { start: 2, end: 6 } })
    expect(plan.exportRange).toEqual({ start: 2, end: 6 })
    expect(plan.totalDuration).toBe(4)
    expect(plan.fullDuration).toBe(10)
  })

  it('区间把音频 atrim 放进 plan（好让响度按区间测量），视频 trim 仍由 applyExportRangeTrim 追加到最终标签', () => {
    const plan = buildExportPlan(videoProject(), SOURCE, true, { range: { start: 2, end: 6 } })
    // 音频在构建 plan 时就裁好了（见 withExportRange）。
    expect(plan.audioLabel).toBe('outa_range')
    expect(plan.graph).toContain('[outa]atrim=start=2:end=6,asetpts=PTS-STARTPTS[outa_range]')
    // 视频仍要等文字/封面层合成之后裁。
    const trimmed = applyExportRangeTrim(plan)
    expect(trimmed.videoLabel).toBe('outv_range')
    expect(trimmed.audioLabel).toBe('outa_range')
    const lines = trimmed.graph.split('\n')
    expect(lines.at(-1)).toBe('[outv]trim=start=2:end=6,setpts=PTS-STARTPTS[outv_range]')
    // 区间裁剪只追加视频那一条，不改变既有部分。
    expect(trimmed.graph.startsWith(plan.graph)).toBe(true)
  })

  it('args 的 -t 等于区间时长，并 map 到裁剪后的标签', () => {
    const plan = buildExportPlan(videoProject(), SOURCE, true, { range: { start: 2, end: 6 } })
    const trimmed = applyExportRangeTrim(plan)
    const args = buildExportArgs(trimmed, 'graph.txt', 'out.mp4')
    expect(args[args.lastIndexOf('-t') + 1]).toBe('4')
    expect(args).toContain('[outv_range]')
    expect(args).toContain('[outa_range]')
    expect(args).not.toContain('[outv]')
  })

  it('区间超出工程时长时先夹取，再据此计算时长', () => {
    const plan = buildExportPlan(videoProject(), SOURCE, true, { range: { start: 8, end: 30 } })
    expect(plan.exportRange).toEqual({ start: 8, end: 10 })
    expect(plan.totalDuration).toBe(2)
    expect(plan.fullDuration).toBe(10)
  })

  it('过短 / 非法区间视为未设置，计划与不传区间时完全一致', () => {
    const plain = buildExportPlan(videoProject(), SOURCE, true)
    const short = buildExportPlan(videoProject(), SOURCE, true, { range: { start: 5, end: 5.05 } })
    expect(short).toEqual(plain)
    expect(short.fullDuration).toBeUndefined()
    expect(short.exportRange).toBeUndefined()
  })

  it('不选区间时 graph 与 args 逐字不变', () => {
    const plain = buildExportPlan(videoProject(), SOURCE, true)
    const explicit = buildExportPlan(videoProject(), SOURCE, true, { range: null })
    expect(explicit).toEqual(plain)
    expect(explicit.graph).toBe(plain.graph)
    expect(buildExportArgs(explicit, 'g.txt', 'o.mp4')).toEqual(
      buildExportArgs(plain, 'g.txt', 'o.mp4'),
    )
    // trim 只在有区间时才追加。
    expect(applyExportRangeTrim(explicit).graph).toBe(plain.graph)
    expect(applyExportRangeTrim(explicit).videoLabel).toBe('outv')
  })

  it('转场工程的 trim 追加在 xfade 之后', () => {
    const project = transitionProject()
    expect(getProjectEnd(project)).toBe(9)
    const plan = buildExportPlan(project, SOURCE, true, { range: { start: 3, end: 7 } })
    expect(plan.totalDuration).toBe(4)
    const trimmed = applyExportRangeTrim(plan)
    expect(trimmed.graph).toContain('xfade=transition=fade')
    expect(trimmed.graph.indexOf('xfade')).toBeLessThan(
      trimmed.graph.lastIndexOf('[outv]trim=start=3:end=7'),
    )
  })

  it('叠加轨工程的 trim 追加在 overlay 之后，叠加层不受影响', () => {
    const plan = buildExportPlan(overlayProject(), SOURCE, true, { range: { start: 1, end: 5 } })
    expect(plan.usesOverlaySource).toBe(true)
    expect(plan.totalDuration).toBe(4)
    const trimmed = applyExportRangeTrim(plan)
    expect(trimmed.graph.indexOf('overlay=0:0')).toBeLessThan(
      trimmed.graph.lastIndexOf('[outv]trim=start=1:end=5'),
    )
    expect(trimmed.usesOverlaySource).toBe(true)
  })

  it('同时开启区间与响度：先 atrim 再 loudnorm（按导出段测响度），且 loudnorm 只出现一次', () => {
    const project: Project = {
      ...videoProject(),
      exportQuality: { ...videoProject().exportQuality, loudness: 'platform' },
    }
    const plan = buildExportPlan(project, SOURCE, true, { range: { start: 1, end: 4 } })
    // 裁音频 → 再标准化，标签依次改名。
    expect(plan.audioLabel).toBe('outa_range_norm')
    const atrimAt = plan.graph.indexOf('atrim=start=1')
    const loudnormAt = plan.graph.indexOf('loudnorm')
    expect(atrimAt).toBeGreaterThanOrEqual(0)
    expect(loudnormAt).toBeGreaterThan(atrimAt)
    expect(plan.graph.match(/loudnorm/g) ?? []).toHaveLength(1)
    // loudnorm 的输入就是裁好的标签。
    expect(plan.graph).toContain('[outa_range]loudnorm=')
    expect(plan.graph).toContain('[outa]atrim=start=1:end=4,asetpts=PTS-STARTPTS[outa_range]')
    // 视频 trim 仍然在最后追加，且不影响音频标签。
    const trimmed = applyExportRangeTrim(plan)
    expect(trimmed.audioLabel).toBe('outa_range_norm')
    expect(trimmed.graph.indexOf('loudnorm')).toBeLessThan(trimmed.graph.indexOf('[outv]trim='))
  })

  it('静帧输入的循环时长仍取完整时长，输出 -t 取区间时长', () => {
    const base = createInitialProject({ url: IMAGE.url, duration: 10 }, 'clip-image', 'image')
    const project: Project = {
      ...base,
      aspectRatio: '16:9',
      exportQuality: { resolution: '480p', fps: 30 },
      clips: [{ ...base.clips[0], sourceEnd: 10 }],
    }
    const plan = buildExportPlan(project, IMAGE, false, { range: { start: 2, end: 6 } })
    const trimmed = applyExportRangeTrim(plan)
    const args = buildExportArgs(trimmed, 'g.txt', 'out.mp4')
    // 静帧循环输入覆盖完整 10 秒，否则区间后半段取不到帧。
    expect(args[args.indexOf('-loop') + 1]).toBe('1')
    expect(args[args.indexOf('-t') + 1]).toBe('10')
    // 输出 -t 是区间时长。
    expect(args[args.lastIndexOf('-t') + 1]).toBe('4')
  })
})

describe('区间导出：纯音频计划', () => {
  it('只裁音频标签，不追加不存在的 [outv]', () => {
    const plan = buildAudioExportPlan(audioOnlyProject(), SOURCE, true, {
      range: { start: 1, end: 3 },
    })
    expect(plan.totalDuration).toBe(2)
    expect(plan.fullDuration).toBe(3)
    const trimmed = applyExportRangeTrim(plan)
    expect(trimmed.graph).not.toContain('[outv]')
    expect(trimmed.audioLabel).toBe('outa_range')
    expect(trimmed.graph.endsWith('[outa]atrim=start=1:end=3,asetpts=PTS-STARTPTS[outa_range]')).toBe(
      true,
    )
    const args = buildAudioExportArgs(trimmed, 'g.txt', 'out.m4a', 'm4a')
    expect(args[args.indexOf('-t') + 1]).toBe('2')
    expect(args).toContain('[outa_range]')
    expect(args).not.toContain('[outv_range]')
  })

  it('不传区间时音频计划保持原标签与时长', () => {
    const plain = buildAudioExportPlan(audioOnlyProject(), SOURCE, true)
    const explicit = buildAudioExportPlan(audioOnlyProject(), SOURCE, true, { range: null })
    expect(explicit).toEqual(plain)
    expect(applyExportRangeTrim(explicit).audioLabel).toBe(plain.audioLabel)
    expect(applyExportRangeTrim(explicit).graph).toBe(plain.graph)
  })
})

describe('草稿里的导出区间', () => {
  const REMOTE = 'https://cdn.example.com/range.mp4'

  function remoteProject(): Project {
    return {
      ...createInitialProject({ url: REMOTE, duration: 10 }, 'clip-a'),
      aspectRatio: '16:9',
      exportQuality: { resolution: '480p', fps: 30 },
    }
  }

  function snapshot(exportRange?: { start: number; end: number } | null) {
    return {
      version: 1 as const,
      project: remoteProject(),
      assets: [
        {
          id: 'asset-a',
          url: REMOTE,
          name: 'range.mp4',
          size: 8_000_000,
          duration: 10,
          width: 1920,
          height: 1080,
          kind: 'video' as const,
        },
      ],
      sourceUrl: REMOTE,
      timelineZoom: 92,
      timelineSettings: {
        mainTrackMagnet: true,
        autoSnap: true,
        linkage: true,
        previewAxis: true,
        captionFollow: true,
        ...(exportRange === undefined ? {} : { exportRange }),
      },
      playhead: 2,
      updatedAt: 1,
    }
  }

  it('旧草稿没有 exportRange 时按 null 处理', async () => {
    const restored = await restoreDraft(snapshot())
    expect(restored).not.toBeNull()
    expect(restored!.timelineSettings.exportRange).toBeNull()
  })

  it('读取草稿时按工程时长夹取区间', async () => {
    const restored = await restoreDraft(snapshot({ start: 8, end: 30 }))
    expect(restored!.timelineSettings.exportRange).toEqual({ start: 8, end: 10 })
    const gone = await restoreDraft(snapshot({ start: 9, end: 9.05 }))
    expect(gone!.timelineSettings.exportRange).toBeNull()
  })

  it('保存草稿时把 exportRange 写进 timelineSettings', () => {
    const state = {
      project: remoteProject(),
      assets: [
        {
          id: 'asset-a',
          url: REMOTE,
          name: 'range.mp4',
          size: 8_000_000,
          duration: 10,
          width: 1920,
          height: 1080,
          kind: 'video' as const,
        },
      ],
      source: { url: REMOTE },
      timelineZoom: 92,
      timelineSettings: {
        mainTrackMagnet: true,
        autoSnap: true,
        linkage: true,
        previewAxis: true,
      },
      captionFollow: true,
      exportRange: { start: 2, end: 6 },
      playhead: 3,
    }
    const draft = toDraftSnapshot(state)
    expect(draft.timelineSettings.exportRange).toEqual({ start: 2, end: 6 })
  })
})
describe('区间 + 首帧封面（A2）', () => {
  it('封面在 trim 之后合成，因此覆盖的是导出段的第一帧', () => {
    const plan = buildExportPlan(videoProject(), SOURCE, true, { range: { start: 3, end: 8 } })
    const trimmed = applyExportRangeTrim(plan)
    // exporter 的真实调用顺序：trim → 封面 overlay。
    applyCoverOverlayGraph(trimmed, 9)
    const lines = trimmed.graph.split('\n')
    const overlayLine = lines[lines.length - 1]
    // 封面 overlay 消费的是 trim 之后的标签（而不是完整时间轴的 [outv]）。
    expect(overlayLine).toContain('[outv_range_coverbase][coverpng]overlay=0:0')
    expect(overlayLine).toContain("[outv_range]")
    // 窗口从 0 起算：trim 之后 t=0 即导出段的第一帧。
    expect(overlayLine).toContain("enable='between(t,0,")
    // trim 行在 overlay 之前，且输出标签被改名给 overlay 消费。
    const trimLine = lines.find((line) => line.includes('[outv]trim=start=3:end=8'))!
    expect(trimLine).toContain('[outv_range_coverbase]')
    expect(trimmed.graph.indexOf(trimLine)).toBeLessThan(trimmed.graph.indexOf(overlayLine))
  })

  it('没有区间时封面仍然覆盖第一帧且输出与原来一致', () => {
    const plan = buildExportPlan(videoProject(), SOURCE, true)
    const untouched = applyExportRangeTrim(plan)
    expect(untouched).toBe(plan)
    applyCoverOverlayGraph(untouched, 9)
    expect(untouched.graph).toContain('[outv_coverbase][coverpng]overlay=0:0')
    expect(untouched.graph).toContain("enable='between(t,0,")
  })
})
