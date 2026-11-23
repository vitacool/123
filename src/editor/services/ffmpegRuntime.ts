import type { FFmpeg, LogEvent } from '@ffmpeg/ffmpeg'

/**
 * FFmpeg 运行时的**唯一**管理者：实例、代次（generation）、任务队列。
 *
 * 为什么需要它：
 * - 导出、倒放、ASR、HEVC 转码共用同一个 wasm 实例。原来「导出取消」直接
 *   `terminate()` 共享单例，正在跑的倒放/ASR 会被一起杀掉，只能看到不明失败。
 * - wasm 的 `exec` 一旦卡住就没有任何办法从 JS 侧打断，只能销毁 worker。所以
 *   「超时 / 取消」的正确做法是**立刻 terminate**（原代次作废），而不是 await
 *   `deleteFile` 之类需要 worker 应答的调用——那会把 12s 自检变成永久挂起。
 *   旧 MEMFS 随 worker 一起消失，清理自然由新实例负责。
 * - 同一时刻只允许一个 exec（wasm 实例不是可重入的）；用队列串起来。
 *
 * 代次语义：`terminate` 让 generation +1。持有旧代次的任务在完成/继续时会被
 * 明确告知「运行时已重启，请重试」（{@link RuntimeRestartedError}），
 * 需要重做整个流程的调用方可以用 {@link retryOnRestartOnce} 包一层。
 */

export type RuntimeMode = 'multi-thread' | 'single-thread'

export interface RuntimeCapabilities {
  crossOriginIsolated: boolean
  hasSharedArrayBuffer: boolean
  multiThread: boolean
  forcedSingleThread?: boolean
  reason?: string
}

/** 运行时已被重启（代次变化）：调用方应重试整个流程。 */
export class RuntimeRestartedError extends Error {
  readonly generation: number
  constructor(generation: number) {
    super('运行时已重启，请重试')
    this.name = 'RuntimeRestartedError'
    this.generation = generation
  }
}

export function isRuntimeRestarted(error: unknown): boolean {
  return error instanceof RuntimeRestartedError ||
    (typeof error === 'object' && error !== null && (error as { name?: string }).name === 'RuntimeRestartedError')
}

const ABORT_ERROR_MESSAGE = '已取消'

export function createAbortError(): DOMException {
  return new DOMException(ABORT_ERROR_MESSAGE, 'AbortError')
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'AbortError'
  )
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------- 能力 / 加载

let forceSingleThread = false
let forceSingleReason: string | undefined
let ffmpegAssetBase: string | undefined

export function configureFFmpegAssets(baseUrl?: string): void {
  ffmpegAssetBase = baseUrl?.trim() ? baseUrl.trim() : undefined
}

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

const coreUrl = (path: string): string => {
  const defaultBase = `${(import.meta.env.BASE_URL || '/').replace(/\/?$/, '/')}ffmpeg/`
  const base = ffmpegAssetBase ?? defaultBase
  const normalizedBase = base.endsWith('/') ? base : `${base}/`
  return new URL(`${normalizedBase}${path}`, window.location.href).href
}

export const PROBE_TIMEOUT_MS = 12_000

/** 探测超时（可被测试调小；生产恒为 12s）。 */
let probeTimeoutMs = PROBE_TIMEOUT_MS

/** 仅供测试：把自检超时改小，避免单测等 12 秒。 */
export function setProbeTimeoutMsForTests(ms: number): void {
  probeTimeoutMs = Math.max(1, Math.round(ms))
}

export const PROBE_OUTPUT = 'framecut-selftest.mp4'

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

// ---------------------------------------------------------------- 实例 / 代次

export interface RuntimeHandle {
  ffmpeg: FFmpeg
  mode: RuntimeMode
  warning?: string
  generation: number
}

let instance: FFmpeg | null = null
let loadedMode: RuntimeMode | null = null
let modeWarning: string | undefined
let loading: Promise<RuntimeHandle> | null = null

/** 实例代次：每次 terminate/重启 +1。 */
let runtimeGeneration = 0

/**
 * 正在 exec 的任务：运行时一旦重启就立刻通知它们。
 *
 * 不能只依赖 worker 在 terminate 时拒绝（不同构建/卡死状态下行为不一致）：
 * 有这条通知，旧代次的任务一定能拿到明确的「运行时已重启，请重试」。
 */
const restartListeners = new Set<() => void>()

