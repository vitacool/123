import { env, pipeline } from '@huggingface/transformers'
import { convertAsrScript } from '../services/asr/scriptConvert'
import { cleanAsrWords } from '../core/asrFilters'
import type { AsrLanguage, AsrScript, AsrWord } from '../core/asr'

const scope = self as unknown as {
  postMessage: (message: unknown, transfer?: Transferable[]) => void
  onmessage: ((event: MessageEvent) => void) | null
}

// Keep everything local: the model is fetched from the mirror, but the ONNX
// runtime WASM is served from our own public/ directory (no jsdelivr).
env.allowLocalModels = false
env.useBrowserCache = true
env.remoteHost = 'https://hf-mirror.com'
env.remotePathTemplate = '{model}/resolve/{revision}/'

/** 输出字形由主线程按请求传入（缺省 simplified，保持历史行为）。 */

interface TranscribeRequest {
  type: 'transcribe'
  id: number
  audio: Float32Array
  language: AsrLanguage
  /** 输出字形；缺省 simplified。 */
  script?: AsrScript
  modelId: string
  /** 主线程传进来的 ASR 资源根（默认 '/'）。worker 里读不到 document.baseURI。 */
  assetBase?: string
}

/** 资源根归一：相对路径按 worker 脚本所在位置解析，绝对路径按站点解析。 */
function resolveAssetBase(base?: string): string {
  const raw = base && base.trim() ? base.trim() : '/'
  const normalized = raw.endsWith('/') ? raw : `${raw}/`
  try {
    return new URL(normalized, self.location.href).href
  } catch {
    return normalized
  }
}

let assetBase = resolveAssetBase()

function applyWasmPaths(): void {
  const wasm = env.backends.onnx.wasm
  if (!wasm) return
  wasm.wasmPaths = new URL('onnxruntime/', assetBase).href
  // 一部分核心工作保留给浏览器 UI，避免把机器全部核占满。
  wasm.numThreads = Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency ?? 4) / 2)))
  wasm.proxy = false
}

applyWasmPaths()

interface ProgressMessage {
  type: 'progress'
  id: number
  stage: 'model' | 'transcribe'
  progress: number
  detail: string
}

interface ResultMessage {
  type: 'result'
  id: number
  words: AsrWord[]
}

interface ErrorMessage {
  type: 'error'
  id: number
  message: string
}

interface CancelMessage {
  type: 'cancel'
  id: number
}

interface TranscriptionOutput {
  text?: string
  chunks?: { text: string; timestamp: [number, number | null] }[]
}

interface Transcriber {
  (audio: Float32Array, options: Record<string, unknown>): Promise<TranscriptionOutput>
}

const pipelineCache = new Map<string, Promise<Transcriber>>()
/**
 * 同时驻留的模型上限。
 *
 * 每个 whisper pipeline 常驻内存几十到几百 MB（q8 量化 + ONNX session），
 * 而模型切换/多语言试用会让 `pipelineCache` 只增不减 → 长时间编辑后 OOM。
 * 这里做 LRU 淘汰：只保留最近用过的 N 个，其余 dispose 掉。
 */
const MAX_CACHED_PIPELINES = 2
const cancelledIds = new Set<number>()

/** 丢弃最久未使用的 pipeline（Map 保持插入序，命中时重新插入即 LRU）。 */
function evictPipelines(keepKey: string): void {
  while (pipelineCache.size > MAX_CACHED_PIPELINES) {
    const oldest = pipelineCache.keys().next().value
    if (!oldest || oldest === keepKey) break
    const disposed = pipelineCache.get(oldest)
    pipelineCache.delete(oldest)
    void Promise.resolve(disposed)
      .then((pipeline) => {
        const disposable = pipeline as unknown as { dispose?: () => Promise<void> | void }
        return disposable.dispose?.()
      })
      .catch(() => undefined)
    console.info(`[whisper] 淘汰模型 ${oldest}（上限 ${MAX_CACHED_PIPELINES}）`)
  }
}

interface DeviceAttempt {
  device: 'webgpu' | 'wasm'
  dtype: 'fp16' | 'q8'
}

function deviceAttempts(): DeviceAttempt[] {
  // 默认用 wasm q8（int8 量化）：timestamped 模型一定带 int8，最稳；
  // WebGPU + 词级时间戳存在已知内存泄漏，且 fp16 文件不一定存在，暂不优先。
  return [{ device: 'wasm', dtype: 'q8' }]
}

function modelProgress(event: unknown, id: number): void {
  const info = event as {
    status?: string
    file?: string
    progress?: number
    loaded?: number
    total?: number
  }
  if (info.status !== 'progress') return
  const progress =
    typeof info.progress === 'number'
      ? info.progress
      : info.loaded && info.total
        ? (info.loaded / info.total) * 100
        : 0
  const message: ProgressMessage = {
    type: 'progress',
    id,
    stage: 'model',
    progress,
    detail: `下载模型 ${info.file ?? ''}`.trim(),
  }
  scope.postMessage(message)
}

