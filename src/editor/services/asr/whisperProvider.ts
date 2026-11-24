import type { AsrWord } from '../../core/asr'
import type { TranscribeProvider } from './types'
import { asrAssetBase } from './assets'
import { WorkerClient } from './workerBridge'

interface ProviderProgressMessage {
  type: 'progress'
  id: number
  stage: 'model' | 'transcribe'
  progress: number
  detail: string
}

interface ProviderResultMessage {
  type: 'result'
  id: number
  words: AsrWord[]
}

interface ProviderErrorMessage {
  type: 'error'
  id: number
  message: string
}

type ProviderMessage = ProviderProgressMessage | ProviderResultMessage | ProviderErrorMessage

/**
 * 多久没收到任何消息（含模型下载进度）就认为卡死。
 *
 * 取值偏保守：真正跑 28s 人声块的推理在慢机器上可能几十秒没有消息，
 * 180s 只用于兜住「下载卡死 / ONNX 初始化死锁 / 宿主没托管 worker 资源」这类
 * 原本会永久挂起的情况（对照 ffmpegRuntime 的 LOAD_TIMEOUT_MS = 45s）。
 */
export const WHISPER_IDLE_TIMEOUT_MS = 180_000

// 同一个 worker 会为每个 model 各自加载一次 pipeline 并复用；
// 失败（脚本 404 / CSP / 崩溃）时由 WorkerClient 丢弃并重建。
const client = new WorkerClient<ProviderMessage>({
  label: '语音识别 Worker',
  create: () =>
    new Worker(new URL('../../workers/whisperWorker.ts?v=4', import.meta.url), {
      type: 'module',
    }),
  idleTimeoutMs: WHISPER_IDLE_TIMEOUT_MS,
})

/** 仅供测试：丢掉 worker 与在途请求。 */
export function resetWhisperWorkerForTest(): void {
  client.dispose('测试重置')
}

/** Creates the built-in local Whisper provider for a specific model. */
export function createWhisperProvider(modelId: string): TranscribeProvider {
  return {
    id: modelId,
    label: '本地 Whisper',
    transcribe(pcm16k, opts) {
      return client
        .request({
          signal: opts.signal,
          build: (id) => ({
            data: {
              type: 'transcribe',
              id,
              audio: pcm16k,
              language: opts.language,
              script: opts.script ?? 'simplified',
              modelId,
              // onnxruntime 的 wasm/mjs 由宿主托管：把资源根一并交给 worker
              // （worker 里不能读 document，只能由主线程算好传进去）。
              assetBase: asrAssetBase(),
            },
            transfer: [pcm16k.buffer],
          }),
          handle: (message) => {
            if (message.type === 'progress') {
              opts.onProgress?.(message.stage, message.progress, message.detail)
              return false
            }
            return true
          },
        })
        .then((message) => {
          if (message.type === 'error') throw new Error(message.message)
          return (message as ProviderResultMessage).words
        })
    },
  }
}