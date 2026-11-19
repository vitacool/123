import * as ort from 'onnxruntime-web'
import {
  frameVadWindows,
  maxProbability,
  probsToSpeechSpans,
  VAD_SAMPLE_RATE,
  VAD_WINDOW_SAMPLES,
  type SpeechSpan,
} from '../core/asrVad'

const scope = self as unknown as {
  postMessage: (message: unknown, transfer?: Transferable[]) => void
  onmessage: ((event: MessageEvent) => void) | null
}

ort.env.wasm.wasmPaths = new URL('/onnxruntime/', self.location.href).href
ort.env.wasm.numThreads = 1

// Silero VAD v5 固定形状：state [2, 1, 128]；名字在运行时从模型读取。
const STATE_DIMS = [2, 1, 128]
const STATE_SIZE = STATE_DIMS.reduce((a, b) => a * b, 1)

interface VadRequest {
  type: 'vad'
  id: number
  audio: Float32Array
}

interface ResultMessage {
  type: 'result'
  id: number
  spans: SpeechSpan[]
  maxProb: number
}

interface ErrorMessage {
  type: 'error'
  id: number
  message: string
}

let sessionPromise: Promise<ort.InferenceSession> | null = null

function getSession(): Promise<ort.InferenceSession> {
  if (sessionPromise) return sessionPromise
  const created = ort.InferenceSession.create(
    new URL('/vad/silero_vad.onnx', self.location.href).href,
    { executionProviders: ['wasm'] },
  )
  sessionPromise = created
  return created
}

interface ModelIo {
  audioName: string
  stateName: string | null
  srName: string | null
  probName: string
  stateOutName: string | null
}

function detectIo(session: ort.InferenceSession, id: number): ModelIo {
  const inputNames = session.inputNames ?? []
  const outputNames = session.outputNames ?? []
  console.info(`[vad] inputs=${JSON.stringify(inputNames)} outputs=${JSON.stringify(outputNames)}`)

  const isSr = (name: string): boolean => /^(sr|sample_rate|samplerate)$/i.test(name)
  const isState = (name: string): boolean => /state/i.test(name)

  const audioName =
    inputNames.find((name) => !isState(name) && !isSr(name)) ?? inputNames[0] ?? 'input'
  const stateName = inputNames.find((name) => isState(name)) ?? null
  const srName = inputNames.find((name) => isSr(name)) ?? null
  const probName = outputNames.find((name) => !isState(name)) ?? outputNames[0] ?? 'output'
  const stateOutName = outputNames.find((name) => isState(name)) ?? null

  if (!stateName) {
    scope.postMessage({
      type: 'error',
      id,
      message: `VAD 模型缺少 state 输入（inputs=${JSON.stringify(inputNames)}）。`,
    } satisfies ErrorMessage)
    throw new Error('VAD 模型不具备流式 state 输入')
  }
  return { audioName, stateName, srName, probName, stateOutName }
}

async function runVad(
  audio: Float32Array,
  id: number,
): Promise<{ spans: SpeechSpan[]; maxProb: number }> {
  const session = await getSession()
  const io = detectIo(session, id)
  const windows = frameVadWindows(audio)
  const probs: number[] = []

  let state: ort.Tensor | null = null
  if (io.stateName) {
    state = new ort.Tensor('float32', new Float32Array(STATE_SIZE), STATE_DIMS)
  }
  let sr: ort.Tensor | null = null
  if (io.srName) {
    sr = new ort.Tensor('int64', new BigInt64Array([BigInt(VAD_SAMPLE_RATE)]), [1])
  }

  const framesPerSecond = Math.round(VAD_SAMPLE_RATE / 512)

  for (let index = 0; index < windows.length; index += 1) {
    const feeds: Record<string, ort.Tensor> = {
      [io.audioName]: new ort.Tensor('float32', windows[index], [1, VAD_WINDOW_SAMPLES]),
    }
    if (state) feeds[io.stateName as string] = state
    if (sr) feeds[io.srName as string] = sr

    const output = await session.run(feeds)
    probs.push(Number(output[io.probName].data[0]))
    if (state && io.stateOutName && output[io.stateOutName]) {
      state = output[io.stateOutName]
    }

    if ((index + 1) % framesPerSecond === 0) {
      const slice = probs.slice(Math.max(0, probs.length - framesPerSecond))
      console.info(
        `[vad] second ${1 + Math.floor((index * 512) / VAD_SAMPLE_RATE)} max prob=${Math.max(...slice).toFixed(3)}`,
      )
    }
  }

  const maxProb = maxProbability(probs)
  const spans = probsToSpeechSpans(probs, {
    frameSeconds: 512 / VAD_SAMPLE_RATE,
    mergeGapSeconds: 0.4,
  })
  console.info(`[vad] frames=${probs.length} maxProb=${maxProb.toFixed(3)} spans=${spans.length}`)
  return { spans, maxProb }
}

scope.onmessage = async (event: MessageEvent) => {
  const data = event.data as VadRequest
  if (!data || data.type !== 'vad') return
  try {
    const { spans, maxProb } = await runVad(data.audio, data.id)
    const message: ResultMessage = { type: 'result', id: data.id, spans, maxProb }
    scope.postMessage(message)
  } catch (error) {
    const message: ErrorMessage = {
      type: 'error',
      id: data.id,
      message: error instanceof Error ? error.message : String(error),
    }
    scope.postMessage(message)
  }
}