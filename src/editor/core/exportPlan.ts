import { getOutputDimensions } from './aspect'
import { clipFadeIn, clipFadeOut, clipVolume } from './clipAudio'
import {
  backgroundBlurPx,
  backgroundFfmpegColor,
  clipBackground,
  needsBackgroundLayer,
} from './background'
import { clipBlendMode, clipOpacity, ffmpegBlendMode, opacityFilters } from './blend'
import { normalizeTransitionType, resolveTransitionDuration } from './transition'
import { clipFreezeFrame, clipTimelineDuration } from './clipTime'
import { clipKeepsPitch, clipSpeedValue, speedAudioFilters, speedVideoFilter } from './speed'
import { audioClipDuration, audioProjectEnd } from './audio'
import {
  isAudioTrackActive,
  isMainAudioActive,
  isMainVideoVisible,
  isOverlayAudioActive,
  isOverlayVideoVisible,
} from './tracks'
import { getOverlayTracks, getProjectEnd, getProjectDuration, getTimeline } from './timeline'
import { computeClipGeometry } from './geometry'
import type { CanvasBackground, Clip, Project, SourceInfo } from './types'

/** One FFmpeg `-i` input, resolved from a project asset. */
export interface ExportInput {
  /** Asset URL; matches `Clip.sourceUrl`. */
  url: string
  /** File name inside the FFmpeg virtual file system. */
  file: string
  width: number
  height: number
  duration: number
  hasAudio: boolean
  /** Defaults to video for backwards compatibility. */
  kind?: 'video' | 'audio' | 'image'
}

export interface ExportPlan {
  width: number
  height: number
  fps: number
  totalDuration: number
  hasAudio: boolean
  graph: string
  videoLabel: string
  audioLabel: string | null
  crf: number
  /** FFmpeg inputs, in `-i` order. */
  inputs: ExportInput[]
  /** True when overlay tracks need their own copies of their source inputs. */
  usesOverlaySource?: boolean
}