async function getPipeline(modelId: string, id: number): Promise<Transcriber> {
  let lastError: unknown
  for (const attempt of deviceAttempts()) {
    const key = `${modelId}:${attempt.device}:${attempt.dtype}`
    const cached = pipelineCache.get(key)
    if (cached) {
      // 命中也算「最近使用」：重新插入以维持 LRU 顺序。
      pipelineCache.delete(key)
      pipelineCache.set(key, cached)
      return cached
    }
    console.info(`[whisper] 加载模型 ${modelId} device=${attempt.device} dtype=${attempt.dtype}`)
    const created = pipeline('automatic-speech-recognition', modelId, {
      device: attempt.device,
      dtype: attempt.dtype,
      progress_callback: (event: unknown) => modelProgress(event, id),
    }) as unknown as Promise<Transcriber>
    pipelineCache.set(key, created)
    evictPipelines(key)
    try {
      return await created
    } catch (error) {
      lastError = error
      pipelineCache.delete(key)
      console.warn(`[whisper] 加载失败，尝试下一个 device/dtype`, error)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function languageName(language: AsrLanguage): string | undefined {
  if (language === 'zh') return 'chinese'
  if (language === 'en') return 'english'
  return undefined
}

async function transcribe(
  transcriber: Transcriber,
  audio: Float32Array,
  language: AsrLanguage,
  script: AsrScript = 'simplified',
): Promise<AsrWord[]> {
  const output = await transcriber(audio, {
    task: 'transcribe',
    language: languageName(language),
    return_timestamps: 'word',
    chunk_length_s: 30,
    stride_length_s: 5,
  })

  const rawChunks = output.chunks ?? []
  console.info(
    `[whisper] 原始 chunks=${rawChunks.length} text=`,
    (output.text ?? '').slice(0, 80),
  )

  const words: AsrWord[] = rawChunks
    .map((chunk) => {
      const start = Number(chunk.timestamp?.[0] ?? 0)
      const rawEnd = chunk.timestamp?.[1]
      const end = rawEnd === null || rawEnd === undefined ? start + 0.2 : Number(rawEnd)
      return { text: convertAsrScript((chunk.text ?? '').trim(), script), start, end }
    })
    .filter((word) => word.text.length > 0)
  const cleaned = cleanAsrWords(words)
  console.info(`[whisper] 清洗后 words=${cleaned.length}`, cleaned.slice(0, 5).map((w) => w.text))
  return cleaned
}

/**
 * 串行队列。
 *
 * 同一个 worker 只有一个 ONNX session / 一个 transformers pipeline。取消是
 * 「块间检查」而不是真的打断推理，所以「取消 → 立刻重试」很容易让两个
 * `transcriber(audio)` 同时跑在同一个 pipeline 上：内存翻倍、WASM 线程互抢，
 * 慢机器上直接 OOM。这里把请求排成队列：新请求等前一个彻底结束再开始。
 */
let queue: Promise<void> = Promise.resolve()

function enqueue(task: () => Promise<void>): void {
  queue = queue.then(task).catch(() => undefined)
}

async function handleTranscribe(data: TranscribeRequest): Promise<void> {
  try {
    if (cancelledIds.has(data.id)) {
      cancelledIds.delete(data.id)
      return
    }
    // 资源根必须在加载 pipeline 之前生效（wasm/mjs 在 session 创建时解析）。
    if (data.assetBase) {
      assetBase = resolveAssetBase(data.assetBase)
      applyWasmPaths()
    }
    const transcriber = await getPipeline(data.modelId, data.id)
    if (cancelledIds.has(data.id)) {
      cancelledIds.delete(data.id)
      return
    }
    scope.postMessage({
      type: 'progress',
      id: data.id,
      stage: 'transcribe',
      progress: 5,
      detail: '正在识别语音…',
    } satisfies ProgressMessage)
    const words = await transcribe(transcriber, data.audio, data.language, data.script)
    if (cancelledIds.has(data.id)) {
      // 结果已经没人要了，但模型/pipeline 保持热态，下次直接用。
      cancelledIds.delete(data.id)
      return
    }
    const message: ResultMessage = { type: 'result', id: data.id, words }
    scope.postMessage(message)
    cancelledIds.delete(data.id)
  } catch (error) {
    cancelledIds.delete(data.id)
    const message: ErrorMessage = {
      type: 'error',
      id: data.id,
      message: error instanceof Error ? error.message : String(error),
    }
    scope.postMessage(message)
  }
}

scope.onmessage = (event: MessageEvent) => {
  const data = event.data as TranscribeRequest | CancelMessage
  if (!data || !('type' in data)) return
  if (data.type === 'cancel') {
    cancelledIds.add(data.id)
    return
  }
  if (data.type !== 'transcribe') return
  enqueue(() => handleTranscribe(data))
}