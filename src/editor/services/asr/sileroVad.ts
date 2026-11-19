import type { SpeechSpan } from '../../core/asrVad'

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

let worker: Worker | null = null

function getWorker(): Worker {
  if (!worker) {
    // `?v=` 用于打破浏览器对旧 worker 模块的缓存。
    worker = new Worker(new URL('../../workers/vadWorker.ts?v=6', import.meta.url), {
      type: 'module',
    })
  }
  return worker
}

export interface VadRunResult {
  spans: SpeechSpan[]
  maxProb: number
}

/**
 * Runs Silero VAD on 16 kHz mono PCM. The worker loads the ONNX model once and
 * reuses it; returns detected speech spans + the max speech probability.
 */
export function runSileroVad(pcm16k: Float32Array): Promise<VadRunResult> {
  return new Promise((resolve, reject) => {
    const current = getWorker()
    const id = Math.floor(Math.random() * 1e9)
    const handler = (event: MessageEvent) => {
      const message = event.data as VadMessage
      if (!message || message.id !== id) return
      current.removeEventListener('message', handler)
      if (message.type === 'error') reject(new Error(message.message))
      else resolve({ spans: message.spans, maxProb: message.maxProb })
    }
    current.addEventListener('message', handler)
    const copy = pcm16k.slice()
    current.postMessage({ type: 'vad', id, audio: copy }, [copy.buffer])
  })
}