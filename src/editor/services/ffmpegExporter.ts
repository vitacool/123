import type { FFmpeg, LogEvent, ProgressEvent } from '@ffmpeg/ffmpeg'
import {
  buildExportArgs,
  buildExportPlan,
  getExportCrf,
} from '../core/exportPlan'
import { drawTextClip } from '../core/textRender'
import { resolveCaptionStyle } from '../core/text'
import { buildTextOverlayTimeline } from '../core/textOverlay'
import type { CaptionStyle, Project, SourceInfo } from '../core/types'

export type RuntimeMode = 'multi-thread' | 'single-thread'

export interface RuntimeCapabilities {
  crossOriginIsolated: boolean
  hasSharedArrayBuffer: boolean
  multiThread: boolean
  forcedSingleThread?: boolean
  reason?: string
}

export interface ExportResult {
  blob: Blob
  mode: RuntimeMode
  warning?: string
  width: number
  height: number
  fps: number
  hasAudio: boolean
}

/** 导出阶段：加载核心 → 写入素材 → 编码 → 收尾。 */
export type ExportStage = 'loading-core' | 'writing-inputs' | 'rendering' | 'finalizing'

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
}

let forceSingleThread = false
let forceSingleReason: string | undefined

export function getRuntimeCapabilities(): RuntimeCapabilities {
  const crossOriginIsolated =
    typeof window !== 'undefined' && window.crossOriginIsolated === true
  const hasSharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined'
  const multiThread = crossOriginIsolated && hasSharedArrayBuffer && !forceSingleThread
  let reason: string | undefined
  if (forceSingleThread) {
    reason = forceSingleReason
  } else if (!hasSharedArrayBuffer) {
    reason = '浏览器未提供 SharedArrayBuffer，自动使用单线程 FFmpeg。'
  } else if (!crossOriginIsolated) {
    reason = '页面缺少 COOP/COEP 跨域隔离响应头，自动使用单线程 FFmpeg。'
  }
  return {
    crossOriginIsolated,
    hasSharedArrayBuffer,
    multiThread,
    forcedSingleThread: forceSingleThread,
    reason,
  }
}

let instance: FFmpeg | null = null
let loadedMode: RuntimeMode | null = null
let modeWarning: string | undefined
let loading: Promise<{ ffmpeg: FFmpeg; mode: RuntimeMode; warning?: string }> | null = null
let ffmpegAssetBase: string | undefined

/**
 * 当前进行中导出的取消信号。放在模块级，`ffmpeg.on('progress')` 回调每帧据此
 * 判断是否已被取消；导出结束时（含取消路径）必须清空，避免影响下一次导出。
 */
let activeExportSignal: AbortSignal | null = null

const ABORT_ERROR_MESSAGE = '已取消'

/** 运行时「代次」：每次 terminate 递增，用来识别作废的异步加载结果。 */
let runtimeGeneration = 0

function createAbortError(): DOMException {
  return new DOMException(ABORT_ERROR_MESSAGE, 'AbortError')
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'AbortError'
  )
}

/**
 * 取消导出：先终止 wasm 运行时（挂起的 exec 会立即 reject，worker 也就地销毁），
 * 再抛出 AbortError 让调用方走取消分支。
 */
function abortExport(): never {
  terminateRuntime()
  throw createAbortError()
}

/** 阶段边界处的取消检查（加载/写入阶段没有 progress 事件，只能主动检查）。 */
function throwIfAborted(signal: AbortSignal | null): void {
  if (!signal?.aborted) return
  abortExport()
}

/**
 * 让不可中断的异步步骤（加载核心、写文件、读结果）也能被 signal 打断：
 * 取消时立即以 AbortError reject，并终止运行时。
 */