function notifyRestarted(): void {
  for (const listener of [...restartListeners]) listener()
}

export function currentGeneration(): number {
  return runtimeGeneration
}

export function isGenerationCurrent(generation: number): boolean {
  return generation === runtimeGeneration
}

/** 语义化别名：旧代次的文件清理已经没有意义（MEMFS 随 worker 销毁）。 */
export function canCleanup(generation: number): boolean {
  return isGenerationCurrent(generation)
}

/**
 * 立刻销毁运行时的全部状态并让代次 +1。
 * **不 await 任何 worker 消息**：卡在 exec 里的 worker 只能这么结束。
 */
export function terminateRuntime(reason = '手动释放'): number {
  void reason
  runtimeGeneration += 1
  if (instance) {
    try {
      instance.terminate()
    } catch {
      // worker 可能已经没了。
    }
  }
  instance = null
  loadedMode = null
  modeWarning = undefined
  loading = null
  notifyRestarted()
  return runtimeGeneration
}

/** 宿主卸载编辑器时释放共享运行时。 */
export function terminateFFmpegRuntime(): void {
  terminateRuntime()
}

/** 取当前运行时；必要时加载。加载期间被 terminate 会丢弃这一代实例并报错。 */
export async function acquireRuntime(
  options: { signal?: AbortSignal | null } = {},
): Promise<RuntimeHandle> {
  if (instance && loadedMode) {
    return { ffmpeg: instance, mode: loadedMode, warning: modeWarning, generation: runtimeGeneration }
  }
  if (loading) {
    const pending = await loading
    return { ...pending, generation: runtimeGeneration }
  }

  const generation = runtimeGeneration
  const adopt = (ffmpeg: FFmpeg, mode: RuntimeMode, warning?: string): RuntimeHandle => {
    if (generation !== runtimeGeneration) {
      try {
        ffmpeg.terminate()
      } catch {
        // 已经被停掉了。
      }
      throw new RuntimeRestartedError(runtimeGeneration)
    }
    return { ffmpeg, mode, warning, generation }
  }

  const task = (async (): Promise<RuntimeHandle> => {
    const capabilities = getRuntimeCapabilities()
    if (capabilities.multiThread) {
      try {
        const ffmpeg = await loadCore('multi-thread')
        const handle = adopt(ffmpeg, 'multi-thread', undefined)
        instance = ffmpeg
        loadedMode = 'multi-thread'
        modeWarning = undefined
        return handle
      } catch (error) {
        // 取消/重启不能被当作「多线程加载失败」而降级重试。
        if (isAbortError(error) || isRuntimeRestarted(error)) throw error
        forceSingleThread = true
        forceSingleReason = '多线程核心加载失败，已自动降级为单线程 FFmpeg。'
      }
    }

    const ffmpeg = await loadCore('single-thread')
    const warning =
      (forceSingleThread ? forceSingleReason : undefined) ??
      capabilities.reason ??
      '多线程核心不可用，已降级为单线程 FFmpeg，导出速度会较慢。'
    const handle = adopt(ffmpeg, 'single-thread', warning)
    instance = ffmpeg
    loadedMode = 'single-thread'
    modeWarning = warning
    return handle
  })()
  loading = task

  try {
    const handle = await task
    if (options.signal?.aborted) {
      terminateRuntime()
      throw createAbortError()
    }
    return handle
  } catch (error) {
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

/** 降级到单线程并返回新实例（代次随之 +1）。 */
export async function fallbackToSingleThread(reason: string): Promise<RuntimeHandle> {
  forceSingleThread = true
  forceSingleReason = reason
  terminateRuntime(reason)
  return acquireRuntime()
}

/** 非导出任务（HEVC 转码 / ASR）用的共享实例。 */
export async function loadFFmpegRuntime(): Promise<FFmpeg> {
  const { ffmpeg, warning } = await acquireRuntime()
  if (warning) console.info('[FrameCut]', warning)
  return ffmpeg
}

// ---------------------------------------------------------------- 任务队列

/**
 * 「同一时刻一个 exec」的串行队列。
 *
 * 队列本身**不会**因为某个任务失败而卡住：每个任务结束时都释放自己的名额。
 */
let queueTail: Promise<void> = Promise.resolve()

async function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const previous = queueTail
  let release!: () => void
  queueTail = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous.catch(() => undefined)
  try {
    return await task()
  } finally {
    release()
  }
}

export interface ExecOptions {
  signal?: AbortSignal | null
  /** 超时毫秒数；<=0/未设置表示不限时。超时立刻重启运行时（不等 worker）。 */
  timeoutMs?: number
  /** 运行时被重启后是否自动重试**这一次 exec**（文件已写好、新实例可能缺文件，默认 false）。 */
  retryOnRestart?: boolean
}

function abortErrorIfNeeded(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted) throw createAbortError()
}

