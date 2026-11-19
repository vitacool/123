import { env, pipeline } from '@huggingface/transformers'
import { Converter } from 'opencc-js'
import { cleanAsrWords } from '../core/asrFilters'
import type { AsrLanguage, AsrWord } from '../core/asr'

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

const wasm = env.backends.onnx.wasm
if (wasm) {
  wasm.wasmPaths = new URL('/onnxruntime/', self.location.href).href
  // A portion of the available cores keeps the browser responsive.
  wasm.numThreads = Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency ?? 4) / 2)))
  wasm.proxy = false
}

/** Simplified Chinese for all output (Traditional → Simplified, t2cn only). */
const toSimplified = Converter({ from: 'tw', to: 'cn' })

interface TranscribeRequest {
  type: 'transcribe'
  id: number
  audio: Float32Array
  language: AsrLanguage
  modelId: string
}

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
const cancelledIds = new Set<number>()

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
    if (cached) return cached
    console.info(`[whisper] 加载模型 ${modelId} device=${attempt.device} dtype=${attempt.dtype}`)
    const created = pipeline('automatic-speech-recognition', modelId, {
      device: attempt.device,
      dtype: attempt.dtype,
      progress_callback: (event: unknown) => modelProgress(event, id),
    }) as unknown as Promise<Transcriber>
    pipelineCache.set(key, created)
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
      return { text: toSimplified((chunk.text ?? '').trim()), start, end }
    })
    .filter((word) => word.text.length > 0)
  const cleaned = cleanAsrWords(words)
  console.info(`[whisper] 清洗后 words=${cleaned.length}`, cleaned.slice(0, 5).map((w) => w.text))
  return cleaned
}

scope.onmessage = async (event: MessageEvent) => {
  const data = event.data as TranscribeRequest | CancelMessage
  if (!data || !('type' in data)) return
  if (data.type === 'cancel') {
    cancelledIds.add(data.id)
    return
  }
  if (data.type !== 'transcribe') return

  try {
    if (cancelledIds.has(data.id)) return
    const transcriber = await getPipeline(data.modelId, data.id)
    if (cancelledIds.has(data.id)) return
    scope.postMessage({
      type: 'progress',
      id: data.id,
      stage: 'transcribe',
      progress: 5,
      detail: '正在识别语音…',
    } satisfies ProgressMessage)
    const words = await transcribe(transcriber, data.audio, data.language)
    if (cancelledIds.has(data.id)) return
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