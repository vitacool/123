import { chromaKeyFilter, despillFilter } from './chromaKey'
import { getOutputDimensions } from './aspect'
import { buildVolumeExpression, maxVolumeKeyValue } from './animationExpr'
import { hasVolumeAnimation } from './animation'
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
import {
  clipKeepsPitch,
  clipSpeedValue,
  segmentPlan,
  speedAudioFilters,
  speedSegmentedVideoFilter,
  speedVideoFilter,
} from './speed'
import { clipColor, ffmpegColorFilters } from './color'
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
import { clampExportRange, exportRangeDuration, type ExportRange } from './exportRange'
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

/** 仅音频导出的封装格式。 */
export type AudioExportFormat = 'm4a' | 'mp3'

/** `buildExportPlan` / `buildAudioExportPlan` 的可选设置。 */
export interface BuildExportOptions {
  /**
   * 只导出该时间区间；缺省 / null 表示导出整条时间轴。
   * 传了区间时 `totalDuration`（以及 `-t`）已经是区间时长，但图上的
   * trim / atrim 由 `applyExportRangeTrim` 追加——必须在文字 / 封面层
   * 合成之后调用（ffmpegExporter 已按这个顺序处理）。
   */
  range?: ExportRange | null
  /**
   * clipId → 蒙版 PNG 的 -i 输入序号。由 exporter 决定（它才知道总输入数），
   * 因此与文字层 / 封面层共用一个序列，不会冲突。
   */
  maskInputs?: ReadonlyMap<string, number>
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
  /**
   * 区间导出时，裁剪前的完整合成时长（秒）；未设置区间时该字段缺省。
   * 文字 / 封面层仍按这个时长生成，再在 trim 之前合成（见 applyExportRangeTrim）。
   */
  fullDuration?: number
  /** 区间导出被夹取后的入 / 出点（秒）；未设置区间时该字段缺省。 */
  exportRange?: ExportRange
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

/**
 * 片段引用的素材是否已经不在导出源里（素材被从素材库移除）。
 * 这类片段不参与解码，直接输出画布背景，避免用别的素材顶替。
 */
function isClipSourceMissing(sources: SourceInfo[], clip: Clip): boolean {
  return !sources.some((source) => source.url === clip.sourceUrl)
}

/** 素材缺失片段的占位分支：纯画布背景，时长与片段一致。 */
function missingClipBackgroundLine(
  clip: Clip,
  project: Project,
  width: number,
  height: number,
  fps: number,
): string {
  const duration = clamp(clipTimelineDuration(clip), 0.02, 3600)
  const background = clipBackground(clip, project)
  return `color=c=${backgroundFfmpegColor(background)}:s=${width}x${height}:r=${fps}:d=${num(duration)},format=yuv420p,setsar=1`
}

/**
 * 按输入序号分组，跳过 -1（素材缺失的片段没有输入）。
 * 与 groupIndexes 的区别：保留片段在工程里的原始下标。
 */
function groupUsableInputs(inputs: readonly number[]): Map<number, number[]> {
  const groups = new Map<number, number[]>()
  inputs.forEach((input, index) => {
    if (input < 0) return
    const list = groups.get(input)
    if (list) list.push(index)
    else groups.set(input, [index])
  })
  return groups
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
  // 分段变速：用一条分段线性的 setpts 表达式完成时间映射（不需要 trim+concat）。
  const segmentedFilter = speedSegmentedVideoFilter(clip)
  const speedFilter = segmentedFilter ?? speedVideoFilter(clip.speed ?? 1)
  return [
    `trim=start=${num(clip.sourceStart)}:end=${num(clip.sourceEnd)}`,
    'setpts=PTS-STARTPTS',
    ...(speedFilter ? [speedFilter] : []),
    `fps=${fps}`,
    `trim=duration=${num(duration)}`,
    'setpts=PTS-STARTPTS',
  ].join(',')
}

/**
 * 调色系数校准记录（3×3 采样，对比「预览 canvas」与「导出 mp4 首帧」的单通道差值）：
 *
 * - 素材与方法：320×180 静态色块图（9 个已知色块），输出 480p/30fps，
 *   采样点取画布 20% / 50% / 80% 的 3×3 网格。
 * - 零参数基线：预览 [45,161,76] vs 导出 [54,179,80]，最大单通道差 18。
 *   这是「编码 → 浏览器解码」的色彩矩阵/范围往返造成的，不做任何调色也存在；
 *   在单片段链的 scale 上显式声明 `in_range=full:out_range=limited` 后由 30 降到 18。
 * - 饱和度 +80：原始最大差 24（扣除上述基线偏移后约 6）；-80：16。
 *   预览用 CSS `saturate(1+s/100)`（sRGB 逐通道），eq 的 saturation 在 YUV 色度空间，
 *   直接取 1+s/100 时 +80 偏大约 19、-80 偏小约 42，故改用幂函数
 *   `(1+s/100)^0.65`（见 core/color.ts 的 SATURATION_EXPONENT），两端残差都降到 ≤12。
 * - 亮度 / 对比度：CSS 是逐通道线性（sRGB），eq 的 brightness/contrast 作用在 YUV 亮度上，
 *   属结构性差异，±80 时差值 70–107，无法用系数对齐；这里保持 b/200、1+c/100，
 *   只保证方向一致（更亮 / 更高反差），不在调色系数校准范围内。
 * - 色温：预览用 overlay 叠加层近似 colorbalance，±80 时残差约 25，方向一致。
 */
/**
 * 带蒙版的片段：把滤镜链拆成「alphamerge 之前 / 之后」两段。
 *
 * 主轨结构：
 *   [in]crop…,hflip,vflip,format=rgba[pre];
 *   [mask:v]format=rgba,scale=cropW:cropH[mask];
 *   [pre][mask]alphamerge[mid];
 *   [mid]rotate(c=black@0),色,scale…,format=rgba,crop=visible,pad(透明),format=yuva420p[mid2]
 * 之后由调用方垫背景层再 overlay —— 蒙版外露出画布背景。
 * 叠加轨不垫背景：保留 alpha 直接叠到主轨上。
 */
export function maskedClipPieces(
  clip: Clip,
  width: number,
  height: number,
  source: SourceInfo,
  overlay: boolean,
): { prefix: string; suffix: string; maskWidth: number; maskHeight: number } | null {
  if (!clip.mask && !clip.chromaKey) return null
  const geometry = computeClipGeometry(clip, source, width, height)
  const { source: crop, rendered, visible } = geometry
  if (visible.w < 2 || visible.h < 2) return null
  const prefix: string[] = [`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`]
  if (clip.flipH) prefix.push('hflip')
  if (clip.flipV) prefix.push('vflip')
  // 抠像：crop/flip 之后、alphamerge（蒙版）之前；先补 alpha 再 chromakey。
  if (clip.chromaKey) {
    prefix.push('format=yuva420p', chromaKeyFilter(clip.chromaKey))
    const spill = despillFilter(clip.chromaKey)
    if (spill) prefix.push(spill)
  } else {
    prefix.push('format=rgba')
  }

  const suffix: string[] = []
  if (Math.abs(clip.rotation) > 0.001) {
    suffix.push(
      `rotate=${num((clip.rotation * Math.PI) / 180)}:ow=${geometry.rotated.w}:oh=${geometry.rotated.h}:c=black@0`,
    )
  }
  suffix.push(...ffmpegColorFilters(clipColor(clip)))
  suffix.push(`scale=${rendered.w}:${rendered.h}:in_range=full:out_range=limited:flags=lanczos`)
  suffix.push(
    'format=rgba',
    `crop=${Math.round(visible.w)}:${Math.round(visible.h)}:${Math.round(visible.x)}:${Math.round(visible.y)}`,
    `pad=${width}:${height}:${Math.round(rendered.x + visible.x)}:${Math.round(rendered.y + visible.y)}:color=0x00000000`,
  )
  if (overlay) {
    suffix.push('format=rgba', 'setsar=1', ...opacityFilters(clipOpacity(clip)))
  } else {
    suffix.push('format=yuva420p', 'setsar=1')
  }
  return {
    prefix: prefix.join(','),
    suffix: suffix.join(','),
    maskWidth: Math.round(crop.w),
    maskHeight: Math.round(crop.h),
  }
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
  // 调色插在单片段视频链里（与 crop / hflip / rotate 同级、scale 之前），
  // 因此叠加轨片段只会拿到自己的调色参数，不会串到主轨。
  parts.push(...ffmpegColorFilters(clipColor(clip)))
  parts.push(`scale=${rendered.w}:${rendered.h}:in_range=full:out_range=limited:flags=lanczos`)

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
  // 叠加轨同样只吃自己的调色参数（与主轨互不影响）。
  parts.push(...ffmpegColorFilters(clipColor(clip)))
  parts.push(
    `scale=${rendered.w}:${rendered.h}:in_range=full:out_range=limited:flags=lanczos`,
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

/**
 * 音频链的「后段」：音量（含关键帧）/ 淡入淡出 / 采样格式 / 补齐与裁剪。
 * 分段变速时它接在 concat 之后，整段只做一次；不分段时接在 atempo 之后。
 * 音量曲线的 `t` 是片段本地时间（0…clipTimelineDuration），所以放在变速之后。
 */
function audioTailChain(clip: Clip, duration: number): string[] {
  const gain = clipVolume(clip)
  const fadeIn = clipFadeIn(clip)
  const fadeOut = clipFadeOut(clip)
  const parts: string[] = []
  if (hasVolumeAnimation(clip)) {
    const expression = buildVolumeExpression(clip.anim!.volume!, duration)
    if (expression) parts.push(`volume='${expression}':eval=frame`)
  } else if (gain !== 1) {
    parts.push(`volume=${num(gain)}`)
  }
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
  return parts
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
  // 变速：保持音调用 atempo 链（每级 0.5–2），否则用 asetrate+aresample。
  const speedFilters = speedAudioFilters(clipSpeedValue(clip), clipKeepsPitch(clip))
  const parts = [
    `${sourceLabel}atrim=start=${num(clip.sourceStart)}:end=${num(clip.sourceEnd)}`,
    'asetpts=PTS-STARTPTS',
    ...speedFilters,
    ...audioTailChain(clip, duration),
  ]
  return parts.join(',')
}

/**
 * 写一条音频链到图上（接受「单行」或「多行」两种形态）。
 *
 * 分段变速的音频必须**逐段** `atrim + setpts + atempo`（atempo 只支持恒定倍率），
 * 再 `concat` 回一条流；后段（音量/淡入淡出/格式）整段只做一次。
 */
function emitAudio(
  lines: string[],
  clip: Clip,
  sourceLabel: string | null,
  output: string,
): void {
  const duration = clamp(clipTimelineDuration(clip), 0.02, 60 * 60)
  const plan = sourceLabel && clip.type === 'video' ? segmentPlan(clip) : null
  if (!plan || plan.length < 2) {
    lines.push(`${audioChain(clip, sourceLabel)}${output}`)
    return
  }
  // 段标签用输出标签名做前缀，保证同一张图里唯一（[outa] / [a3] / [oa1]…）。
  const base = output.replace(/[[\]]/g, '')
  const keepPitch = clipKeepsPitch(clip)
  const labels: string[] = []
  plan.forEach((segment, index) => {
    const label = `[${base}sg${index}]`
    labels.push(label)
    lines.push(
      `${sourceLabel}atrim=start=${num(segment.sourceStart)}:end=${num(segment.sourceEnd)},` +
        `asetpts=PTS-STARTPTS,${speedAudioFilters(segment.speed, keepPitch).join(',')}${label}`,
    )
  })
  const tail = audioTailChain(clip, duration).join(',')
  lines.push(`${labels.join('')}concat=n=${plan.length}:v=0:a=1,${tail}${output}`)
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
  options: BuildExportOptions = {},
): ExportPlan {
  const sources = normalizeSources(sourceOrSources)
  const mainAudio = sourceHasAudio && isMainAudioActive(project)
  const plan = buildExportPlanWithoutAudio(project, sources, mainAudio, options.maskInputs)
  const mixed = applyAudioTracks(project, sources, plan)
  return finalizePlan(project, mixed, options.range)
}

/**
 * 纯音频导出计划：只生成音频滤镜链，完全不创建视频分支。
 * 这样不可能出现未被消费的 `[outv]` 等视频标签；输入也只注册真正
 * 参与主轨/音频轨/叠加轨声音的素材。
 */
export function buildAudioExportPlan(
  project: Project,
  sourceOrSources: SourceInfo | SourceInfo[],
  sourceHasAudio: boolean,
  options: BuildExportOptions = {},
): ExportPlan {
  const sources = normalizeSources(sourceOrSources)
  const mainAudio = sourceHasAudio && isMainAudioActive(project)
  const base = buildAudioBasePlan(project, sources, mainAudio)
  const mixed = applyAudioTracks(project, sources, base, true)
  return finalizePlan(project, mixed, options.range)
}

/**
 * 记录导出区间，并**在 plan 内裁好音频**（atrim + asetpts）。
 *
 * 为什么音频裁剪要放在这里而不是和视频一起在最后追加：响度标准化（loudnorm）
 * 必须按「实际导出的那一段」测量，所以 atrim 要先于 loudnorm 出现在图里。
 * 视频分支的裁剪仍然由 applyExportRangeTrim 在文字/封面层合成之后追加
 * （文字层不能跟着区间平移）。
 */
function withExportRange(plan: ExportPlan, range: ExportRange): ExportPlan {
  const start = num(range.start)
  const end = num(range.end)
  const parts: string[] = []
  let audioLabel = plan.audioLabel
  if (audioLabel) {
    const nextAudioLabel = `${audioLabel}_range`
    parts.push(
      `[${audioLabel}]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[${nextAudioLabel}]`,
    )
    audioLabel = nextAudioLabel
  }
  const added = parts.join(';\n')
  return {
    ...plan,
    graph:
      parts.length === 0 ? plan.graph : plan.graph.length > 0 ? `${plan.graph};\n${added}` : added,
    audioLabel,
    totalDuration: exportRangeDuration(range),
    fullDuration: plan.totalDuration,
    exportRange: range,
  }
}

/**
 * 收尾：区间有效时先裁音频再做响度标准化；没有区间时保持历史顺序与逐字输出
 * （loudnorm 直接作用在最终音频标签上）。
 */
function finalizePlan(
  project: Project,
  plan: ExportPlan,
  range: ExportRange | null | undefined,
): ExportPlan {
  const clamped = clampExportRange(range, plan.totalDuration)
  if (!clamped) return applyLoudnessNormalization(project, plan)
  return applyLoudnessNormalization(project, withExportRange(plan, clamped))
}

/**
 * 在最终**视频**标签上裁出入点区间，并重置 PTS。
 *
 * 音频已经在构建 plan 时裁好（见 withExportRange）——响度标准化必须在裁剪之后执行，
 * 所以不能把 atrim 一起放到最后追加。
 *
 * 调用顺序很重要（ffmpegExporter 负责）：文字层在 trim 之前合成（字幕不能跟着区间平移），
 * 封面层在 trim 之后合成（封面要落在导出段的第一帧）。
 * 未设置区间时原样返回 plan（graph、标签、时长逐字不变）。
 */
export function applyExportRangeTrim(plan: ExportPlan): ExportPlan {
  const range = plan.exportRange
  if (!range) return plan
  // 纯音频计划没有 `[outv]`（只有占位的 videoLabel）：音频已裁好，无需追加。
  if (!plan.graph.includes(`[${plan.videoLabel}]`)) return plan
  const start = num(range.start)
  const end = num(range.end)
  const videoLabel = `${plan.videoLabel}_range`
  return {
    ...plan,
    graph:
      `${plan.graph};\n[${plan.videoLabel}]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[${videoLabel}]`,
    videoLabel,
  }
}

function buildAudioBasePlan(
  project: Project,
  sources: SourceInfo[],
  mainAudio: boolean,
): ExportPlan {
  const timeline = getTimeline(project.clips)
  let previousEnd = 0
  const hasGaps = timeline.some((segment) => {
    const gap = segment.start - previousEnd
    previousEnd = segment.end
    return gap > 0.0001
  })
  return hasGaps
    ? buildGappedAudioPlan(project, sources, mainAudio)
    : buildContiguousAudioPlan(project, sources, mainAudio)
}

function audioPlanDimensions(project: Project, sources: SourceInfo[]): {
  width: number
  height: number
} {
  const sized = sources.find((source) => source.width > 0 && source.height > 0)
  const fallback = { ...sources[0], width: 1920, height: 1080 }
  return getOutputDimensions(
    project.aspectRatio,
    project.exportQuality.resolution,
    sized ?? fallback,
  )
}

function registerMainAudioInputs(
  project: Project,
  sources: SourceInfo[],
  mainAudio: boolean,
  registry: InputRegistry,
): { clipInputs: number[]; resolve: (clip: Clip) => SourceInfo } {
  const resolve = createResolver(sources)
  const clipInputs = project.clips.map((clip) => {
    if (!mainAudio || clip.type !== 'video' || isClipSourceMissing(sources, clip)) {
      return -1
    }
    const source = resolve(clip)
    if (source.hasAudio === false) return -1
    const input = registerInput(registry, source, true)
    return registry.inputs[input].hasAudio ? input : -1
  })
  return { clipInputs, resolve }
}

function buildContiguousAudioPlan(
  project: Project,
  sources: SourceInfo[],
  mainAudio: boolean,
): ExportPlan {
  const { width, height } = audioPlanDimensions(project, sources)
  const fps = project.exportQuality.fps
  const totalDuration = getProjectDuration(project.clips)
  const clipCount = project.clips.length
  const registry = createRegistry()
  const { clipInputs } = registerMainAudioInputs(project, sources, mainAudio, registry)
  const lines: string[] = []

  const audioGroups = new Map<number, number[]>()
  clipInputs.forEach((input, index) => {
    if (input < 0) return
    const list = audioGroups.get(input)
    if (list) list.push(index)
    else audioGroups.set(input, [index])
  })
  const hasAudio = audioGroups.size > 0
  let audioLabel: string | null = null

  if (hasAudio) {
    const audioBranches = splitBranches(lines, audioGroups, 'a', 'asrc')
    const transitionAt = (index: number): number => {
      if (index + 1 >= project.clips.length) return 0
      const next = project.clips[index + 1]
      const gap = Math.max(0, next.gapBefore ?? 0)
      return resolveTransitionDuration(project.clips[index], next, gap)
    }
    const hasAnyTransition = project.clips.some((_, index) => transitionAt(index) > 0)

    project.clips.forEach((clip, index) => {
      const sourceLabel = audioBranches.get(index) ?? null
      const output = clipCount > 1 ? `[a${index}]` : '[outa]'
      emitAudio(lines, clip, sourceLabel, output)
    })
    if (clipCount > 1) {
      if (!hasAnyTransition) {
        const inputs = project.clips.map((_, index) => `[a${index}]`).join('')
        lines.push(`${inputs}concat=n=${clipCount}:v=0:a=1[outa]`)
      } else {
        let accumulator = '[a0]'
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

function buildGappedAudioPlan(
  project: Project,
  sources: SourceInfo[],
  mainAudio: boolean,
): ExportPlan {
  const { width, height } = audioPlanDimensions(project, sources)
  const fps = project.exportQuality.fps
  const timeline = getTimeline(project.clips)
  const totalDuration = getProjectDuration(project.clips)
  const registry = createRegistry()
  const resolve = createResolver(sources)
  const lines: string[] = []

  type AudioUnit =
    | { kind: 'gap'; duration: number }
    | { kind: 'clip'; clip: Clip; clipIndex: number; duration: number }
  const units: AudioUnit[] = []
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
  units.forEach((unit, unitIndex) => {
    if (unit.kind !== 'clip') return
    if (!mainAudio || unit.clip.type !== 'video' || isClipSourceMissing(sources, unit.clip)) {
      return
    }
    const source = resolve(unit.clip)
    if (source.hasAudio === false) return
    const input = registerInput(registry, source, true)
    if (registry.inputs[input].hasAudio) unitInputs.set(unitIndex, input)
  })

  const audioGroups = new Map<number, number[]>()
  unitInputs.forEach((input, unitIndex) => {
    const list = audioGroups.get(input)
    if (list) list.push(unitIndex)
    else audioGroups.set(input, [unitIndex])
  })
  const hasAudio = audioGroups.size > 0
  let audioLabel: string | null = null
  const audioLabelFor = (index: number) => (units.length > 1 ? `[au${index}]` : '[outa]')

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
      emitAudio(lines, unit.clip, sourceLabel, audioLabelFor(index))
    })
    if (units.length > 1) {
      const inputs = units.map((_, index) => `[au${index}]`).join('')
      lines.push(`${inputs}concat=n=${units.length}:v=0:a=1[outa]`)
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
 * 在最终混音标签之后追加一次单遍 loudnorm。loudnorm 的默认 single-pass
 * 模式会在内部升采样；随后立刻 aresample=48000 再交给 AAC 编码。
 *
 * off / 未设置时原样返回 plan（graph、audioLabel、args 全部不变）。
 * 无音频时 audioLabel 为 null，同样不追加。
 */
function applyLoudnessNormalization(project: Project, plan: ExportPlan): ExportPlan {
  const loudness = project.exportQuality.loudness ?? 'off'
  if (loudness === 'off' || !plan.audioLabel) return plan
  const params =
    loudness === 'platform' ? 'I=-14:TP=-1:LRA=11' : 'I=-23:TP=-2:LRA=7'
  const normalizedLabel = `${plan.audioLabel}_norm`
  return {
    ...plan,
    graph: `${plan.graph};\n[${plan.audioLabel}]loudnorm=${params},aresample=48000[${normalizedLabel}]`,
    audioLabel: normalizedLabel,
  }
}

function buildExportPlanWithoutAudio(
  project: Project,
  sources: SourceInfo[],
  sourceHasAudio: boolean,
  maskInputs?: ReadonlyMap<string, number>,
): ExportPlan {
  if (getOverlayTracks(project).some((track) => isOverlayVideoVisible(track) && track.clips.length > 0)) {
    return buildOverlayExportPlan(project, sources, sourceHasAudio, maskInputs)
  }
  return buildFlatExportPlan(project, sources, sourceHasAudio, maskInputs)
}

function buildFlatExportPlan(
  project: Project,
  sources: SourceInfo[],
  sourceHasAudio: boolean,
  maskInputs?: ReadonlyMap<string, number>,
): ExportPlan {
  if (project.clips.length === 0) throw new Error('时间轴为空，无法导出。')
  const timeline = getTimeline(project.clips)
  let previousEnd = 0
  const hasGaps = timeline.some((segment) => {
    const gap = segment.start - previousEnd
    previousEnd = segment.end
    return gap > 0.0001
  })
  if (hasGaps) return buildGappedExportPlan(project, sources, sourceHasAudio, maskInputs)
  return buildContiguousExportPlan(project, sources, sourceHasAudio, maskInputs)
}

function buildContiguousExportPlan(
  project: Project,
  sources: SourceInfo[],
  sourceHasAudio: boolean,
  maskInputs?: ReadonlyMap<string, number>,
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
    isClipSourceMissing(sources, clip)
      ? -1
      : registerInput(registry, resolve(clip), sourceHasAudio),
  )
  const lines: string[] = []

  const videoBranches = mainVisible
    ? splitBranches(lines, groupUsableInputs(clipInputs), 'v', 'vsrc')
    : new Map<number, string>()

  project.clips.forEach((clip, index) => {
    const output = clipCount > 1 ? `[v${index}]` : '[outv]'
    const clipDuration = clamp(clipTimelineDuration(clip), 0.02, 3600)
    // 素材已从素材库移除：输出画布背景，不消费任何输入。
    if (clipInputs[index] < 0) {
      lines.push(`${missingClipBackgroundLine(clip, project, width, height, fps)}${output}`)
      return
    }
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
    // ---- 带蒙版的主轨片段 ----
    // crop/flip 之后 alphamerge（蒙版 PNG 尺寸 = 裁切尺寸），再垫背景层合成，
    // 让蒙版外露出画布背景（黑 / 纯色 / 模糊），之后才进入 xfade / concat。
    const maskInput = maskInputs?.get(clip.id)
    const maskPieces =
      maskInput === undefined && !clip.chromaKey
        ? null
        : maskedClipPieces(clip, width, height, source, false)
    if (maskPieces) {
      const pre = `mp${index}`
      const maskLabel = `mm${index}`
      const mid = `md${index}`
      const fg = `mf${index}`
      const bg = `mg${index}`
      if (background.type === 'blur') {
        lines.push(`${branch}split=2[mb${index}][mf0${index}]`)
        lines.push(
          `[mb${index}]${temporal},${blurBackgroundChain(width, height, backgroundBlurPx(background))}[${bg}]`,
        )
        lines.push(`[mf0${index}]${temporal},${maskPieces.prefix}[${pre}]`)
      } else {
        lines.push(`${branch}${temporal},${maskPieces.prefix}[${pre}]`)
        lines.push(
          `color=c=${backgroundFfmpegColor(background)}:s=${width}x${height}:r=${fps}:d=${num(clipDuration)},format=yuv420p[${bg}]`,
        )
      }
      // 有蒙版才需要 alphamerge；纯抠像直接拿 prefix 的输出继续。
      if (maskInput !== undefined) {
        lines.push(
          `[${maskInput}:v]format=rgba,scale=${maskPieces.maskWidth}:${maskPieces.maskHeight}[${maskLabel}]`,
        )
        lines.push(`[${pre}][${maskLabel}]alphamerge[${mid}]`)
        lines.push(`[${mid}]${maskPieces.suffix}[${fg}]`)
      } else {
        lines.push(`[${pre}]${maskPieces.suffix}[${fg}]`)
      }
      lines.push(`[${bg}][${fg}]overlay=0:0:format=auto,format=yuv420p${output}`)
      return
    }

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
    if (input < 0) return
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
      emitAudio(lines, clip, sourceLabel, output)
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
  maskInputs?: ReadonlyMap<string, number>,
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
    // 素材已从素材库移除：不注册输入，后面直接输出画布背景。
    const input = isClipSourceMissing(sources, unit.clip)
      ? -1
      : registerInput(registry, resolve(unit.clip), sourceHasAudio)
    unitInputs.set(unitIndex, input)
    if (input < 0 || !mainVisible) return
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
    // 素材已从素材库移除：该段输出画布背景。
    if (unitInputs.get(index) === -1) {
      lines.push(`${missingClipBackgroundLine(unit.clip, project, width, height, fps)}${videoLabel(index)}`)
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
    // 带蒙版片段（含空隙的时间轴）：alphamerge 后垫黑色背景再合成。
    const unitMaskInput = maskInputs?.get(unit.clip.id)
    const unitMaskPieces =
      unitMaskInput === undefined && !unit.clip.chromaKey
        ? null
        : maskedClipPieces(unit.clip, width, height, source, false)
    if (unitMaskPieces) {
      const pre = `gmp${index}`
      const maskLabel = `gmm${index}`
      const mid = `gmd${index}`
      const fg = `gmf${index}`
      const bg = `gmg${index}`
      lines.push(`${branch}${temporal},${unitMaskPieces.prefix}[${pre}]`)
      lines.push(
        `color=c=0x000000:s=${width}x${height}:r=${fps}:d=${num(unit.duration)},format=yuv420p[${bg}]`,
      )
      if (unitMaskInput !== undefined) {
        lines.push(
          `[${unitMaskInput}:v]format=rgba,scale=${unitMaskPieces.maskWidth}:${unitMaskPieces.maskHeight}[${maskLabel}]`,
        )
        lines.push(`[${pre}][${maskLabel}]alphamerge[${mid}]`)
        lines.push(`[${mid}]${unitMaskPieces.suffix}[${fg}]`)
      } else {
        lines.push(`[${pre}]${unitMaskPieces.suffix}[${fg}]`)
      }
      lines.push(`[${bg}][${fg}]overlay=0:0:format=auto,format=yuv420p${videoLabel(index)}`)
      return
    }
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
    if (input === undefined || input < 0 || !registry.inputs[input].hasAudio) return
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
      emitAudio(lines, unit.clip, sourceLabel, audioLabelFor(index))
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
  maskInputs?: ReadonlyMap<string, number>,
): ExportPlan {
  const baseProject: Project = { ...project, overlayTracks: [] }
  const basePlan =
    project.clips.length > 0 ? buildFlatExportPlan(baseProject, sources, sourceHasAudio, maskInputs) : null
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
      // 素材被移除的叠加片段不参与合成（叠加层没有「画布背景」的概念，直接跳过）。
      if (isClipSourceMissing(sources, segment.clip)) continue
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
      // 带蒙版的叠加轨片段：crop/flip 后 alphamerge，再继续原有的旋转/缩放/透明度链
      //（叠加轨本来就带 alpha，不需要额外垫背景）。
      const overlayMaskInput = maskInputs?.get(unit.clip.id)
      const overlayMaskPieces =
        overlayMaskInput === undefined && !unit.clip.chromaKey
          ? null
          : maskedClipPieces(unit.clip, width, height, unit.source, true)
      if (overlayMaskPieces) {
        const pre = `omp${index}`
        const maskLabel = `omm${index}`
        const mid = `omd${index}`
        lines.push(`${branch}${temporal},${overlayMaskPieces.prefix}[${pre}]`)
        if (overlayMaskInput !== undefined) {
          lines.push(
            `[${overlayMaskInput}:v]format=rgba,scale=${overlayMaskPieces.maskWidth}:${overlayMaskPieces.maskHeight}[${maskLabel}]`,
          )
          lines.push(`[${pre}][${maskLabel}]alphamerge[${mid}]`)
          lines.push(`[${mid}]${overlayMaskPieces.suffix}${output}`)
        } else {
          lines.push(`[${pre}]${overlayMaskPieces.suffix}${output}`)
        }
        return
      }
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
  audioOnly = false,
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
      const volumeKeys = clip.anim?.volume
      if (volumeKeys && volumeKeys.length > 0) {
        // 全部关键帧为 0 时整段无声，直接跳过分支即可。
        if (track.volume * maxVolumeKeyValue(volumeKeys) <= 0.0001) continue
      } else if (gain <= 0.0001) {
        continue
      }
      const source = resolveSource(clip.sourceUrl)
      if (!source) continue
      if (audioOnly && (source.kind === 'image' || source.hasAudio === false)) continue
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
      ]
      if (volumeKeys && volumeKeys.length > 0) {
        // volume 在 adelay 之前：t 从 atrim 后的 0 开始，是片段本地时间；
        // 轨道 gain 乘进表达式，因为这条分支没有第二次 volume 滤镜。
        const expression = buildVolumeExpression(volumeKeys, duration, {
          scale: track.volume,
        })
        if (expression) filters.push(`volume='${expression}':eval=frame`)
      } else {
        filters.push(`volume=${num(gain)}`)
      }
      // 淡入淡出在音量曲线之后叠加（顺序不可反）。
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
      const volumeKeys = clip.anim?.volume
      if (volumeKeys && volumeKeys.length > 0) {
        if (maxVolumeKeyValue(volumeKeys) <= 0.0001) continue
      } else if (gain <= 0.0001) {
        continue
      }
      const source = resolveSource(clip.sourceUrl)
      if (!source) continue
      if (audioOnly && (source.kind === 'image' || source.hasAudio === false)) continue
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
      ]
      if (volumeKeys && volumeKeys.length > 0) {
        // 同样在 adelay 之前，t = 片段本地时间；叠加轨没有轨道级增益。
        const expression = buildVolumeExpression(volumeKeys, duration)
        if (expression) filters.push(`volume='${expression}':eval=frame`)
      } else {
        filters.push(`volume=${num(gain)}`)
      }
      // 音量曲线在前，淡入淡出在后。
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
  const appendPart = (part: string): void => {
    graph = graph.length > 0 ? `${graph};\n${part}` : part
  }
  let mainLabel: string | null = plan.audioLabel ? `[${plan.audioLabel}]` : null
  if (mainLabel === '[outa]') {
    const at = graph.lastIndexOf('[outa]')
    if (at >= 0) {
      graph = `${graph.slice(0, at)}[maina]${graph.slice(at + 6)}`
      mainLabel = '[maina]'
    }
  }
  if (!mainLabel) {
    appendPart(
      `anullsrc=r=48000:cl=stereo,atrim=duration=${num(totalDuration)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[maina]`,
    )
    mainLabel = '[maina]'
  }

  const branchInputs = branches.map((_, index) => `[ac${index}]`).join('')
  appendPart(branches.join(';\n'))
  appendPart(
    `${mainLabel}${branchInputs}amix=inputs=${branches.length + 1}:duration=longest:dropout_transition=0:normalize=0[amix]`,
  )
  appendPart(`[amix]apad=whole_dur=${num(totalDuration)},atrim=duration=${num(totalDuration)}[outa]`)

  let videoLabel = plan.videoLabel
  if (!audioOnly && totalDuration > plan.totalDuration + 0.001) {
    appendPart(
      `[${videoLabel}]tpad=stop_mode=add:stop_duration=${num(totalDuration - plan.totalDuration)}:color=black[outvpad]`,
    )
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
      // 区间导出时各片段仍按完整时间轴取帧，所以循环时长要用裁剪前的完整时长。
      args.push('-loop', '1', '-t', num(Math.max(1, plan.fullDuration ?? plan.totalDuration)))
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

/**
 * 仅音频导出的 FFmpeg 参数。不复用 MP4 参数里的视频映射/编码器，
 * 只 map 音频版 plan 的最终标签。
 */
export function buildAudioExportArgs(
  plan: ExportPlan,
  graphName: string,
  outputName: string,
  format: AudioExportFormat,
): string[] {
  if (!plan.audioLabel) throw new Error('工程没有可导出的音频。')
  const args: string[] = []
  for (const input of plan.inputs) args.push('-i', input.file)
  args.push(
    '-filter_complex_script',
    graphName,
    '-map',
    `[${plan.audioLabel}]`,
    '-vn',
    '-t',
    num(plan.totalDuration),
  )
  if (format === 'm4a') {
    args.push('-c:a', 'aac', '-b:a', '192k')
  } else {
    args.push('-c:a', 'libmp3lame', '-b:a', '192k')
  }
  args.push('-ar', '48000', '-ac', '2', outputName)
  return args
}

/**
 * 导出时的**输入序号布局**：媒体输入 → 蒙版 PNG → 文字层 PNG → 封面 PNG。
 *
 * 这几类额外输入是依次追加的，任何一处用了错误的基数都会让 `[N:v]` 指到别的图上
 * （典型症状：有蒙版时字幕层读到了蒙版 PNG）。集中在这里算一次，两边共用。
 */
export interface ExportInputLayout {
  /** 媒体输入数量（= plan.inputs.length）。 */
  mediaInputs: number
  /** 蒙版 PNG 数量。 */
  maskInputs: number
  /** 文字层 PNG 的输入序号（媒体 + 蒙版之后）。 */
  textInputBase: number
  /** 封面 PNG 的输入序号（文字层之后）。 */
  coverInputIndex: number
}

export function exportInputLayout(
  mediaInputs: number,
  maskInputs: number,
  hasTextLayer: boolean,
): ExportInputLayout {
  const media = Math.max(0, Math.round(mediaInputs))
  const masks = Math.max(0, Math.round(maskInputs))
  const textInputBase = media + masks
  return {
    mediaInputs: media,
    maskInputs: masks,
    textInputBase,
    coverInputIndex: textInputBase + (hasTextLayer ? 1 : 0),
  }
}

/**
 * 把文字层叠进视频分支：文字层是**一路 RGBA 图序列输入**，按项目 fps 重采样后
 * 在 0:0 只叠加一次（而不是每个片段一个输入 + 一次 overlay）。
 *
 * `inputIndex` 必须是文字层 PNG 的真实输入序号（见 {@link exportInputLayout}）。
 */
export function applyTextOverlayGraph(plan: ExportPlan, inputIndex: number): void {
  const original = plan.graph
  const marker = `[${plan.videoLabel}]`
  const at = original.lastIndexOf(marker)
  if (at < 0) return
  const base = `${plan.videoLabel}_textbase`
  const graph =
    `${original.slice(0, at)}[${base}]${original.slice(at + marker.length)}` +
    `;\n[${inputIndex}:v]format=rgba,fps=${plan.fps},setpts=PTS-STARTPTS[textlayer]` +
    `;\n[${base}][textlayer]overlay=0:0:eof_action=pass:format=auto[${plan.videoLabel}]`
  plan.graph = graph
}