const num = (value: number): string => {
  if (!Number.isFinite(value)) return '0'
  const rounded = Math.round(value * 10000) / 10000
  return String(rounded)
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const qualityCrf = (resolution: Project['exportQuality']['resolution']): number => {
  switch (resolution) {
    case '480p':
      return 23
    case '720p':
      return 22
    case '1080p':
      return 21
    case '4K':
      return 20
  }
}

function extensionFor(source: SourceInfo): string {
  const name = (source.name || source.url || '').split('?')[0]
  const match = /\.([a-zA-Z0-9]{1,5})$/.exec(name)
  return match ? `.${match[1].toLowerCase()}` : '.mp4'
}

function normalizeSources(sourceOrSources: SourceInfo | SourceInfo[]): SourceInfo[] {
  const list = (Array.isArray(sourceOrSources) ? sourceOrSources : [sourceOrSources]).filter(
    (source): source is SourceInfo => Boolean(source && source.url),
  )
  const unique: SourceInfo[] = []
  const seen = new Set<string>()
  for (const source of list) {
    if (seen.has(source.url)) continue
    seen.add(source.url)
    unique.push(source)
  }
  if (unique.length === 0) throw new Error('缺少导出素材，无法构建导出计划。')
  return unique
}

function createResolver(sources: SourceInfo[]): (clip: Clip) => SourceInfo {
  const byUrl = new Map(sources.map((source) => [source.url, source]))
  const fallback = sources[0]
  return (clip) => byUrl.get(clip.sourceUrl) ?? fallback
}

interface InputRegistry {
  inputs: ExportInput[]
  indexByUrl: Map<string, number>
}

function createRegistry(): InputRegistry {
  return { inputs: [], indexByUrl: new Map() }
}

function registerInput(
  registry: InputRegistry,
  source: SourceInfo,
  assumeAudio: boolean,
): number {
  const existing = registry.indexByUrl.get(source.url)
  if (existing !== undefined) return existing
  const index = registry.inputs.length
  registry.inputs.push({
    url: source.url,
    file: `input${index}${extensionFor(source)}`,
    width: source.width,
    height: source.height,
    duration: source.duration,
    hasAudio: assumeAudio && source.hasAudio !== false,
    kind: source.kind === 'audio' ? 'audio' : source.kind === 'image' ? 'image' : 'video',
  })
  registry.indexByUrl.set(source.url, index)
  return index
}

/** Group original indexes by the input they belong to, preserving order. */
function groupIndexes(values: number[]): Map<number, number[]> {
  const groups = new Map<number, number[]>()
  values.forEach((value, index) => {
    const list = groups.get(value)
    if (list) list.push(index)
    else groups.set(value, [index])
  })
  return groups
}

/**
 * Emit one `split` per input that feeds more than one branch. Single-use
 * streams are addressed directly, so the graph stays compact.
 */
function splitBranches(
  lines: string[],
  groups: Map<number, number[]>,
  stream: 'v' | 'a',
  prefix: string,
): Map<number, string> {
  const branches = new Map<number, string>()
  for (const [input, indexes] of groups) {
    if (indexes.length === 1) {
      branches.set(indexes[0], `[${input}:${stream}]`)
      continue
    }
    const pads = indexes.map((_, offset) => `[${prefix}${input}_${offset}]`)
    lines.push(
      `[${input}:${stream}]${stream === 'v' ? 'split' : 'asplit'}=${indexes.length}${pads.join('')}`,
    )
    indexes.forEach((branchIndex, offset) => {
      branches.set(branchIndex, `[${prefix}${input}_${offset}]`)
    })
  }
  return branches
}

function videoTemporalChain(clip: Clip, sourceDuration: number, fps: number): string {
  const duration = clamp(clipTimelineDuration(clip), 0.02, 60 * 60)
  if (clip.type === 'image') {
    // 静帧输入（-loop 1）已经是重复的帧流，只需对齐帧率并按片段时长裁剪。
    return [
      `fps=${fps}`,
      `trim=duration=${num(duration)}`,
      'setpts=PTS-STARTPTS',
    ].join(',')
  }
  if (clip.type === 'freeze') {
    const rawFrame = clipFreezeFrame(clip)
    const frame = clamp(rawFrame, 0, Math.max(0, sourceDuration - 0.05))
    const end = Math.min(sourceDuration, frame + 0.6)
    return [
      `trim=start=${num(frame)}:end=${num(end)}`,
      'setpts=PTS-STARTPTS',
      'select=eq(n\\,0)',
      `fps=${fps}`,
      `tpad=stop_mode=clone:stop_duration=${num(duration)}`,
      `trim=duration=${num(duration)}`,
      'setpts=PTS-STARTPTS',
    ].join(',')
  }
  const speedFilter = speedVideoFilter(clip.speed ?? 1)
  return [
    `trim=start=${num(clip.sourceStart)}:end=${num(clip.sourceEnd)}`,
    'setpts=PTS-STARTPTS',
    ...(speedFilter ? [speedFilter] : []),
    `fps=${fps}`,
    `trim=duration=${num(duration)}`,
    'setpts=PTS-STARTPTS',
  ].join(',')
}

function videoTransformChain(
  clip: Clip,
  width: number,
  height: number,
  source: SourceInfo,
  background: CanvasBackground = { type: 'black' },
): string | null {
  const geometry = computeClipGeometry(clip, source, width, height)
  const { source: crop, rendered, visible } = geometry
  const parts: string[] = [`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`]
  if (clip.flipH) parts.push('hflip')
  if (clip.flipV) parts.push('vflip')
  if (Math.abs(clip.rotation) > 0.001) {
    parts.push(
      `rotate=${num((clip.rotation * Math.PI) / 180)}:ow=${geometry.rotated.w}:oh=${geometry.rotated.h}:c=black`,
    )
  }
  parts.push(`scale=${rendered.w}:${rendered.h}:flags=lanczos`)

  if (visible.w < 2 || visible.h < 2) return null

  parts.push(
    'format=rgba',
    `crop=${Math.round(visible.w)}:${Math.round(visible.h)}:${Math.round(visible.x)}:${Math.round(visible.y)}`,
  )
  if (needsBackgroundLayer(background)) {
    // 模糊/图片背景：先留透明，由调用方在下面垫背景层再合成。
    parts.push(
      `pad=${width}:${height}:${Math.round(rendered.x + visible.x)}:${Math.round(rendered.y + visible.y)}:color=0x00000000`,
      'format=yuva420p',
      'setsar=1',
    )
  } else {
    parts.push(
      // 黑场保持历史的 `black` 字面量，避免改变已有工程的滤镜图。
      `pad=${width}:${height}:${Math.round(rendered.x + visible.x)}:${Math.round(rendered.y + visible.y)}:${
        background.type === 'black' ? 'black' : backgroundFfmpegColor(background)
      }`,
      'format=yuv420p',
      'setsar=1',
    )
  }
  return parts.join(',')
}

/** 模糊背景层：取片段自身画面放大到铺满画布并高斯模糊。 */
function blurBackgroundChain(width: number, height: number, blurAmount: number): string {
  const sigma = Math.max(1, Math.min(50, blurAmount / 2))
  return [
    `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${width}:${height}`,
    `gblur=sigma=${num(sigma)}`,
    'format=yuv420p',
    'setsar=1',
  ].join(',')
}

/** Overlay variant: preserve alpha outside the picture-in-picture rectangle. */
function overlayTransformChain(
  clip: Clip,
  width: number,
  height: number,
  source: SourceInfo,
): string | null {
  const geometry = computeClipGeometry(clip, source, width, height)
  const { source: crop, rendered, visible } = geometry
  if (visible.w < 2 || visible.h < 2) return null
  const parts: string[] = [`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`]
  if (clip.flipH) parts.push('hflip')
  if (clip.flipV) parts.push('vflip')
  parts.push('format=rgba')
  if (Math.abs(clip.rotation) > 0.001) {
    parts.push(
      `rotate=${num((clip.rotation * Math.PI) / 180)}:ow=${geometry.rotated.w}:oh=${geometry.rotated.h}:c=black@0`,
    )
  }
  parts.push(
    `scale=${rendered.w}:${rendered.h}:flags=lanczos`,
    'format=rgba',
    `crop=${Math.round(visible.w)}:${Math.round(visible.h)}:${Math.round(visible.x)}:${Math.round(visible.y)}`,
    `pad=${width}:${height}:${Math.round(rendered.x + visible.x)}:${Math.round(rendered.y + visible.y)}:color=0x00000000`,
    'format=rgba',
    'setsar=1',
    // 不透明度：带 alpha 的 yuva420p + colorchannelmixer 整体缩放 alpha。
    ...opacityFilters(clipOpacity(clip)),
  )
  return parts.join(',')
}

function audioChain(clip: Clip, sourceLabel: string | null): string {
  const duration = clamp(clipTimelineDuration(clip), 0.02, 60 * 60)
  if (clip.type === 'freeze' || clip.type === 'image' || sourceLabel === null) {
    return [
      'anullsrc=r=48000:cl=stereo',
      `atrim=duration=${num(duration)}`,
      'asetpts=PTS-STARTPTS',
      'aresample=48000',
      'aformat=sample_fmts=fltp:channel_layouts=stereo',
    ].join(',')
  }
  const gain = clipVolume(clip)
  const fadeIn = clipFadeIn(clip)
  const fadeOut = clipFadeOut(clip)
  // 变速：保持音调用 atempo 链（每级 0.5–2），否则用 asetrate+aresample。
  const speedFilters = speedAudioFilters(clipSpeedValue(clip), clipKeepsPitch(clip))
  const parts = [
    `${sourceLabel}atrim=start=${num(clip.sourceStart)}:end=${num(clip.sourceEnd)}`,
    'asetpts=PTS-STARTPTS',
    ...speedFilters,
  ]
  // 片段增益与淡入淡出：与预览共用同一套包络（clipGainAt）。
  if (gain !== 1) parts.push(`volume=${num(gain)}`)
  if (fadeIn > 0.001) parts.push(`afade=t=in:st=0:d=${num(fadeIn)}`)
  if (fadeOut > 0.001) {
    parts.push(`afade=t=out:st=${num(Math.max(0, duration - fadeOut))}:d=${num(fadeOut)}`)
  }
  parts.push(
    'aresample=48000',
    'aformat=sample_fmts=fltp:channel_layouts=stereo',
    `apad=whole_dur=${num(duration)}`,
    `atrim=duration=${num(duration)}`,
    'asetpts=PTS-STARTPTS',
  )
  return parts.join(',')
}

/**
 * Builds the complete FFmpeg filter graph. Every clip branch reads from the
 * input that matches its `sourceUrl`; inputs that feed several branches are
 * split once. Passing a single `SourceInfo` keeps the legacy single-source
 * behaviour and maps every clip to input 0.
 */
export function buildExportPlan(
  project: Project,
  sourceOrSources: SourceInfo | SourceInfo[],
  sourceHasAudio: boolean,
): ExportPlan {
  const sources = normalizeSources(sourceOrSources)
  const mainAudio = sourceHasAudio && isMainAudioActive(project)
  const plan = buildExportPlanWithoutAudio(project, sources, mainAudio)
  return applyAudioTracks(project, sources, plan)
}

function buildExportPlanWithoutAudio(
  project: Project,
  sources: SourceInfo[],
  sourceHasAudio: boolean,
): ExportPlan {
  if (getOverlayTracks(project).some((track) => isOverlayVideoVisible(track) && track.clips.length > 0)) {
    return buildOverlayExportPlan(project, sources, sourceHasAudio)
  }
  return buildFlatExportPlan(project, sources, sourceHasAudio)
}

function buildFlatExportPlan(
  project: Project,
  sources: SourceInfo[],
  sourceHasAudio: boolean,
): ExportPlan {
  if (project.clips.length === 0) throw new Error('时间轴为空，无法导出。')
  const timeline = getTimeline(project.clips)
  let previousEnd = 0
  const hasGaps = timeline.some((segment) => {
    const gap = segment.start - previousEnd
    previousEnd = segment.end
    return gap > 0.0001
  })
  if (hasGaps) return buildGappedExportPlan(project, sources, sourceHasAudio)
  return buildContiguousExportPlan(project, sources, sourceHasAudio)
}

function buildContiguousExportPlan(
  project: Project,
  sources: SourceInfo[],
  sourceHasAudio: boolean,
): ExportPlan {
  const { width, height } = getOutputDimensions(
    project.aspectRatio,
    project.exportQuality.resolution,
    sources[0],
  )
  const fps = project.exportQuality.fps
  const totalDuration = getProjectDuration(project.clips)
  const clipCount = project.clips.length
  const registry = createRegistry()
  const resolve = createResolver(sources)
  const mainVisible = isMainVideoVisible(project)
  const clipInputs = project.clips.map((clip) =>
    registerInput(registry, resolve(clip), sourceHasAudio),
  )
  const lines: string[] = []

  const videoBranches = mainVisible
    ? splitBranches(lines, groupIndexes(clipInputs), 'v', 'vsrc')
    : new Map<number, string>()

  project.clips.forEach((clip, index) => {
    const output = clipCount > 1 ? `[v${index}]` : '[outv]'
    const clipDuration = clamp(clipTimelineDuration(clip), 0.02, 3600)
    if (!mainVisible) {
      lines.push(
        `color=c=black:s=${width}x${height}:r=${fps}:d=${num(clipDuration)},format=yuv420p,setsar=1${output}`,
      )
      return
    }
    const branch = videoBranches.get(index)!
    const source = resolve(clip)
    const temporal = videoTemporalChain(clip, source.duration, fps)
    const background = clipBackground(clip, project)
    const transform = videoTransformChain(clip, width, height, source, background)

    if (transform === null) {
      // Fully off-canvas: consume the source branch, then emit a black frame.
      lines.push(`${branch}${temporal},nullsink`)
      lines.push(
        `color=c=black:s=${width}x${height}:r=${fps}:d=${num(clipDuration)},format=yuv420p,setsar=1${output}`,
      )
      return
    }

    if (needsBackgroundLayer(background) && background.type === 'blur') {
      // 模糊背景：同一路画面拆两支——一支放大铺满并高斯模糊当底，一支原样叠上去。
      lines.push(`${branch}split=2[bg0${index}][fg0${index}]`)
      lines.push(
        `[bg0${index}]${temporal},${blurBackgroundChain(width, height, backgroundBlurPx(background))}[bg${index}]`,
      )
      lines.push(`[fg0${index}]${temporal},${transform}[fg${index}]`)
      lines.push(`[bg${index}][fg${index}]overlay=0:0,format=yuv420p${output}`)
      return
    }

    lines.push(`${branch}${temporal},${transform}${output}`)
  })

  // 主轨拼接：有转场用 xfade（重叠），否则用 concat。
  // 逐对合并，避免把 concat 与 xfade 混在一起时下标/时长难算。
  const timeline = getTimeline(project.clips)
  const transitionAt = (index: number): number => {
    // 第 index 个片段与第 index+1 个之间的实际重叠时长。
    if (index + 1 >= project.clips.length) return 0
    const next = project.clips[index + 1]
    const gap = Math.max(0, next.gapBefore ?? 0)
    return resolveTransitionDuration(project.clips[index], next, gap)
  }
  // 只要有一处实际生效的转场，就用 xfade 路径重建主轨拼接。
  const hasAnyTransition = project.clips.some((_, index) => transitionAt(index) > 0)

  if (clipCount > 1) {
    if (!hasAnyTransition) {
      // 无转场：保持原来的单条 concat，行为与既有实现完全一致。
      const inputs = project.clips.map((_, index) => `[v${index}]`).join('')
      lines.push(`${inputs}concat=n=${clipCount}:v=1:a=0[outv]`)
    } else {
      let accumulator = `[v0]`
      let accumulated = timeline[0]?.duration ?? 0
      for (let index = 1; index < clipCount; index += 1) {
        const output = index === clipCount - 1 ? '[outv]' : `[vx${index}]`
        const overlap = transitionAt(index - 1)
        if (overlap > 0) {
          const type = normalizeTransitionType(project.clips[index - 1].transitionOut?.type)
          const offset = Math.max(0, accumulated - overlap)
          lines.push(
            `${accumulator}[v${index}]xfade=transition=${type}:duration=${num(overlap)}:offset=${num(offset)}${output}`,
          )
          accumulated += (timeline[index]?.duration ?? 0) - overlap
        } else {
          lines.push(`${accumulator}[v${index}]concat=n=2:v=1:a=0${output}`)
          accumulated += timeline[index]?.duration ?? 0
        }
        accumulator = output
      }
    }
  }

  const audioGroups = new Map<number, number[]>()
  project.clips.forEach((clip, index) => {
    // 静帧（图片）与定格没有声音，但仍需要一条静音音轨参与 concat，
    // 否则音视频分支数不一致，成片会提前结束或音画不同步。
    if (clip.type !== 'video') return
    const input = clipInputs[index]
    if (!registry.inputs[input].hasAudio) return
    const list = audioGroups.get(input)
    if (list) list.push(index)
    else audioGroups.set(input, [index])
  })
  // 图片（静帧）没有音轨，需要补一条静音音频，否则 concat 的音视频分支数
// 对不上。纯无声视频/定格工程保持原有「无音轨」行为。
  const hasImages = project.clips.some((clip) => clip.type === 'image')
  const hasAudio = audioGroups.size > 0 || hasImages
  let audioLabel: string | null = null
  if (hasAudio) {
    const audioBranches = splitBranches(lines, audioGroups, 'a', 'asrc')
    project.clips.forEach((clip, index) => {
      const sourceLabel = audioBranches.get(index) ?? null
      const output = clipCount > 1 ? `[a${index}]` : '[outa]'
      lines.push(`${audioChain(clip, sourceLabel)}${output}`)
    })
    if (clipCount > 1) {
      if (!hasAnyTransition) {
        const inputs = project.clips.map((_, index) => `[a${index}]`).join('')
        lines.push(`${inputs}concat=n=${clipCount}:v=0:a=1[outa]`)
      } else {
        let accumulator = `[a0]`
        for (let index = 1; index < clipCount; index += 1) {
          const output = index === clipCount - 1 ? '[outa]' : `[ax${index}]`
          const overlap = transitionAt(index - 1)
          if (overlap > 0) {
            lines.push(
              `${accumulator}[a${index}]acrossfade=d=${num(overlap)}:c1=tri:c2=tri${output}`,
            )
          } else {
            lines.push(`${accumulator}[a${index}]concat=n=2:v=0:a=1${output}`)
          }
          accumulator = output
        }
      }
    }
    audioLabel = 'outa'
  }

  return {
    width,
    height,
    fps,
    totalDuration,
    hasAudio,
    graph: lines.join(';\n'),
    videoLabel: 'outv',
    audioLabel,
    crf: qualityCrf(project.exportQuality.resolution),
    inputs: registry.inputs,
  }
}

/**
 * Export graph used when non-destructive trims left empty gaps on the timeline.
 * Gaps become black video + silent audio so the MP4 timing matches the editor.
 * Clip branches still read from their own source input.
 */
function buildGappedExportPlan(
  project: Project,
  sources: SourceInfo[],
  sourceHasAudio: boolean,
): ExportPlan {
  const { width, height } = getOutputDimensions(
    project.aspectRatio,
    project.exportQuality.resolution,
    sources[0],
  )
  const fps = project.exportQuality.fps
  const timeline = getTimeline(project.clips)
  const totalDuration = getProjectDuration(project.clips)
  const registry = createRegistry()
  const resolve = createResolver(sources)
  const mainVisible = isMainVideoVisible(project)
  const lines: string[] = []

  type Unit =
    | { kind: 'gap'; duration: number }
    | { kind: 'clip'; clip: Clip; clipIndex: number; duration: number }
  const units: Unit[] = []
  let cursor = 0
  for (const segment of timeline) {
    const gap = segment.start - cursor
    if (gap > 0.0001) units.push({ kind: 'gap', duration: gap })
    units.push({
      kind: 'clip',
      clip: segment.clip,
      clipIndex: segment.index,
      duration: segment.duration,
    })
    cursor = segment.end
  }

  const unitInputs = new Map<number, number>()
  const videoGroups = new Map<number, number[]>()
  units.forEach((unit, unitIndex) => {
    if (unit.kind !== 'clip') return
    const input = registerInput(registry, resolve(unit.clip), sourceHasAudio)
    unitInputs.set(unitIndex, input)
    if (!mainVisible) return
    const list = videoGroups.get(input)
    if (list) list.push(unitIndex)
    else videoGroups.set(input, [unitIndex])
  })

  const videoBranches = mainVisible
    ? splitBranches(lines, videoGroups, 'v', 'vsrc')
    : new Map<number, string>()
  const videoLabel = (index: number) => (units.length > 1 ? `[vu${index}]` : '[outv]')
  const audioLabelFor = (index: number) => (units.length > 1 ? `[au${index}]` : '[outa]')

  units.forEach((unit, index) => {
    if (unit.kind === 'gap') {
      lines.push(
        `color=c=black:s=${width}x${height}:r=${fps}:d=${num(unit.duration)},format=yuv420p,setsar=1${videoLabel(index)}`,
      )
      return
    }
    if (!mainVisible) {
      lines.push(
        `color=c=black:s=${width}x${height}:r=${fps}:d=${num(unit.duration)},format=yuv420p,setsar=1${videoLabel(index)}`,
      )
      return
    }
    const branch = videoBranches.get(index)!
    const source = resolve(unit.clip)
    const temporal = videoTemporalChain(unit.clip, source.duration, fps)
    const transform = videoTransformChain(unit.clip, width, height, source)
    if (transform === null) {
      lines.push(`${branch}${temporal},nullsink`)
      lines.push(
        `color=c=black:s=${width}x${height}:r=${fps}:d=${num(unit.duration)},format=yuv420p,setsar=1${videoLabel(index)}`,
      )
      return
    }
    lines.push(`${branch}${temporal},${transform}${videoLabel(index)}`)
  })

  if (units.length > 1) {
    const inputs = units.map((_, index) => `[vu${index}]`).join('')
    lines.push(`${inputs}concat=n=${units.length}:v=1:a=0[outv]`)
  }

  const audioGroups = new Map<number, number[]>()
  units.forEach((unit, unitIndex) => {
    if (unit.kind !== 'clip' || unit.clip.type !== 'video') return
    const input = unitInputs.get(unitIndex)
    if (input === undefined || !registry.inputs[input].hasAudio) return
    const list = audioGroups.get(input)
    if (list) list.push(unitIndex)
    else audioGroups.set(input, [unitIndex])
  })
  const hasAudio = audioGroups.size > 0
  let audioOutput: string | null = null
  if (hasAudio) {
    const audioBranches = splitBranches(lines, audioGroups, 'a', 'asrc')
    units.forEach((unit, index) => {
      if (unit.kind === 'gap') {
        lines.push(
          `anullsrc=r=48000:cl=stereo,atrim=duration=${num(unit.duration)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${audioLabelFor(index)}`,
        )
        return
      }
      const sourceLabel = audioBranches.get(index) ?? null
      lines.push(`${audioChain(unit.clip, sourceLabel)}${audioLabelFor(index)}`)
    })
    if (units.length > 1) {
      const inputs = units.map((_, index) => `[au${index}]`).join('')
      lines.push(`${inputs}concat=n=${units.length}:v=0:a=1[outa]`)
    }
    audioOutput = 'outa'
  }

  return {
    width,
    height,
    fps,
    totalDuration,
    hasAudio,
    graph: lines.join(';\n'),
    videoLabel: 'outv',
    audioLabel: audioOutput,
    crf: qualityCrf(project.exportQuality.resolution),
    inputs: registry.inputs,
  }
}

/**
 * Overlay export path. The base graph reads its own inputs; every overlay
 * source gets an additional input copy so the same media can feed both the
 * base track and an overlay without reusing a filter stream. Base audio is
 * kept, overlay video is silent.
 */
function buildOverlayExportPlan(
  project: Project,
  sources: SourceInfo[],
  sourceHasAudio: boolean,
): ExportPlan {
  const baseProject: Project = { ...project, overlayTracks: [] }
  const basePlan =
    project.clips.length > 0 ? buildFlatExportPlan(baseProject, sources, sourceHasAudio) : null
  const { width, height } = basePlan
    ? { width: basePlan.width, height: basePlan.height }
    : getOutputDimensions(project.aspectRatio, project.exportQuality.resolution, sources[0])
  const fps = project.exportQuality.fps
  const totalDuration = getProjectEnd(project)
  const baseDuration = basePlan?.totalDuration ?? 0
  const resolve = createResolver(sources)
  const lines: string[] = []
  const inputs: ExportInput[] = basePlan ? [...basePlan.inputs] : []
  const baseInputs = basePlan?.inputs ?? []
  const overlayInputByUrl = new Map<string, number>()

  const ensureOverlayInput = (source: SourceInfo): number => {
    const existing = overlayInputByUrl.get(source.url)
    if (existing !== undefined) return existing
    const shared = baseInputs.find((input) => input.url === source.url)
    const index = inputs.length
    inputs.push({
      url: source.url,
      file: shared?.file ?? `input${index}${extensionFor(source)}`,
      width: source.width,
      height: source.height,
      duration: source.duration,
      hasAudio: false,
    })
    overlayInputByUrl.set(source.url, index)
    return index
  }

  if (basePlan) {
    const replaced = basePlan.graph
      .replaceAll('[outv]', '[basev]')
      .replaceAll('[outa]', '[basea]')
    lines.push(replaced)
  } else {
    lines.push(
      `color=c=black:s=${width}x${height}:r=${fps}:d=${num(totalDuration)},format=yuv420p,setsar=1[basev]`,
    )
  }

  let baseLabel = 'basev'
  if (basePlan && totalDuration > baseDuration + 0.001) {
    lines.push(
      `[basev]tpad=stop_mode=add:stop_duration=${num(totalDuration - baseDuration)}:color=black[basepad]`,
    )
    baseLabel = 'basepad'
  }

  type OverlayUnit = { clip: Clip; source: SourceInfo; input: number; start: number; duration: number }
  const units: OverlayUnit[] = []
  for (const track of getOverlayTracks(project)) {
    if (!isOverlayVideoVisible(track)) continue
    for (const segment of getTimeline(track.clips)) {
      if (segment.duration <= 0.001) continue
      const source = resolve(segment.clip)
      units.push({
        clip: segment.clip,
        source,
        input: ensureOverlayInput(source),
        start: segment.start,
        duration: segment.duration,
      })
    }
  }

  if (units.length > 0) {
    const overlayGroups = new Map<number, number[]>()
    units.forEach((unit, index) => {
      const list = overlayGroups.get(unit.input)
      if (list) list.push(index)
      else overlayGroups.set(unit.input, [index])
    })
    const overlayBranches = splitBranches(lines, overlayGroups, 'v', 'ovsrc')
    const overlayLabels: string[] = []
    units.forEach((unit, index) => {
      const branch = overlayBranches.get(index)!
      const temporal = videoTemporalChain(unit.clip, unit.source.duration, fps)
      const transform = overlayTransformChain(unit.clip, width, height, unit.source)
      const output = `[ov${index}]`
      overlayLabels.push(output)
      if (transform === null) {
        lines.push(`${branch}${temporal},nullsink`)
        lines.push(
          `color=c=black@0:s=${width}x${height}:r=${fps}:d=${num(unit.duration)},format=rgba,setpts=PTS+${num(unit.start)}/TB${output}`,
        )
        return
      }
      lines.push(
        `${branch}${temporal},${transform},setpts=PTS+${num(unit.start)}/TB${output}`,
      )
    })

    let previous = `[${baseLabel}]`
    units.forEach((unit, index) => {
      const output = index === units.length - 1 ? '[outv]' : `[vc${index}]`
      const mode = clipBlendMode(unit.clip)
      if (mode === 'normal') {
        // 普通合成：overlay 叠加，带 alpha 的不透明度已在上游处理。
        lines.push(
          `${previous}${overlayLabels[index]}overlay=0:0:eof_action=pass:format=auto:enable='between(t,${num(unit.start)},${num(unit.start + unit.duration)})'${output}`,
        )
      } else {
        // 混合模式：blend 需要两条等长、同尺寸的流，把叠加流按时间轴补全长。
        // 先 pad 到片段起点、再 pad 到结尾，然后用 blend=all_mode 合成。
        const padded = `[ovb${index}]`
        const total = num(totalDuration)
        const stop = Math.max(0, totalDuration - (unit.start + unit.duration))
        lines.push(
          `${overlayLabels[index]}tpad=start_duration=${num(unit.start)}:stop_duration=${num(stop)}:color=0x00000000,format=yuva420p${padded}`,
        )
        lines.push(
          `${previous}${padded}blend=all_mode=${ffmpegBlendMode(mode)}:all_opacity=1,trim=duration=${total},format=yuva420p${output}`,
        )
      }
      previous = output
    })
  } else {
    lines.push(`[${baseLabel}]null[outv]`)
  }

  const hasAudio = basePlan?.hasAudio ?? false
  let audioLabel: string | null = null
  if (hasAudio) {
    lines.push(
      `[basea]apad=whole_dur=${num(totalDuration)},atrim=duration=${num(totalDuration)}[outa]`,
    )
    audioLabel = 'outa'
  }

  return {
    width,
    height,
    fps,
    totalDuration,
    hasAudio,
    graph: lines.join(';\n'),
    videoLabel: 'outv',
    audioLabel,
    crf: qualityCrf(project.exportQuality.resolution),
    inputs,
    usesOverlaySource: units.length > 0,
  }
}

/**
 * Adds audio-track clips to an already built video plan. The main audio branch
 * is renamed to `maina`, each audio clip gets an `adelay`-positioned branch,
 * and everything is mixed with `amix` before the final `[outa]` label.
 */
function applyAudioTracks(
  project: Project,
  sources: SourceInfo[],
  plan: ExportPlan,
): ExportPlan {
  const branches: string[] = []
  const inputs = [...plan.inputs]
  const inputIndexByUrl = new Map(inputs.map((input, index) => [input.url, index]))
  const resolveSource = (url: string): SourceInfo | undefined =>
    sources.find((source) => source.url === url)

  const ensureAudioInput = (source: SourceInfo): number | null => {
    const existing = inputIndexByUrl.get(source.url)
    if (existing !== undefined) return existing
    const index = inputs.length
    inputs.push({
      url: source.url,
      file: `input${index}${extensionFor(source)}`,
      width: source.width,
      height: source.height,
      duration: source.duration,
      hasAudio: true,
      kind: 'audio',
    })
    inputIndexByUrl.set(source.url, index)
    return index
  }

  for (const track of project.audioTracks ?? []) {
    if (!isAudioTrackActive(project, track) || track.volume <= 0.0001) continue
    for (const clip of track.clips) {
      const duration = audioClipDuration(clip)
      if (duration <= 0.02) continue
      const gain = track.volume * clip.volume
      if (gain <= 0.0001) continue
      const source = resolveSource(clip.sourceUrl)
      if (!source) continue
      const input = ensureAudioInput(source)
      if (input === null) continue
      const start = Math.max(0, clip.sourceStart)
      const end = Math.min(
        clip.sourceEnd,
        source.duration > 0 ? source.duration : clip.sourceEnd,
      )
      if (end <= start + 0.001) continue
      const filters = [
        `[${input}:a]atrim=start=${num(start)}:end=${num(end)}`,
        'asetpts=PTS-STARTPTS',
        `volume=${num(gain)}`,
      ]
      if (clip.fadeIn > 0.001) {
        filters.push(`afade=t=in:st=0:d=${num(Math.min(clip.fadeIn, duration))}`)
      }
      if (clip.fadeOut > 0.001) {
        filters.push(
          `afade=t=out:st=${num(Math.max(0, duration - clip.fadeOut))}:d=${num(Math.min(clip.fadeOut, duration))}`,
        )
      }
      filters.push(
        'aresample=48000',
        'aformat=sample_fmts=fltp:channel_layouts=stereo',
      )
      const delayMs = Math.round(clip.start * 1000)
      if (delayMs > 0) filters.push(`adelay=${delayMs}|${delayMs}`)
      const label = `[ac${branches.length}]`
      branches.push(`${filters.join(',')}${label}`)
    }
  }

  // 叠加轨声音：不再强制静音，按轨道 muted/solo 与片段音量/淡入淡出混入 amix。
  for (const track of getOverlayTracks(project)) {
    if (!isOverlayAudioActive(project, track)) continue
    for (const segment of getTimeline(track.clips)) {
      const clip = segment.clip
      if (clip.type === 'freeze') continue
      const duration = clamp(clipTimelineDuration(clip), 0.02, 3600)
      const gain = clipVolume(clip)
      if (gain <= 0.0001) continue
      const source = resolveSource(clip.sourceUrl)
      if (!source) continue
      const input = ensureAudioInput(source)
      if (input === null) continue
      const start = Math.max(0, clip.sourceStart)
      const end = Math.min(
        clip.sourceEnd,
        source.duration > 0 ? source.duration : clip.sourceEnd,
      )
      if (end <= start + 0.001) continue
      const filters = [
        `[${input}:a]atrim=start=${num(start)}:end=${num(end)}`,
        'asetpts=PTS-STARTPTS',
        `volume=${num(gain)}`,
      ]
      const fadeIn = clipFadeIn(clip)
      const fadeOut = clipFadeOut(clip)
      if (fadeIn > 0.001) filters.push(`afade=t=in:st=0:d=${num(Math.min(fadeIn, duration))}`)
      if (fadeOut > 0.001) {
        filters.push(
          `afade=t=out:st=${num(Math.max(0, duration - fadeOut))}:d=${num(Math.min(fadeOut, duration))}`,
        )
      }
      filters.push(
        'aresample=48000',
        'aformat=sample_fmts=fltp:channel_layouts=stereo',
      )
      const delayMs = Math.round(segment.start * 1000)
      if (delayMs > 0) filters.push(`adelay=${delayMs}|${delayMs}`)
      const label = `[ac${branches.length}]`
      branches.push(`${filters.join(',')}${label}`)
    }
  }

  if (branches.length === 0) return plan

  const totalDuration = Math.max(plan.totalDuration, audioProjectEnd(project))
  let graph = plan.graph
  let mainLabel: string | null = plan.audioLabel ? `[${plan.audioLabel}]` : null
  if (mainLabel === '[outa]') {
    const at = graph.lastIndexOf('[outa]')
    if (at >= 0) {
      graph = `${graph.slice(0, at)}[maina]${graph.slice(at + 6)}`
      mainLabel = '[maina]'
    }
  }
  if (!mainLabel) {
    graph += `;\nanullsrc=r=48000:cl=stereo,atrim=duration=${num(totalDuration)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[maina]`
    mainLabel = '[maina]'
  }

  const branchInputs = branches.map((_, index) => `[ac${index}]`).join('')
  graph += `;\n${branches.join(';\n')}`
  graph += `;\n${mainLabel}${branchInputs}amix=inputs=${branches.length + 1}:duration=longest:dropout_transition=0:normalize=0[amix]`
  graph += `;\n[amix]apad=whole_dur=${num(totalDuration)},atrim=duration=${num(totalDuration)}[outa]`

  let videoLabel = plan.videoLabel
  if (totalDuration > plan.totalDuration + 0.001) {
    graph += `;\n[${videoLabel}]tpad=stop_mode=add:stop_duration=${num(totalDuration - plan.totalDuration)}:color=black[outvpad]`
    videoLabel = 'outvpad'
  }

  return {
    ...plan,
    graph,
    inputs,
    videoLabel,
    audioLabel: 'outa',
    totalDuration,
    hasAudio: true,
  }
}

export function buildExportArgs(
  plan: ExportPlan,
  graphName: string,
  outputName: string,
): string[] {
  const args: string[] = []
  for (const input of plan.inputs) {
    if (input.kind === 'image') {
      // 静帧素材：无限循环成帧流，时长交给滤镜图的 trim 控制。
      args.push('-loop', '1', '-t', num(Math.max(1, plan.totalDuration)))
    }
    args.push('-i', input.file)
  }
  args.push('-filter_complex_script', graphName, '-map', `[${plan.videoLabel}]`)
  if (plan.audioLabel) args.push('-map', `[${plan.audioLabel}]`)
  args.push(
    '-t',
    num(plan.totalDuration),
    '-r',
    String(plan.fps),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    String(plan.crf),
    '-pix_fmt',
    'yuv420p',
  )
  if (plan.audioLabel) {
    args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2')
  }
  args.push('-movflags', '+faststart', outputName)
  return args
}

export function getExportCrf(resolution: Project['exportQuality']['resolution']): number {
  return qualityCrf(resolution)
}