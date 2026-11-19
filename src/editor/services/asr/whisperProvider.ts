import type { AsrWord } from '../../core/asr'
import type { TranscribeProvider } from './types'

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

// The worker is shared by every provider; it only ever loads a given model
// once and reuses the in-memory pipeline across requests.
let worker: Worker | null = null

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../../workers/whisperWorker.ts?v=3', import.meta.url), {
      type: 'module',
    })
  }
  return worker
}

/** Creates the built-in local Whisper provider for a specific model. */
export function createWhisperProvider(modelId: string): TranscribeProvider {
  return {
    id: modelId,
    label: '本地 Whisper',
    transcribe(pcm16k, opts) {
      return new Promise<AsrWord[]>((resolve, reject) => {
        const current = getWorker()
        const id = Math.floor(Math.random() * 1e9)
        const handler = (event: MessageEvent) => {
          const message = event.data as ProviderMessage
          if (!message || message.id !== id) return
          if (message.type === 'progress') {
            opts.onProgress?.(message.stage, message.progress, message.detail)
            return
          }
          current.removeEventListener('message', handler)
          opts.signal?.removeEventListener('abort', onAbort)
          if (message.type === 'error') reject(new Error(message.message))
          else resolve(message.words)
        }
        const onAbort = () => {
          current.removeEventListener('message', handler)
          opts.signal?.removeEventListener('abort', onAbort)
          current.postMessage({ type: 'cancel', id })
          reject(new DOMException('已取消', 'AbortError'))
        }
        opts.signal?.addEventListener('abort', onAbort, { once: true })
        current.addEventListener('message', handler)
        current.postMessage(
          {
            type: 'transcribe',
            id,
            audio: pcm16k,
            language: opts.language,
            modelId,
          },
          [pcm16k.buffer],
        )
      })
    },
  }
}