/**
 * 在**指定句柄**上排队执行一次 exec（文件型流程必须用这个：重新 acquire 可能拿到
 * 新实例，之前写入的 MEMFS 文件就不在了）。
 */
/** 不排队的核心实现：调用方必须已经在队列内。 */
async function execNow(
  handle: RuntimeHandle,
  args: string[],
  options: ExecOptions = {},
): Promise<number> {
  const signal = options.signal ?? null
  abortErrorIfNeeded(signal)
  {
    abortErrorIfNeeded(signal)
    // 排队期间运行时可能已被重启：文件已经随旧 worker 消失，直接给明确错误。
    if (!isGenerationCurrent(handle.generation)) {
      throw new RuntimeRestartedError(currentGeneration())
    }
    const generation = handle.generation
    const work = handle.ffmpeg.exec(args)
    // 超时/取消后我们不再关心它的结果；必须挂 catch，避免未处理的 rejection。
    void work.catch(() => undefined)

    return new Promise<number>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = (): void => {
        if (settled) return
        settled = true
        cleanup()
        // 取消：杀掉 worker 立即生效，清理交给新实例。
        terminateRuntime('任务被取消')
        reject(createAbortError())
      }
      const onRestart = (): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(new RuntimeRestartedError(currentGeneration()))
      }
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        restartListeners.delete(onRestart)
      }
      restartListeners.add(onRestart)

      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      if (options.timeoutMs && options.timeoutMs > 0) {
        const seconds = Math.round(options.timeoutMs / 1000)
        timer = setTimeout(() => {
          if (settled) return
          settled = true
          cleanup()
          // 超时：worker 卡在 exec 里，只能销毁（旧 MEMFS 随之消失）。
          terminateRuntime('exec 超时')
          reject(new Error(`FFmpeg 执行超时（超过 ${seconds} 秒），已重启运行时。`))
        }, options.timeoutMs)
      }

      work.then(
        (code) => {
          if (settled) return
          settled = true
          cleanup()
          if (!isGenerationCurrent(generation)) {
            reject(new RuntimeRestartedError(currentGeneration()))
            return
          }
          resolve(code)
        },
        (error) => {
          if (settled) return
          settled = true
          cleanup()
          // worker 被 terminate 时 exec 会以一个不明错误 reject：翻译成明确的重启错误。
          if (!isGenerationCurrent(generation)) {
            reject(new RuntimeRestartedError(currentGeneration()))
            return
          }
          reject(error)
        },
      )
    })
  }
}

/** 在指定句柄上排队执行一次 exec（文件型流程必须用这个）。 */
export async function execOnRuntime(
  handle: RuntimeHandle,
  args: string[],
  options: ExecOptions = {},
): Promise<number> {
  return enqueue(() => execNow(handle, args, options))
}

/**
 * 排队执行一次 `ffmpeg.exec`（自己 acquire 运行时）。
 *
 * - 超时：**立即 terminate 运行时**并抛「执行超时」；不会 await 任何需要 worker
 *   应答的清理调用（那正是原来 12s / 3min 超时会变成永久挂起的原因）。
 * - 取消：同样立即 terminate 并抛 AbortError。
 * - 执行期间运行时被别的任务重启：抛 {@link RuntimeRestartedError}。
 */
export async function runFFmpegExec(
  args: string[],
  options: ExecOptions = {},
): Promise<number> {
  const signal = options.signal ?? null
  abortErrorIfNeeded(signal)
  return enqueue(async () => {
    abortErrorIfNeeded(signal)
    const handle = await acquireRuntime({ signal })
    abortErrorIfNeeded(signal)
    return execNow(handle, args, options)
  })
}

/**
 * 包一层「运行时被重启则重做整个流程一次」。
 *
 * 为什么是整流程而不是单次 exec：文件型流程（写输入 → exec → 读输出）在实例重建后
 * 文件已经不存在，只重试 exec 必然「文件找不到」。
 */