function raceWithAbort<T>(task: Promise<T>, signal: AbortSignal | null): Promise<T> {
  if (!signal) return task
  if (signal.aborted) {
    abortExport()
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      terminateRuntime()
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

/** Point the exporter at a host-served directory containing `core/` and `core-mt/`. */
export function configureFFmpegAssets(baseUrl?: string): void {
  ffmpegAssetBase = baseUrl?.trim() ? baseUrl.trim() : undefined
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const PROBE_TIMEOUT_MS = 12_000
const PROBE_OUTPUT = 'framecut-selftest.mp4'

const coreUrl = (path: string): string => {
  const defaultBase = `${(import.meta.env.BASE_URL || '/').replace(/\/?$/, '/')}ffmpeg/`
  const base = ffmpegAssetBase ?? defaultBase
  const normalizedBase = base.endsWith('/') ? base : `${base}/`
  return new URL(`${normalizedBase}${path}`, window.location.href).href
}

async function loadCore(mode: RuntimeMode): Promise<FFmpeg> {
  const { FFmpeg: FFmpegClass } = await import('@ffmpeg/ffmpeg')
  const ffmpeg = new FFmpegClass()
  if (mode === 'multi-thread') {
    await ffmpeg.load({
      coreURL: coreUrl('core-mt/ffmpeg-core.js'),
      wasmURL: coreUrl('core-mt/ffmpeg-core.wasm'),
      workerURL: coreUrl('core-mt/ffmpeg-core.worker.js'),
    })
  } else {
    await ffmpeg.load({
      coreURL: coreUrl('core/ffmpeg-core.js'),
      wasmURL: coreUrl('core/ffmpeg-core.wasm'),
    })
  }
  return ffmpeg
}

async function getFFmpeg(): Promise<{ ffmpeg: FFmpeg; mode: RuntimeMode; warning?: string }> {
  if (instance && loadedMode) {
    return { ffmpeg: instance, mode: loadedMode, warning: modeWarning }
  }
  if (loading) return loading

  // 加载期间可能被取消（terminateRuntime 会把 generation +1）：
  // 这一代加载出来的运行时必须丢弃并销毁，否则会留下没人引用的孤儿 worker。
  const generation = runtimeGeneration
  const adopt = (ffmpeg: FFmpeg): FFmpeg => {
    if (generation === runtimeGeneration) return ffmpeg
    try {
      ffmpeg.terminate()
    } catch {
      // 已经被停掉了。
    }
    throw createAbortError()
  }

  const task = (async () => {
    const capabilities = getRuntimeCapabilities()
    if (capabilities.multiThread) {
      try {
        const ffmpeg = adopt(await loadCore('multi-thread'))
        instance = ffmpeg
        loadedMode = 'multi-thread'
        modeWarning = undefined
        return { ffmpeg, mode: loadedMode }
      } catch (error) {
        // 取消不能被当作「多线程加载失败」而降级重试。
        if (isAbortError(error)) throw error
        forceSingleThread = true
        forceSingleReason = '多线程核心加载失败，已自动降级为单线程 FFmpeg。'
      }
    }

    const ffmpeg = adopt(await loadCore('single-thread'))
    instance = ffmpeg
    loadedMode = 'single-thread'
    modeWarning =
      (forceSingleThread ? forceSingleReason : undefined) ??
      capabilities.reason ??
      '多线程核心不可用，已降级为单线程 FFmpeg，导出速度会较慢。'
    return { ffmpeg, mode: loadedMode, warning: modeWarning }
  })()
  loading = task

  try {
    return await task
  } catch (error) {
    // 只清理「这一代」的状态，避免把后续新一代加载的实例清掉。
    if (generation === runtimeGeneration) {
      instance = null
      loadedMode = null
      modeWarning = undefined
    }
    throw error
  } finally {
    if (loading === task) loading = null
  }
}

/** Shared FFmpeg runtime for non-export tasks such as HEVC import proxies. */
export async function loadFFmpegRuntime(): Promise<FFmpeg> {
  const { ffmpeg, warning } = await getFFmpeg()
  if (warning) console.info('[FrameCut]', warning)
  return ffmpeg
}

/**
 * 释放共享的 FFmpeg 运行时（停 worker / wasm）。
 * 宿主卸载编辑器（`api.destroy()`）时调用，避免留下占用内存的孤儿 worker。
 */
export function terminateFFmpegRuntime(): void {
  terminateRuntime()
}

function terminateRuntime(): void {
  // 作废进行中的加载：它们完成时不会再把实例装回去（见 getFFmpeg 的 adopt）。
  runtimeGeneration += 1
  if (instance) {
    try {
      instance.terminate()
    } catch {
      // The worker may already be gone.
    }
  }
  instance = null
  loadedMode = null
  modeWarning = undefined
  loading = null
}

async function fallbackToSingleThread(
  reason: string,
): Promise<{ ffmpeg: FFmpeg; mode: RuntimeMode; warning?: string }> {
  forceSingleThread = true
  forceSingleReason = reason
  terminateRuntime()
  return getFFmpeg()
}

async function probeMultiThreadRuntime(
  ffmpeg: FFmpeg,
  inputName: string,
): Promise<'ok' | 'failed' | 'timeout'> {
  const probe = ffmpeg
    .exec([
      '-hide_banner',
      '-i',
      inputName,
      '-t',
      '0.25',
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      PROBE_OUTPUT,
    ])
    .then((code): 'ok' | 'failed' => (code === 0 ? 'ok' : 'failed'))
    .catch((): 'failed' => 'failed')
  return Promise.race([
    probe,
    sleep(PROBE_TIMEOUT_MS).then(() => 'timeout' as const),
  ])
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
 * Appends a single text overlay to the video filter graph. The text layer is
 * one RGBA image-sequence input, resampled to the project fps and overlaid once
 * at 0:0 — instead of one input + one overlay per clip.
 */
function applyTextOverlayGraph(
  plan: ReturnType<typeof buildExportPlan>,
  inputIndex: number,
): void {
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

function injectTextInputArgs(args: string[], layer: TextOverlayLayer | null): string[] {
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
  if (!layer) return
  for (const asset of layer.assets) {
    await ffmpeg.writeFile(asset.file, asset.data)
  }
  await ffmpeg.writeFile(layer.listFile, layer.listContent)
}

function logTail(lines: string[]): string {
  return lines.slice(-10).join('\n')
}

async function runExportCommand(
  ffmpeg: FFmpeg,
  args: string[],
  outputName: string,
  lines: string[],
  signal: AbortSignal | null = null,
): Promise<void> {
  try {
    await ffmpeg.deleteFile(outputName)
  } catch {
    // Output may not exist yet.
  }
  throwIfAborted(signal)
  const code = await raceWithAbort(ffmpeg.exec(args), signal)
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
  activeExportSignal = signal
  throwIfAborted(signal)

  const assetByUrl = new Map(assets.map((asset) => [asset.url, asset]))
  const primary = assetByUrl.get(source.url) ?? source
  const sources: SourceInfo[] = [primary]
  for (const asset of assets) {
    if (asset.url !== primary.url) sources.push(asset)
  }

  let plan = buildExportPlan(project, sources, true)
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

  const capabilities = getRuntimeCapabilities()
  const renderTextLayer = () =>
    renderTextOverlayLayer(
      project,
      plan.width,
      plan.height,
      plan.totalDuration,
      plan.inputs.length,
    )
  let textLayer = await renderTextLayer()
  onStage?.('loading-core')
  onStatus?.(capabilities.multiThread ? '正在加载多线程 FFmpeg…' : '正在加载 FFmpeg…')
  let loaded = await raceWithAbort(getFFmpeg(), signal)
  throwIfAborted(signal)
  let ffmpeg = loaded.ffmpeg
  let mode = loaded.mode
  let warning = loaded.warning

  const outputName = 'framecut-output.mp4'
  const graphName = 'framecut-filtergraph.txt'
  const lines: string[] = []
  let attachedFfmpeg: FFmpeg | null = null
  let logHandler: ((event: LogEvent) => void) | null = null
  let progressHandler: ((event: ProgressEvent) => void) | null = null

  try {
    onStage?.('writing-inputs')
    onStatus?.(
      resolvedInputs.length > 1
        ? `正在读取 ${resolvedInputs.length} 个素材到本地内存…`
        : '正在读取素材到本地内存…',
    )
    await writeInputs(ffmpeg, resolvedInputs, onStatus, onProgress, signal)
    await writeTextOverlayLayer(ffmpeg, textLayer)

    const probeInput = resolvedInputs[0]?.file
    if (mode === 'multi-thread' && probeInput) {
      onStatus?.('正在自检多线程 FFmpeg 核心…')
      const probe = await raceWithAbort(
        probeMultiThreadRuntime(ffmpeg, probeInput),
        signal,
      )
      if (probe !== 'ok') {
        const reason =
          probe === 'timeout'
            ? '多线程 FFmpeg 核心自检超时，已自动降级为单线程导出。'
            : '多线程 FFmpeg 核心未能完成自检，已自动降级为单线程导出。'
        loaded = await fallbackToSingleThread(reason)
        ffmpeg = loaded.ffmpeg
        mode = loaded.mode
        warning = loaded.warning
        onStatus?.('已切换为单线程，正在重新写入素材…')
        onProgress?.(0)
        // The previous worker owns the transferred buffers, so re-read every
        // input before writing it into the new file system.
        onStage?.('writing-inputs')
        await writeInputs(ffmpeg, resolvedInputs, onStatus, onProgress, signal)
        textLayer = await renderTextLayer()
        await writeTextOverlayLayer(ffmpeg, textLayer)
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
      `正在合成 ${plan.width}×${plan.height} · ${plan.fps}fps ${plan.hasAudio ? '含原声' : '无音轨'}…`,
    )
    if (textLayer) applyTextOverlayGraph(plan, textLayer.inputIndex)
    await ffmpeg.writeFile(graphName, plan.graph)

    let commandArgs = injectTextInputArgs(
      buildExportArgs(plan, graphName, outputName),
      textLayer,
    )
    onStage?.('rendering')
    try {
      await runExportCommand(ffmpeg, commandArgs, outputName, lines, signal)
    } catch (error) {
      // 取消不是「音频轨失败」，不能走无声重试。
      throwIfAborted(signal)
      if (!plan.hasAudio) throw error
      warning = `${warning ? `${warning} ` : ''}原声轨合成失败，已改为导出无声视频。`
      onStatus?.('音频合成失败，正在重试无声导出…')
      onProgress?.(0)
      plan = buildExportPlan(project, sources, false)
      if (textLayer) applyTextOverlayGraph(plan, textLayer.inputIndex)
      await ffmpeg.writeFile(graphName, plan.graph)
      commandArgs = injectTextInputArgs(
        buildExportArgs(plan, graphName, outputName),
        textLayer,
      )
      await runExportCommand(ffmpeg, commandArgs, outputName, lines, signal)
    }

    onStage?.('finalizing')
    onStatus?.('正在读取导出结果…')
    throwIfAborted(signal)
    const data = await raceWithAbort(ffmpeg.readFile(outputName), signal)
    if (typeof data === 'string') throw new Error('FFmpeg 返回了文本而非视频数据。')
    if (data.byteLength === 0) throw new Error('导出结果为空。')
    const copy = new Uint8Array(data.byteLength)
    copy.set(data)
    const blob = new Blob([copy.buffer], { type: 'video/mp4' })

    onProgress?.(1)
    return {
      blob,
      mode,
      warning,
      width: plan.width,
      height: plan.height,
      fps: plan.fps,
      hasAudio: plan.hasAudio,
    }
  } finally {
    // 无论成功还是取消，都要清空取消信号引用，避免下一次导出被上一次的 signal 影响。
    if (activeExportSignal === signal) activeExportSignal = null
    if (attachedFfmpeg && logHandler) attachedFfmpeg.off('log', logHandler)
    if (attachedFfmpeg && progressHandler) attachedFfmpeg.off('progress', progressHandler)
    const cleanup = [
      ...resolvedInputs.map((input) => input.file),
      ...(textLayer ? textLayer.assets.map((asset) => asset.file) : []),
      graphName,
      outputName,
      PROBE_OUTPUT,
    ]
    if (textLayer) cleanup.push(textLayer.listFile)
    for (const file of new Set(cleanup)) {
      try {
        await ffmpeg.deleteFile(file)
      } catch {
        // Best-effort cleanup.
      }
    }
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
  const { ffmpeg } = await getFFmpeg()
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
    await ffmpeg.exec([
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