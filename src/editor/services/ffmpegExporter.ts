import type { FFmpeg, LogEvent, ProgressEvent } from '@ffmpeg/ffmpeg'
import {
  applyExportRangeTrim,
  applyTextOverlayGraph,
  buildAudioExportArgs,
  buildAudioExportPlan,
  buildExportArgs,
  buildExportPlan,
  exportInputLayout,
  getExportCrf,
  type AudioExportFormat,
} from '../core/exportPlan'
import type { ExportRange } from '../core/exportRange'
import { drawTextClip } from '../core/textRender'
import { buildCoverJpeg, buildCoverPng, coverFrameSeconds } from '../core/cover'
import { animationFrameCount, animatedClips, bakeAnimatedClip, hasAnyAnimation } from '../core/animationExport'
import { hasAnimation } from '../core/animation'
import {
  TEXT_ANIMATION_CHUNK_FRAMES,
  buildTextOverlayRenderSegments,
  hasAnyTextAnimation,
  resolveTextOverrides,
} from '../core/textAnimation'
import {
  createAnimationSourcePool,
  renderAnimatedClipToFile,
  type AnimationSourcePool,
} from './animationRenderer'
import { ExportResources, isAudioRelatedFailure } from './exportResources'
import {
  PROBE_OUTPUT,
  acquireRuntime,
  createAbortError,
  execOnRuntime,
  fallbackToSingleThread,
  getRuntimeCapabilities,
  isGenerationCurrent,
  isMp3EncoderAvailable,
  probeRuntimeForAudio,
  probeRuntimeForExport,
  terminateRuntime,
  type RuntimeHandle,
  type RuntimeMode,
} from './ffmpegRuntime'

/**
 * 运行时相关能力的对外入口仍然从这里导出（历史调用点不用改）：
 * 真正的实现在 `services/ffmpegRuntime.ts`（队列 + 代次 + 超时/取消）。
 */
export {
  configureFFmpegAssets,
  getRuntimeCapabilities,
  isMp3EncoderAvailable,
  loadExecRuntime,
  loadFFmpegRuntime,
  terminateFFmpegRuntime,
} from './ffmpegRuntime'
export type { RuntimeCapabilities, RuntimeMode } from './ffmpegRuntime'
import { clipTimelineDuration } from '../core/clipTime'
import { drawMaskShape } from '../core/mask'
import { computeClipGeometry } from '../core/geometry'
import { findSegmentAt } from '../core/timeline'
import { resolveCaptionStyle, textClipDuration } from '../core/text'
import { buildTextOverlayTimeline } from '../core/textOverlay'
import type { CaptionStyle, Clip, Project, SourceInfo, TextClip } from '../core/types'

export interface ExportResult {
  blob: Blob
  mode: RuntimeMode
  warning?: string
  width: number
  height: number
  fps: number
  hasAudio: boolean
  /** mode=separate 时单独产出的封面 JPEG（未设置封面或 first-frame 模式为 undefined）。 */
  cover?: Blob
}

/** 单个动画字幕分块编码的硬超时（2 分钟）：超时由运行时层直接 terminate 重启。 */
const ANIMATED_TEXT_CHUNK_TIMEOUT_MS = 120_000

/** 导出阶段：加载核心 → 写入素材 → 编码 → 收尾。 */
export type ExportStage =
  | 'loading-core'
  | 'rendering-animations'
  | 'writing-inputs'
  | 'rendering'
  | 'finalizing'

export interface ExportCallbacks {
  onStatus?: (message: string) => void
  onProgress?: (progress: number) => void
  onLog?: (line: string) => void
  /** 阶段变化（用于进度条分阶段展示文案）。 */
  onStage?: (stage: ExportStage) => void
}

export interface ExportOptions {
  /** 取消导出：abort 后终止 wasm 运行时并抛出 AbortError。 */
  signal?: AbortSignal
  /** 默认 mp4；m4a / mp3 为仅音频导出。 */
  format?: ExportFormat
  /** 只导出该时间区间（入点 / 出点，秒）；缺省导出整条时间轴。 */
  range?: ExportRange | null
}

/** 导出封装格式。 */
export type ExportFormat = 'mp4' | AudioExportFormat

let activeExportSignal: AbortSignal | null = null

/**
 * 取消导出：立刻终止共享运行时（它是唯一能打断卡住的 wasm exec 的办法）。
 * 代次会 +1，正在跑的倒放 / ASR 会收到明确的「运行时已重启，请重试」并自动重做一次，
 * 而不是看到一个不明失败。
 */
function abortExport(): never {
  terminateRuntime('导出取消')
  throw createAbortError()
}

/** 阶段边界处的取消检查（加载/写入阶段没有 progress 事件，只能主动检查）。 */
function throwIfAborted(signal: AbortSignal | null): void {
  if (!signal?.aborted) return
  abortExport()
}

/**
 * 让不可中断的异步步骤（加载核心、写文件、读结果）也能被 signal 打断：
 * 取消时立即以 AbortError reject，并终止运行时（worker 卡住时只能这样）。
 */