export async function retryOnRestartOnce<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task()
  } catch (error) {
    if (!isRuntimeRestarted(error)) throw error
    return task()
  }
}

// ---------------------------------------------------------------- 自检 / 探测

async function probeWithTimeout(
  ffmpeg: FFmpeg,
  args: string[],
  timeoutMs: number,
): Promise<'ok' | 'failed' | 'timeout'> {
  const work = ffmpeg
    .exec(args)
    .then((code): 'ok' | 'failed' => (code === 0 ? 'ok' : 'failed'))
    .catch((): 'failed' => 'failed')
  const result = await Promise.race([work, sleep(timeoutMs).then(() => 'timeout' as const)])
  if (result === 'timeout') {
    // 卡在 exec 里：立刻重启，绝不 await deleteFile（那会永久挂起）。
    terminateRuntime('自检超时')
    return 'timeout'
  }
  return result
}

/** 用一个极短的 lavfi 任务自检「多线程核心能否真的执行滤镜/编码」。 */
async function probeExecRuntime(ffmpeg: FFmpeg): Promise<'ok' | 'failed' | 'timeout'> {
  const generation = currentGeneration()
  const result = await probeWithTimeout(
    ffmpeg,
    [
      '-hide_banner',
      '-y',
      '-f', 'lavfi',
      '-i', 'color=c=black:s=64x64:d=0.2',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      PROBE_OUTPUT,
    ],
    probeTimeoutMs,
  )
  // 清理是「尽力而为」：不 await，旧实例已死时它们本来就无意义。
  if (result === 'ok' && canCleanup(generation)) {
    void ffmpeg.deleteFile(PROBE_OUTPUT).catch(() => undefined)
  }
  return result
}

async function probeMultiThreadRuntime(
  ffmpeg: FFmpeg,
  inputName: string,
): Promise<'ok' | 'failed' | 'timeout'> {
  return probeWithTimeout(
    ffmpeg,
    [
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
    ],
    probeTimeoutMs,
  )
}

/** 导出流程用的自检（调用方自己决定超时后的降级）。 */
export async function probeRuntimeForExport(inputName: string): Promise<'ok' | 'failed' | 'timeout'> {
  const handle = await acquireRuntime()
  return probeMultiThreadRuntime(handle.ffmpeg, inputName)
}

/** 音频导出用的自检（输入可能没有视频流）。 */
export async function probeRuntimeForAudio(): Promise<'ok' | 'failed' | 'timeout'> {
  const handle = await acquireRuntime()
  return probeExecRuntime(handle.ffmpeg)
}

/**
 * 一次性滤镜任务（倒放）用的运行时：多线程核心在本环境执行滤镜会挂起，
 * 先自检，不通过就切单线程。返回的实例一定可以直接 exec。
 */
export async function loadExecRuntime(): Promise<FFmpeg> {
  const handle = await loadExecRuntimeHandle()
  return handle.ffmpeg
}

/**
 * 同 {@link loadExecRuntime}，但返回**句柄**（带代次）。
 * 文件型流程（倒放）必须拿句柄：exec 走它的队列，清理时也要看代次。
 */
export async function loadExecRuntimeHandle(): Promise<RuntimeHandle> {
  const handle = await acquireRuntime()
  if (handle.mode !== 'multi-thread') return handle
  const result = await probeExecRuntime(handle.ffmpeg)
  if (result === 'ok') return handle
  return fallbackToSingleThread(
    '多线程 FFmpeg 核心无法执行滤镜任务，已自动切换为单线程。',
  )
}

// ---------------------------------------------------------------- MP3 编码器

let mp3EncoderSupport: boolean | null = null

export async function isMp3EncoderAvailable(): Promise<boolean> {
  if (mp3EncoderSupport !== null) return mp3EncoderSupport
  try {
    const handle = await acquireRuntime()
    const lines: string[] = []
    const collect = ({ message }: LogEvent): void => {
      lines.push(message)
    }
    handle.ffmpeg.on('log', collect)
    try {
      await handle.ffmpeg.exec(['-hide_banner', '-encoders'])
    } catch {
      // -encoders 只输出信息，非零退出也照样有日志。
    } finally {
      handle.ffmpeg.off('log', collect)
    }
    mp3EncoderSupport = lines.some((line) => /libmp3lame/.test(line))
  } catch {
    mp3EncoderSupport = false
  }
  return mp3EncoderSupport
}