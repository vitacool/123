import type { SpeechSpan } from '../../core/asrVad'
import { asrAssetBase } from './assets'
import { WorkerClient } from './workerBridge'

interface VadResultMessage {
  type: 'result'
  id: number
  spans: SpeechSpan[]
  maxProb: number
}

interface VadErrorMessage {
  type: 'error'
  id: number
  message: string
}

type VadMessage = VadResultMessage | VadErrorMessage

/** VAD 模型小、单次推理快；长时间无消息说明模型加载/推理卡死。 */
export const VAD_IDLE_TIMEOUT_MS = 60_000

const client = new WorkerClient<VadMessage>({
  label: '人声检测 Worker',
  // `?v=` 用于打破浏览器对旧 worker 模块的缓存。
  create: () =>
    new Worker(new URL('../../workers/vadWorker.ts?v=6', import.meta.url), {
      type: 'module',
    }),
  idleTimeoutMs: VAD_IDLE_TIMEOUT_MS,
})

/**
 * VAD 不可用的原因（模型文件缺失 / worker 加载失败）。
 *
 * 一旦确定不可用就锁定：`public/vad/silero_vad.onnx` 缺失是**确定性**故障，
 * 每个素材都重新拉一次 worker + 404 只会把识别拖慢几十秒。
 * 上层据此退化成「按固定 28s 切块识别」而不是整轮失败。
 */
let unavailableReason: string | null = null

export function vadUnavailableReason(): string | null {
  return unavailableReason
}

/** 仅供测试：丢掉 worker、在途请求与「不可用」锁定。 */
export function resetVadWorkerForTest(): void {
  client.dispose('测试重置')
  unavailableReason = null
}

export interface VadRunResult {
  spans: SpeechSpan[]
  maxProb: number
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError'
}

/**
 * Runs Silero VAD on 16 kHz mono PCM. The worker loads the ONNX model once and
 * reuses it; returns detected speech spans + the max speech probability.
 *
 * 失败（模型 404、CSP、卡死）会 reject，而**不会**永久挂起；`signal` 中止时
 * 立即 reject AbortError 并通知 worker 放弃本次结果。
 */
export async function runSileroVad(
  pcm16k: Float32Array,
  signal?: AbortSignal,
): Promise<VadRunResult> {
  if (unavailableReason) throw new Error(unavailableReason)
  const copy = pcm16k.slice()
  try {
    const message = await client.request({
      signal,
      build: (id) => ({
        data: { type: 'vad', id, audio: copy, assetBase: asrAssetBase() },
        transfer: [copy.buffer],
      }),
      handle: () => true,
    })
    if (message.type === 'error') throw new Error(message.message)
    return { spans: message.spans, maxProb: message.maxProb }
  } catch (error) {
    if (!isAbortError(error)) {
      unavailableReason = `人声检测不可用：${
        error instanceof Error ? error.message : String(error)
      }`
    }
    throw error
  }
}