function raceWithAbort<T>(task: Promise<T>, signal: AbortSignal | null): Promise<T> {
  if (!signal) return task
  if (signal.aborted) {
    abortExport()
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      terminateRuntime('导出取消')
      reject(createAbortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    task.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}


async function readSource(source: SourceInfo): Promise<Uint8Array> {
  if (source.file) {
    return new Uint8Array(await source.file.arrayBuffer())
  }
  const response = await fetch(source.url)
  if (!response.ok) throw new Error(`无法读取视频素材「${source.name}」（HTTP ${response.status}）。`)
  const blob = await response.blob()
  return new Uint8Array(await blob.arrayBuffer())
}

interface ResolvedInput {
  file: string
  source: SourceInfo
}

interface TextOverlayAsset {
  file: string
  data: Uint8Array
}

interface TextOverlayLayer {
  /** One full-frame PNG per timeline interval, in timeline order. */
  assets: TextOverlayAsset[]
  /** Concat demuxer list file name in the FFmpeg virtual file system. */
  listFile: string
  /** Concat demuxer list contents. */
  listContent: string
  /** Index of the text input in the `-i` order (after all media inputs). */
  inputIndex: number
  /** 动画文本已经把中间片段/list 直接写进 FFmpeg 虚拟文件系统。 */
  prewritten?: boolean
  /** 动画文本的中间片段等额外清理项。 */
  cleanupFiles?: string[]
}

/**
 * Renders the whole text layer as a single image sequence: every "display
 * state change" interval becomes one full-frame PNG (blank intervals become a
 * transparent PNG so all files share the same resolution / pixel format), and
 * a concat demuxer list stitches them into one input stream.
 */
async function renderTextOverlayLayer(
  project: Project,
  width: number,
  height: number,
  totalDuration: number,
  inputIndex: number,
): Promise<TextOverlayLayer | null> {
  const intervals = buildTextOverlayTimeline(project, { duration: totalDuration })
  if (intervals.length === 0) return null
  const styleByClipId = new Map<string, CaptionStyle>()
  for (const track of project.textTracks ?? []) {
    if (!track.captionStyle) continue
    for (const clip of track.clips) styleByClipId.set(clip.id, track.captionStyle)
  }
  const assets: TextOverlayAsset[] = []
  const list: string[] = ['ffconcat version 1.0']
  for (let index = 0; index < intervals.length; index += 1) {
    const interval = intervals[index]
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建字幕渲染画布。')
    for (const clip of interval.clips) {
      if (clip.link?.linkHidden) continue
      drawTextClip(context, resolveCaptionStyle(clip, styleByClipId.get(clip.id)), width, height)
    }
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((result) => resolve(result), 'image/png'),
    )
    if (!blob) throw new Error('字幕图像渲染失败。')
    const file = `text-interval-${index}.png`
    assets.push({ file, data: new Uint8Array(await blob.arrayBuffer()) })
    list.push(`file '${file}'`, `duration ${(interval.end - interval.start).toFixed(6)}`)
  }
  // The concat demuxer ignores the final entry's duration, so the last file is
  // listed a second time without a duration to terminate the stream.
  const lastFile = assets[assets.length - 1]?.file
  if (!lastFile) return null
  list.push(`file '${lastFile}'`)
  return {
    assets,
    listFile: 'text-overlay-list.txt',
    listContent: `${list.join('\n')}\n`,
    inputIndex,
  }
}

/**
 * Render an animated text layer as a sequence of alpha-preserving intermediate
 * MOV clips (PNG codec) and concatenate them with the existing ffconcat demuxer.
 *
 * Why not one PNG per display state anymore: text animation makes the state
 * continuous. Per animated span we redraw every frame, but a static span still
 * renders one PNG and encodes a one-frame MOV; the concat `duration` directive
 * plus the layer's `fps` filter repeat it for that span. A long static caption
 * therefore never produces hundreds of identical PNGs. Frames are drawn on one
 * full-canvas offscreen canvas in the same order as the existing static layer,
 * preserving text z-order.
 *
 * Every `TEXT_ANIMATION_CHUNK_FRAMES` frames become one MOV segment; the PNGs
 * for that batch are deleted immediately after encoding. Static spans become one
 * one-frame segment plus a concat duration. All segments are concatenated so the
 * final graph still has a single text input (applyTextOverlayGraph is unchanged).
 */
async function renderAnimatedTextOverlayLayer(
  project: Project,
  width: number,
  height: number,
  totalDuration: number,
  fps: number,
  inputIndex: number,
  runtime: RuntimeHandle,
  signal: AbortSignal | null,
  onStatus?: (message: string) => void,
): Promise<TextOverlayLayer | null> {
  const ffmpeg = runtime.ffmpeg
  const intervals = buildTextOverlayTimeline(project, { duration: totalDuration })
  if (intervals.length === 0) return null
  const segments = buildTextOverlayRenderSegments(intervals, totalDuration, fps)
  if (segments.length === 0) return null

  const styleByClipId = new Map<string, TextClip>()
  for (const track of project.textTracks ?? []) {
    for (const clip of track.clips) {
      styleByClipId.set(clip.id, resolveCaptionStyle(clip, track.captionStyle))
    }
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建动画字幕渲染画布。')

  const concat: string[] = ['ffconcat version 1.0']
  const cleanupFiles: string[] = []
  const temporaryPngs = new Set<string>()
  let segmentIndex = 0
  /** 最后一个静态片段的 chunk；concat 的最后一个 duration 会被忽略，需要重复一次。 */
  let lastStaticChunk: string | null = null

  const drawFrame = (clips: TextClip[], timeSeconds: number, animated: boolean): void => {
    context.clearRect(0, 0, width, height)
    for (const clip of clips) {
      const style = styleByClipId.get(clip.id)
      if (!style) continue
      if (animated) {
        const local = Math.max(
          0,
          Math.min(textClipDuration(clip), timeSeconds - clip.start),
        )
        drawTextClip(
          context,
          style,
          width,
          height,
          resolveTextOverrides(clip, local, style),
        )
      } else {
        drawTextClip(context, style, width, height)
      }
    }
  }

  const canvasPng = async (): Promise<Uint8Array> => {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((result) => resolve(result), 'image/png'),
    )
    if (!blob) throw new Error('动画字幕帧渲染失败。')
    return new Uint8Array(await blob.arrayBuffer())
  }

  const encodeChunk = async (args: string[], chunkFile: string): Promise<void> => {
    throwIfAborted(signal)
    const code = await execOnRuntime(runtime, ['-hide_banner', '-y', ...args, chunkFile], {
      signal,
      timeoutMs: ANIMATED_TEXT_CHUNK_TIMEOUT_MS,
    })
    if (code !== 0) {
      throw new Error(`动画字幕中间片段编码失败（退出码 ${code}）。`)
    }
  }

  const deleteFiles = async (files: Iterable<string>): Promise<void> => {
    for (const file of files) {
      try {
        await ffmpeg.deleteFile(file)
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  try {
    for (const segment of segments) {
      throwIfAborted(signal)
      const safeFps = Math.max(1, fps)
      if (!segment.animated) {
        // Static state: one PNG → one-frame MOV, duration supplied by concat.
        const png = `text-static-${segmentIndex}.png`
        const chunk = `text-static-${segmentIndex}.mov`
        segmentIndex += 1
        drawFrame(
          segment.clips,
          segment.start + segment.frames / (2 * safeFps),
          false,
        )
        await ffmpeg.writeFile(png, await canvasPng())
        temporaryPngs.add(png)
        try {
          // 只编码 1 帧；时长由 concat 的 duration 指令给出，最终图里的 fps 滤镜
          // 负责把这一帧复制到整个静态区间。这样静态字幕仍只渲染 1 张 PNG。
          await encodeChunk(
            [
              '-loop',
              '1',
              '-framerate',
              String(safeFps),
              '-i',
              png,
              '-frames:v',
              '1',
              '-r',
              String(safeFps),
              '-video_track_timescale',
              '90000',
              '-c:v',
              'png',
              '-pix_fmt',
              'rgba',
              '-an',
            ],
            chunk,
          )
        } finally {
          temporaryPngs.delete(png)
          await deleteFiles([png])
        }
        concat.push(
          `file '${chunk}'`,
          `duration ${(segment.frames / safeFps).toFixed(6)}`,
        )
        cleanupFiles.push(chunk)
        lastStaticChunk = chunk
        continue
      }

      onStatus?.(
        `正在渲染动画字幕（${segment.start.toFixed(1)}–${segment.end.toFixed(1)}s）…`,
      )
      lastStaticChunk = null
      let frame = segment.startFrame
      while (frame < segment.endFrame) {
        const batchStart = frame
        const batchCount = Math.min(
          TEXT_ANIMATION_CHUNK_FRAMES,
          segment.endFrame - frame,
        )
        const prefix = `text-anim-${segmentIndex}-${batchStart}-`
        const chunk = `text-anim-${segmentIndex}-${batchStart}.mov`
        const pngs: string[] = []
        for (let index = 0; index < batchCount; index += 1) {
          throwIfAborted(signal)
          drawFrame(segment.clips, (batchStart + index) / safeFps, true)
          const png = `${prefix}${String(index).padStart(5, '0')}.png`
          await ffmpeg.writeFile(png, await canvasPng())
          pngs.push(png)
          temporaryPngs.add(png)
        }
        try {
          await encodeChunk(
            [
              '-framerate',
              String(safeFps),
              '-start_number',
              '0',
              '-i',
              `${prefix}%05d.png`,
              '-frames:v',
              String(batchCount),
              '-r',
              String(safeFps),
              '-video_track_timescale',
              '90000',
              '-c:v',
              'png',
              '-pix_fmt',
              'rgba',
              '-an',
            ],
            chunk,
          )
        } finally {
          for (const png of pngs) temporaryPngs.delete(png)
          await deleteFiles(pngs)
        }
        concat.push(`file '${chunk}'`)
        cleanupFiles.push(chunk)
        frame += batchCount
      }
      segmentIndex += 1
    }

    const listFile = 'text-overlay-list.txt'
    // concat demuxer 忽略最后一条 duration；若末尾是静态片段，重复一次让
    // 上一个 duration 生效（与原来的静态 PNG 序列做法一致）。
    if (lastStaticChunk) concat.push(`file '${lastStaticChunk}'`)
    const listContent = `${concat.join('\n')}\n`
    await ffmpeg.writeFile(listFile, listContent)
    cleanupFiles.push(listFile)
    return {
      assets: [],
      listFile,
      listContent,
      inputIndex,
      prewritten: true,
      cleanupFiles,
    }
  } catch (error) {
    await deleteFiles([...temporaryPngs, ...cleanupFiles])
    throw error
  }
}

/**
 * 动画片段预处理：逐帧渲染 → 分块编码中间视频 → 把片段的 sourceUrl 换成中间文件。
 *
 * 逐片段独立进行，渲染完一个片段的帧文件立刻删除（renderer 内部按块删），
 * 只把最终的 File 留在内存里作为导出输入。
 *
 * 源文件「同一源只写一份」：整个流程共用同一个 {@link AnimationSourcePool}，结束后统一删除。
 *
 * 取舍（重要）：几何/不透明度/调色/动画全部烘焙进中间视频，因此 exportPlan 不需要任何改动；
 * 代价是该片段多了一次 H.264 重编码（crf 18 / veryfast）。
 * 叠加轨片段用「背景烘焙」代替真透明（libx264 的 yuva420p 兼容性太差）：
 * 该片段下方如果还有动态画面，中间视频里的背景会盖住它。
 */
async function prepareAnimatedProject(
  args: PrepareAnimatedProjectArgs,
): Promise<{ project: Project; sources: SourceInfo[]; urls: string[] } | null> {
  const sourcePool = createAnimationSourcePool()
  try {
    return await prepareAnimatedProjectInner(args, sourcePool)
  } finally {
    await sourcePool.dispose(args.runtime)
  }
}

interface PrepareAnimatedProjectArgs {
  project: Project
  assets: SourceInfo[]
  width: number
  height: number
  fps: number
  /** 导出持有的运行时句柄（带代次）：渲染器的 exec 走它的队列，超时/取消会重启。 */
  runtime: RuntimeHandle
  signal: AbortSignal | null
  /** 清理器：中间视频的 objectURL 一创建就登记，中途失败/取消也不会泄漏。 */
  resources: ExportResources
  onStage?: (stage: ExportStage) => void
  onStatus?: (message: string) => void
  onProgress?: (progress: number) => void
}

async function prepareAnimatedProjectInner(
  args: PrepareAnimatedProjectArgs,
  sourcePool: AnimationSourcePool,
): Promise<{ project: Project; sources: SourceInfo[]; urls: string[] } | null> {
  const { project, assets, width, height, fps, runtime, signal, resources, onStage, onStatus, onProgress } = args
  const refs = animatedClips(project)
  if (refs.length === 0) return null
  onStage?.('rendering-animations')

  const replacements = new Map<string, { clip: Clip; source: SourceInfo }>()
  const urls: string[] = []
  let current = 0

  for (let index = 0; index < refs.length; index += 1) {
    const ref = refs[index]
    throwIfAborted(signal)
    const asset = assets.find((item) => item.url === ref.clip.sourceUrl)
    if (!asset) continue
    // 叠加轨片段的中间视频没有 alpha：若该时刻下方的主轨片段本身没有动画，
    // 就把它一起烘进来，合成结果才与预览一致；主轨片段自己也有动画时不做（避免重复烘焙）。
    let underlay: { clip: Clip; asset: SourceInfo } | undefined
    if (ref.trackId !== null) {
      const segment = findSegmentAt(project.clips, ref.start)
      const baseClip = segment?.clip ?? null
      if (baseClip && !hasAnimation(baseClip)) {
        const baseAsset = assets.find((item) => item.url === baseClip.sourceUrl)
        if (baseAsset) underlay = { clip: baseClip, asset: baseAsset }
      }
    }
    const total = animationFrameCount(ref.clip, fps)
    onStatus?.(
      `正在渲染动画片段 ${index + 1}/${refs.length}（${total} 帧）`,
    )
    const file = await renderAnimatedClipToFile({
      clip: ref.clip,
      asset,
      trackId: ref.trackId,
      project,
      width,
      height,
      fps,
      index,
      runtime,
      sources: sourcePool,
      signal,
      underlay,
      onFrame: (done) => {
        current = done
        onProgress?.(Math.min(0.99, (index + done / total) / refs.length))
      },
    })
    const url = URL.createObjectURL(file)
    // 立刻登记：即使下一轮渲染抛错/取消，这个 URL 也会在 finally 里被回收。
    resources.registerUrl(url)
    urls.push(url)
    const duration = clipTimelineDuration(ref.clip)
    const source: SourceInfo = {
      url,
      name: file.name,
      size: file.size,
      duration,
      width: Math.max(2, Math.round(width / 2) * 2),
      height: Math.max(2, Math.round(height / 2) * 2),
      kind: 'video',
      file,
      // 中间视频带一条音轨（原声或静音），因此就是「有音频」的输入。
      hasAudio: true,
    }
    // 几何/不透明度/调色/动画已经烘焙进中间视频：重置为普通素材（见 bakeAnimatedClip）。
    const baked: Clip = bakeAnimatedClip(ref.clip, url, duration)
    replacements.set(ref.clip.id, { clip: baked, source })
  }

  if (replacements.size === 0) return null
  void current

  const applyClip = (clip: Clip): Clip => replacements.get(clip.id)?.clip ?? clip
  const nextProject: Project = {
    ...project,
    clips: project.clips.map(applyClip),
    overlayTracks: project.overlayTracks?.map((track) => ({
      ...track,
      clips: track.clips.map(applyClip),
    })),
  }
  return {
    project: nextProject,
    sources: [...replacements.values()].map((item) => item.source),
    urls,
  }
}

/**
 * 把封面 PNG 作为「额外一路输入」接到 `plan.videoLabel` 上，只覆盖首帧。
 *
 * 必须**在区间 trim 之后**调用：此时 overlay 的 t=0 就是导出段的第一帧，
 * 所以「区间 3–8 秒 + 首帧封面」导出的第一帧仍然是封面（而不是被 trim 掉）。
 * 与文本层一致：先改名最终标签，再追加 overlay，因此对三条构建路径同时生效。
 */
export function applyCoverOverlayGraph(
  plan: ReturnType<typeof buildExportPlan>,
  inputIndex: number,
): void {
  const original = plan.graph
  const marker = `[${plan.videoLabel}]`
  const at = original.lastIndexOf(marker)
  if (at < 0) return
  const base = `${plan.videoLabel}_coverbase`
  const hold = coverFrameSeconds(plan.fps)
  plan.graph =
    `${original.slice(0, at)}[${base}]${original.slice(at + marker.length)}` +
    `;
[${inputIndex}:v]format=rgba,fps=${plan.fps},setpts=PTS-STARTPTS[coverpng]` +
    `;
[${base}][coverpng]overlay=0:0:eof_action=pass:format=auto:enable='between(t,0,${hold.toFixed(6)})'[${plan.videoLabel}]`
}

/**
 * 工程里所有带蒙版、且会出现在画面上的片段（主轨 + 叠加轨，按出现顺序去重）。
 *
 * `availableUrls`：只保留素材仍在导出源里的片段。素材被「仅从素材库移除」后，
 * 片段仍留在时间轴（显示为占位），但已经没有可渲染的画面 —— 这种片段的蒙版
 * **不能**收进来：蒙版 PNG 渲不出来，后面的「文件数 != 片段数」校验会把整次导出
 * 硬判成「蒙版渲染失败」，而其它所有路径对缺失素材都是降级为画布背景。
 */
export function maskedClips(
  project: Project,
  availableUrls?: ReadonlySet<string>,
): Clip[] {
  const out: Clip[] = []
  const usable = (clip: Clip): boolean =>
    Boolean(clip.mask) && (!availableUrls || availableUrls.has(clip.sourceUrl))
  for (const clip of project.clips) if (usable(clip)) out.push(clip)
  for (const track of project.overlayTracks ?? []) {
    for (const clip of track.clips) if (usable(clip)) out.push(clip)
  }
  return out
}

/**
 * 把每个带蒙版片段的蒙版渲染成灰度 PNG（尺寸 = 该片段的裁切尺寸），
 * 写进 FFmpeg 虚拟文件系统，供滤镜链里的 alphamerge 使用。
 * 与预览共用 core/mask.drawMaskShape，保证形状/羽化逐像素一致。
 */
/** 蒙版 PNG 在共享 MEMFS 里的文件名（清理时也用它，避免两处拼串不一致）。 */
export function maskFileName(clipId: string): string {
  return `framecut-mask-${clipId}.png`
}

async function writeMaskFiles(
  ffmpeg: FFmpeg,
  clips: readonly Clip[],
  sources: readonly SourceInfo[],
  width: number,
  height: number,
  /** 每写入一个蒙版就登记，保证中途失败时已写的也能被清理。 */
  register?: (file: string) => void,
): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  for (const clip of clips) {
    if (!clip.mask) continue
    const source = sources.find((item) => item.url === clip.sourceUrl)
    if (!source) continue
    const geometry = computeClipGeometry(clip, source, width, height)
    const maskWidth = Math.max(1, Math.round(geometry.source.w))
    const maskHeight = Math.max(1, Math.round(geometry.source.h))
    const canvas = document.createElement('canvas')
    canvas.width = maskWidth
    canvas.height = maskHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) continue
    drawMaskShape(ctx, maskWidth, maskHeight, clip.mask, (w, h) => {
      const off = document.createElement('canvas')
      off.width = Math.max(1, Math.round(w))
      off.height = Math.max(1, Math.round(h))
      const inner = off.getContext('2d')
      return inner ? { canvas: off, ctx: inner } : null
    })
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((result) => resolve(result), 'image/png'),
    )
    if (!blob) continue
    const file = maskFileName(clip.id)
    await ffmpeg.writeFile(file, new Uint8Array(await blob.arrayBuffer()))
    register?.(file)
    files.set(clip.id, file)
  }
  return files
}

/** 把蒙版 PNG 作为额外输入插到文字层之前（编号随之整体后移）。 */
export function injectMaskInputArgs(args: string[], files: readonly string[]): string[] {
  if (files.length === 0) return args
  const at = args.indexOf('-filter_complex_script')
  if (at < 0) return args
  const injected: string[] = []
  for (const file of files) injected.push('-loop', '1', '-i', file)
  return [...args.slice(0, at), ...injected, ...args.slice(at)]
}

export function injectTextInputArgs(args: string[], layer: TextOverlayLayer | null): string[] {
  if (!layer) return args
  const at = args.indexOf('-filter_complex_script')
  if (at < 0) return args
  return [
    ...args.slice(0, at),
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    layer.listFile,
    ...args.slice(at),
  ]
}

/**
 * 把封面 PNG 追加为最后一路输入（在文本层输入之后，因为封面盖在字幕之上）。
 * 与文本层同样插在 `-filter_complex_script` 之前，保证输入序号与 graph 里的一致。
 */
export function injectCoverInputArgs(args: string[], coverFile: string | null): string[] {
  if (!coverFile) return args
  const at = args.indexOf('-filter_complex_script')
  if (at < 0) return args
  return [...args.slice(0, at), '-i', coverFile, ...args.slice(at)]
}

/**
 * 一次导出里所有「额外输入」的最终顺序：**媒体 → 蒙版 → 文字层 → 封面**。
 *
 * 这个顺序必须与 {@link exportInputLayout} 的编号公式完全一致，否则 graph 里
 * `[n:v]` 指向的就不是它以为的那一路。三个注入函数都是「插到
 * `-filter_complex_script` 之前」，因此**后调用者排在更后面** —— 很容易写反。
 *
 * 为什么单独抽出来：写反过一次（先文字后蒙版），后果不是报错，而是
 * 「带蒙版的片段几乎整块消失 + 整屏被最后一张蒙版 PNG 盖住」这种**静默画面全毁**，
 * 靠人工看导出结果很难定位。抽成纯函数后由单测直接锁住顺序。
 */
export function buildExportInputArgs(
  plan: Parameters<typeof buildExportArgs>[0],
  graphName: string,
  outputName: string,
  options: {
    maskInputOrder: readonly string[]
    textLayer: TextOverlayLayer | null
    coverFile: string | null
  },
): string[] {
  const withMasks = injectMaskInputArgs(
    buildExportArgs(plan, graphName, outputName),
    options.maskInputOrder,
  )
  const withText = injectTextInputArgs(withMasks, options.textLayer)
  return injectCoverInputArgs(withText, options.coverFile)
}

async function writeInputs(
  ffmpeg: FFmpeg,
  inputs: ResolvedInput[],
  onStatus?: (message: string) => void,
  onProgress?: (progress: number) => void,
  signal: AbortSignal | null = null,
): Promise<void> {
  for (let index = 0; index < inputs.length; index += 1) {
    throwIfAborted(signal)
    const input = inputs[index]
    onStatus?.(`正在读取素材 ${index + 1}/${inputs.length}「${input.source.name}」…`)
    const data = await readSource(input.source)
    throwIfAborted(signal)
    await raceWithAbort(ffmpeg.writeFile(input.file, data), signal)
    onProgress?.(0)
  }
}

async function writeTextOverlayLayer(
  ffmpeg: FFmpeg,
  layer: TextOverlayLayer | null,
): Promise<void> {
  if (!layer || layer.prewritten) return
  for (const asset of layer.assets) {
    await ffmpeg.writeFile(asset.file, asset.data)
  }
  await ffmpeg.writeFile(layer.listFile, layer.listContent)
}

function logTail(lines: string[]): string {
  return lines.slice(-10).join('\n')
}

/**
 * 在**导出自己持有的运行时句柄**上执行一次编码命令（不能重新 acquire：那可能拿到
 * 新实例，之前写入的 MEMFS 文件就不在了）。超时/取消由运行时层统一处理（立即重启）。
 */
async function runExportCommand(
  runtime: RuntimeHandle,
  args: string[],
  outputName: string,
  lines: string[],
  signal: AbortSignal | null = null,
): Promise<void> {
  if (isGenerationCurrent(runtime.generation)) {
    try {
      await runtime.ffmpeg.deleteFile(outputName)
    } catch {
      // Output may not exist yet.
    }
  }
  throwIfAborted(signal)
  const code = await execOnRuntime(runtime, args, { signal })
  if (code !== 0) {
    throw new Error(`FFmpeg 合成失败（退出码 ${code}）。\n${logTail(lines)}`)
  }
}

/**
 * Export a project. `assets` maps `Clip.sourceUrl` to a concrete source so
 * every clip is written to its own FFmpeg input. Passing callbacks as the
 * third argument keeps the previous single-source API working.
 */
export async function exportProject(
  project: Project,
  source: SourceInfo,
  assetsOrCallbacks?: SourceInfo[] | ExportCallbacks,
  callbacks: ExportCallbacks = {},
  options: ExportOptions = {},
): Promise<ExportResult> {
  const assets = Array.isArray(assetsOrCallbacks) ? assetsOrCallbacks : []
  const resolvedCallbacks = Array.isArray(assetsOrCallbacks)
    ? callbacks
    : (assetsOrCallbacks ?? {})
  const { onStatus, onProgress, onLog, onStage } = resolvedCallbacks
  const signal = options.signal ?? null
  const format = options.format ?? 'mp4'
  const audioOnly = format !== 'mp4'
  // 区间导出：plan 里记录入/出点（totalDuration 变成区间时长），
  // trim 在文字 / 封面层合成之后由 applyExportRangeTrim 追加。
  const range = options.range ?? null
  activeExportSignal = signal

  // 从这一刻起就可能创建 objectURL / 往共享 MEMFS 写文件，失败或取消都必须回收。
  const resources = new ExportResources()
  /** 清理时用「当前」实例：多线程降级后旧 worker 的文件系统已经不存在。 */
  let cleanupTarget: FFmpeg | null = null
  const outputExtension = format === 'mp4' ? 'mp4' : format
  const outputName = `framecut-output.${outputExtension}`
  const graphName = 'framecut-filtergraph.txt'
  const lines: string[] = []
  let attachedFfmpeg: FFmpeg | null = null
  let logHandler: ((event: LogEvent) => void) | null = null
  let progressHandler: ((event: ProgressEvent) => void) | null = null
  // 名字确定的产物先登记（删不存在的文件是安全的），避免某条分支忘了清理。
  resources.registerFiles([graphName, outputName, PROBE_OUTPUT])
  try {
    throwIfAborted(signal)

    const assetByUrl = new Map(assets.map((asset) => [asset.url, asset]))
    const primary = assetByUrl.get(source.url) ?? source
    const sources: SourceInfo[] = [primary]
    for (const asset of assets) {
      if (asset.url !== primary.url) sources.push(asset)
    }

    let plan = audioOnly
      ? buildAudioExportPlan(project, sources, true, { range })
      : buildExportPlan(project, sources, true, { range })
    if (audioOnly && !plan.audioLabel) {
      throw new Error('当前工程没有可导出的音频。')
    }
    // MP3 依赖 libmp3lame：先确认核心支持，避免生成一个坏文件。
    if (format === 'mp3' && !(await isMp3EncoderAvailable())) {
      throw new Error('当前 FFmpeg 核心不支持 MP3 编码，请改用 M4A 导出。')
    }
    const sourceByUrl = new Map(sources.map((item) => [item.url, item]))
    const resolvedInputs: ResolvedInput[] = []
    const seenFiles = new Set<string>()
    for (const input of plan.inputs) {
      if (seenFiles.has(input.file)) continue
      seenFiles.add(input.file)
      resolvedInputs.push({
        file: input.file,
        source: sourceByUrl.get(input.url) ?? primary,
      })
    }
    // 输入副本一确定就登记：即使 writeInputs 中途失败/取消，已写入的那几个也会被删掉。
    resources.registerFiles(resolvedInputs.map((input) => input.file))

    const capabilities = getRuntimeCapabilities()
    const renderTextLayer = async (
      runtime: RuntimeHandle,
      signal: AbortSignal | null,
      inputIndex: number,
    ): Promise<TextOverlayLayer | null> => {
      // 文字 PNG 层始终按**完整时间轴**生成：区间导出时它在最终 trim 之前合成，
      // 否则字幕会被区间起点平移，与预览的同一段对不上。
      const textTimelineDuration = plan.fullDuration ?? plan.totalDuration
      // 无文本动画：完全走原有「按状态变化生成 PNG」路径，零改动。
      if (!hasAnyTextAnimation(project)) {
        return renderTextOverlayLayer(
          project,
          plan.width,
          plan.height,
          textTimelineDuration,
          inputIndex,
        )
      }
      return renderAnimatedTextOverlayLayer(
        project,
        plan.width,
        plan.height,
        textTimelineDuration,
        plan.fps,
        // 必须用调用方算好的文字层输入序号（媒体 + 蒙版之后）。这里原先传的是
        // plan.inputs.length（只是媒体输入数），有蒙版时 [N:v] 会指到蒙版 PNG。
        inputIndex,
        runtime,
        signal,
        onStatus,
      )
    }
    onStage?.('loading-core')
    onStatus?.(capabilities.multiThread ? '正在加载多线程 FFmpeg…' : '正在加载 FFmpeg…')
    // 封面：first-frame 模式需要把封面渲染成 PNG 作为额外输入；separate 模式只在收尾时出图。
    const cover = audioOnly ? undefined : project.cover
    let coverPng: Uint8Array | null = null
    if (cover && cover.mode === 'first-frame') {
      coverPng = await buildCoverPng(plan.width, plan.height, cover)
    }
    const coverFileName = 'framecut-cover.png'
    resources.registerFile(coverFileName)
    // 多线程降级后输入要重新写入，封面 PNG 也按需重算。
    const renderCoverPng = async (): Promise<Uint8Array | null> =>
      cover && cover.mode === 'first-frame' ? buildCoverPng(plan.width, plan.height, cover) : null

    let loaded = await raceWithAbort(acquireRuntime({ signal }), signal)
    throwIfAborted(signal)
    let ffmpeg = loaded.ffmpeg
    cleanupTarget = ffmpeg
    let mode = loaded.mode
    let warning = loaded.warning

    // 动画片段预处理：只对带动画的片段生效；没有动画时这一步完全跳过（导出路径与原来一致）。
    // （中间视频的 objectURL 由 resources 登记回收，这里不再单独维护数组。）
    if (!audioOnly && hasAnyAnimation(project)) {
      // 关键：动画渲染要在**单线程**核心上做。多线程 core 在本环境的 exec 会挂起
      // （导出流程本来也会在自检后降级），而这一步发生在自检之前，若沿用多线程实例
      // 会卡死在图像序列编码上。这里先主动降级，代价是本次导出使用单线程编码。
      if (mode === 'multi-thread') {
        onStatus?.('动画片段需要单线程 FFmpeg 核心，正在切换…')
        loaded = await fallbackToSingleThread('动画片段渲染需要单线程 FFmpeg 核心。')
        ffmpeg = loaded.ffmpeg
        cleanupTarget = ffmpeg
        mode = loaded.mode
        warning = loaded.warning
      }
      const prepared = await prepareAnimatedProject({
        project,
        assets: [...assets],
        width: plan.width,
        height: plan.height,
        fps: plan.fps,
        runtime: loaded,
        signal,
        resources,
        onStage,
        onStatus,
        onProgress,
      })
      if (prepared) {
        project = prepared.project
        sources.push(...prepared.sources)
        plan = buildExportPlan(project, sources, true, { range })
        sourceByUrl.clear()
        for (const item of sources) sourceByUrl.set(item.url, item)
        resolvedInputs.length = 0
        seenFiles.clear()
        for (const input of plan.inputs) {
          if (seenFiles.has(input.file)) continue
          seenFiles.add(input.file)
          resolvedInputs.push({
            file: input.file,
            source: sourceByUrl.get(input.url) ?? primary,
          })
        }
        resources.registerFiles(resolvedInputs.map((input) => input.file))
      }
    }
    // 动画字幕的中间片段同样需要 exec；本环境多线程 core 的 exec 会挂起，
    // 因此在生成逐帧字幕前主动切到单线程（与视觉动画预处理一致）。
    if (!audioOnly && hasAnyTextAnimation(project) && mode === 'multi-thread') {
      onStatus?.('动画字幕需要单线程 FFmpeg 核心，正在切换…')
      loaded = await fallbackToSingleThread('动画字幕渲染需要单线程 FFmpeg 核心。')
      ffmpeg = loaded.ffmpeg
      cleanupTarget = ffmpeg
      mode = loaded.mode
      warning = loaded.warning
    }
    // ---- 形状蒙版 ----
    // 蒙版 PNG 是额外输入：序号 = 媒体输入之后、文字层与封面之前。
    // 先按「没有蒙版」构建出 plan 拿到 inputs 数量，再把序号喂回去重建 graph。
    let maskInputBase = plan.inputs.length
    let maskClipList: Clip[] = []
    let maskFileByName: Map<string, string> = new Map()
    /**
     * 蒙版片段 → 输入序号。必须活到「无声重试」那一轮：重试会重建 plan，
     * 如果这里丢了，图的蒙版分支会退化成普通 transform（蒙版静默失效、整幅画面露出），
     * 而 args 里仍然注入着蒙版输入，编号还按「媒体 + 蒙版」算，进一步错位。
     */
    let maskInputsByClip: Map<string, number> | null = null
    if (!audioOnly) {
      // 只渲染「素材仍在导出源里」的蒙版：缺失素材的蒙版渲不出来，
      // 收进来会让后面的数量校验把整次导出硬判成失败（见 maskedClips 的说明）。
      maskClipList = maskedClips(project, new Set(sources.map((item) => item.url)))
      if (maskClipList.length > 0) {
        // 蒙版 PNG 每次导出都会写一份（共享 MEMFS），必须登记清理，否则会一直累积。
        const registerMask = (file: string): void => {
          resources.registerFile(file)
        }
        for (const clip of maskClipList) registerMask(maskFileName(clip.id))
        const maskInputs = new Map(maskClipList.map((clip, index) => [clip.id, maskInputBase + index]))
        maskInputsByClip = maskInputs
        plan = buildExportPlan(project, sources, true, { range, maskInputs })
        maskFileByName = await writeMaskFiles(
          ffmpeg,
          maskClipList,
          sources,
          plan.width,
          plan.height,
          registerMask,
        )
        if (maskFileByName.size !== maskClipList.length) {
          throw new Error('蒙版渲染失败，无法导出。')
        }
      }
    }
    const maskInputOrder: string[] = maskClipList
      .map((clip) => maskFileByName.get(clip.id))
      .filter((file): file is string => Boolean(file))
    /** 文字层输入序号：媒体输入 + 蒙版输入之后（统一由 exportInputLayout 计算）。 */
    const textInputBase = exportInputLayout(maskInputBase, maskInputOrder.length, false).textInputBase
    let textLayer: TextOverlayLayer | null = audioOnly
      ? null
      : await renderTextLayer(loaded, signal, textInputBase)
    /** 文字层的 PNG / concat 列表文件都要登记清理（它们是每次导出新写进 MEMFS 的）。 */
    const registerTextLayerFiles = (layer: TextOverlayLayer | null): void => {
      if (!layer) return
      resources.registerFiles(layer.assets.map((asset) => asset.file))
      resources.registerFile(layer.listFile)
      resources.registerFiles(layer.cleanupFiles ?? [])
    }
    registerTextLayerFiles(textLayer)
    // 封面 overlay 的输入序号：媒体输入 + 蒙版输入 + 文本层（若存在）之后。
    const coverInputIndex = exportInputLayout(
      maskInputBase,
      maskInputOrder.length,
      Boolean(textLayer),
    ).coverInputIndex


      onStage?.('writing-inputs')
      onStatus?.(
        resolvedInputs.length > 1
          ? `正在读取 ${resolvedInputs.length} 个素材到本地内存…`
          : '正在读取素材到本地内存…',
      )
      await writeInputs(ffmpeg, resolvedInputs, onStatus, onProgress, signal)
      await writeTextOverlayLayer(ffmpeg, textLayer)
      if (coverPng) await ffmpeg.writeFile(coverFileName, coverPng)

      const probeInput = resolvedInputs[0]?.file
      // 音频导出也要自检：多线程核心在本环境可能直接挂起，音频输入又没有视频流，
      // 所以用与输入无关的 lavfi 自检（probeExecRuntime），视频路径则仍探测真实输入。
      if (mode === 'multi-thread' && (audioOnly || probeInput)) {
        onStatus?.('正在自检多线程 FFmpeg 核心…')
        const probe = await raceWithAbort(
          audioOnly
            ? probeRuntimeForAudio(loaded)
            : probeRuntimeForExport(probeInput as string, loaded),
          signal,
        )
        if (probe !== 'ok') {
          const reason =
            probe === 'timeout'
              ? '多线程 FFmpeg 核心自检超时，已自动降级为单线程导出。'
              : '多线程 FFmpeg 核心未能完成自检，已自动降级为单线程导出。'
          loaded = await fallbackToSingleThread(reason)
          ffmpeg = loaded.ffmpeg
          cleanupTarget = ffmpeg
          mode = loaded.mode
          warning = loaded.warning
          onStatus?.('已切换为单线程，正在重新写入素材…')
          onProgress?.(0)
          // The previous worker owns the transferred buffers, so re-read every
          // input before writing it into the new file system.
          onStage?.('writing-inputs')
          await writeInputs(ffmpeg, resolvedInputs, onStatus, onProgress, signal)
          if (maskClipList.length > 0) {
            maskFileByName = await writeMaskFiles(
              ffmpeg,
              maskClipList,
              sources,
              plan.width,
              plan.height,
              (file) => resources.registerFile(file),
            )
          }
          textLayer = await renderTextLayer(loaded, signal, textInputBase)
          registerTextLayerFiles(textLayer)
          await writeTextOverlayLayer(ffmpeg, textLayer)
          coverPng = await renderCoverPng()
          if (coverPng) await ffmpeg.writeFile(coverFileName, coverPng)
        }
      }

      logHandler = (event: LogEvent) => {
        lines.push(event.message)
        if (lines.length > 120) lines.shift()
        onLog?.(event.message)
      }
      progressHandler = (event: ProgressEvent) => {
        // 每帧检查取消信号：一旦取消立刻终止 wasm 运行时（挂起的 exec 会 reject），
        // 然后抛出 AbortError。terminateRuntime 之后不会再有 progress 事件。
        const value = Number.isFinite(event.progress) ? event.progress : 0
        onProgress?.(Math.min(1, Math.max(0, value)))
        if (activeExportSignal?.aborted) {
          abortExport()
        }
      }
      attachedFfmpeg = ffmpeg
      ffmpeg.on('log', logHandler)
      ffmpeg.on('progress', progressHandler)

      // Start optimistic: assume the used sources have audio. If a filter graph
      // references a missing audio stream, FFmpeg exits and we retry silently.
      onStatus?.(
        audioOnly
          ? `正在合成音频 ${format.toUpperCase()}（${format === 'm4a' ? 'AAC 192k' : 'MP3 192k'}）…`
          : `正在合成 ${plan.width}×${plan.height} · ${plan.fps}fps ${plan.hasAudio ? '含原声' : '无音轨'}…`,
      )
      if (textLayer) applyTextOverlayGraph(plan, textLayer.inputIndex)
      // 文字层必须在 trim 之前合成（字幕不能跟着区间平移）；封面则相反：
      // 先把视频裁到区间，再叠封面，封面就会落在**导出段的第一帧**上。
      plan = applyExportRangeTrim(plan)
      if (coverPng) applyCoverOverlayGraph(plan, coverInputIndex)
      await ffmpeg.writeFile(graphName, plan.graph)

      let commandArgs = audioOnly
        ? buildAudioExportArgs(
            plan,
            graphName,
            outputName,
            format as AudioExportFormat,
          )
        : buildExportInputArgs(plan, graphName, outputName, {
            maskInputOrder,
            textLayer,
            coverFile: coverPng ? coverFileName : null,
          })
      onStage?.('rendering')
      try {
        await runExportCommand(loaded, commandArgs, outputName, lines, signal)
      } catch (error) {
        // 取消不是「音频轨失败」，不能走无声重试。
        throwIfAborted(signal)
        if (audioOnly) throw error
        if (!plan.hasAudio) throw error
        // 只有**能确认是音频合成问题**时才静默重导无声版：
        // OOM、滤镜图语法错误、编码器初始化失败等必须原样报给用户，
        // 否则会被「已改为导出无声视频」掩盖成一次成功。
        if (!isAudioRelatedFailure(error, lines)) throw error
        warning = `${warning ? `${warning} ` : ''}原声轨合成失败，已改为导出无声视频。`
        onStatus?.('音频合成失败，正在重试无声导出…')
        onProgress?.(0)
        plan = buildExportPlan(project, sources, false, {
          range,
          ...(maskInputsByClip ? { maskInputs: maskInputsByClip } : {}),
        })
        if (textLayer) applyTextOverlayGraph(plan, textLayer.inputIndex)
        plan = applyExportRangeTrim(plan)
        if (coverPng) applyCoverOverlayGraph(plan, coverInputIndex)
        await ffmpeg.writeFile(graphName, plan.graph)
        commandArgs = buildExportInputArgs(plan, graphName, outputName, {
          maskInputOrder,
          textLayer,
          coverFile: coverPng ? coverFileName : null,
        })
        await runExportCommand(loaded, commandArgs, outputName, lines, signal)
      }

      onStage?.('finalizing')
      onStatus?.('正在读取导出结果…')
      throwIfAborted(signal)
      const data = await raceWithAbort(ffmpeg.readFile(outputName), signal)
      if (typeof data === 'string') throw new Error('FFmpeg 返回了文本而非视频数据。')
      if (data.byteLength === 0) throw new Error('导出结果为空。')
      const copy = new Uint8Array(data.byteLength)
      copy.set(data)
      const blob = new Blob([copy.buffer], {
        type:
          format === 'm4a'
            ? 'audio/mp4'
            : format === 'mp3'
              ? 'audio/mpeg'
              : 'video/mp4',
      })

      onProgress?.(1)
      const coverBlob =
        !audioOnly && cover && cover.mode === 'separate'
          ? await buildCoverJpeg(plan.width, plan.height, cover)
          : undefined
      return {
        blob,
        ...(coverBlob ? { cover: coverBlob } : {}),
        mode,
        warning,
        width: plan.width,
        height: plan.height,
        fps: plan.fps,
        hasAudio: plan.hasAudio,
      }
  } finally {
    // 成功 / 失败 / 取消都走这里：清空取消信号、摘掉监听器、回收全部登记资源。
    if (activeExportSignal === signal) activeExportSignal = null
    if (attachedFfmpeg && logHandler) attachedFfmpeg.off('log', logHandler)
    if (attachedFfmpeg && progressHandler) attachedFfmpeg.off('progress', progressHandler)
    await resources.dispose(cleanupTarget)
  }
}

export const exportMeta = {
  crf: getExportCrf,
}

export interface AudioInspection {
  hasAudio: boolean
  containerHasAudio: boolean
  codec: string | null
  meanVolumeDb: number | null
  maxVolumeDb: number | null
  samples: number | null
}

/** Scans MP4 `hdlr` boxes for the `soun` handler (audio track). */
function mp4HasAudioTrack(data: Uint8Array): boolean {
  const match = (offset: number, text: string): boolean => {
    for (let index = 0; index < text.length; index += 1) {
      if (data[offset + index] !== text.charCodeAt(index)) return false
    }
    return true
  }
  for (let index = 4; index + 16 < data.length; index += 1) {
    if (!match(index, 'hdlr')) continue
    // hdlr: type(4) + version/flags(4) + pre_defined(4) + handler_type(4)
    if (match(index + 12, 'soun')) return true
  }
  return false
}

/**
 * Runs `volumedetect` over the exported MP4 without re-encoding. This makes it
 * possible to verify sound exists even when the machine is muted/headless.
 */
export async function inspectExportAudio(
  blob: Blob,
  onStatus?: (message: string) => void,
): Promise<AudioInspection> {
  const runtime = await acquireRuntime()
  const ffmpeg = runtime.ffmpeg
  const name = 'framecut-audio-check.mp4'
  const lines: string[] = []
  const handler = (event: LogEvent) => {
    lines.push(event.message)
    if (lines.length > 400) lines.shift()
  }
  ffmpeg.on('log', handler)
  try {
    onStatus?.('正在写入成片…')
    const data = new Uint8Array(await blob.arrayBuffer())
    const containerHasAudio = mp4HasAudioTrack(data)
    await ffmpeg.writeFile(name, data)
    onStatus?.('正在检测音轨与音量…')
    await execOnRuntime(runtime, [
      '-hide_banner',
      '-loglevel',
      'info',
      '-i',
      name,
      '-map',
      '0:a:0?',
      '-af',
      'volumedetect',
      '-f',
      'null',
      '-',
    ])
    const text = lines.join('\n')
    // FFmpeg prints e.g. `Stream #0:1[0x2](und): Audio: aac (LC) ...`;
    // the language tag made stricter regexes miss valid audio streams.
    const audioLine = text
      .split('\n')
      .find((line) => /Stream #\d+:\d+.*Audio:/.test(line))
    const codecMatch = /Audio:\s*([a-zA-Z0-9_]+)/.exec(audioLine ?? '')
    const meanMatch = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(text)
    const maxMatch = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(text)
    const sampleMatch = /n_samples:\s*(\d+)/.exec(text)
    const parseDb = (value: string | undefined): number | null => {
      if (!value || value === '-inf') return null
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : null
    }
    const meanVolumeDb = parseDb(meanMatch?.[1])
    const maxVolumeDb = parseDb(maxMatch?.[1])
    const samples = sampleMatch ? Number(sampleMatch[1]) : null
    return {
      hasAudio:
        Boolean(audioLine) ||
        containerHasAudio ||
        meanVolumeDb !== null ||
        maxVolumeDb !== null ||
        (samples !== null && samples > 0),
      containerHasAudio,
      codec: codecMatch?.[1] ?? null,
      meanVolumeDb,
      maxVolumeDb,
      samples,
    }
  } finally {
    ffmpeg.off('log', handler)
    try {
      await ffmpeg.deleteFile(name)
    } catch {
      // Best-effort cleanup.
    }
  }
}