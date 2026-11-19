import type { AsrWord } from './asr'

/** A detected speech span in original-audio time (seconds). */
export interface SpeechSpan {
  start: number
  end: number
}

export interface VadSpanOptions {
  /** Frame probability above which audio counts as speech. */
  threshold?: number
  /** Consecutive speech frames required to open a span. */
  minSpeechFrames?: number
  /** Hangover: silence frames tolerated at the end of a span. */
  minSilenceFrames?: number
  /** Seconds per VAD frame (Silero VAD v5 hop is 512 samples @16 kHz = 32 ms). */
  frameSeconds?: number
  /** Merge spans separated by at most this many seconds. */
  mergeGapSeconds?: number
}

const DEFAULT_OPTIONS: Required<VadSpanOptions> = {
  threshold: 0.5,
  minSpeechFrames: 3,
  minSilenceFrames: 10,
  frameSeconds: 0.032,
  mergeGapSeconds: 0.3,
}

function frameRuns(speech: boolean[]): Array<[number, number]> {
  const runs: Array<[number, number]> = []
  let index = 0
  while (index < speech.length) {
    if (!speech[index]) {
      index += 1
      continue
    }
    let end = index
    while (end < speech.length && speech[end]) end += 1
    runs.push([index, end])
    index = end
  }
  return runs
}

/**
 * Converts Silero-style per-frame speech probabilities into speech spans.
 * Deterministic and independent of the ONNX runtime, so it can be unit tested
 * and reused by the real VAD runner.
 */
export function probsToSpeechSpans(
  probs: Float32Array | readonly number[],
  options: VadSpanOptions = {},
): SpeechSpan[] {
  const config = { ...DEFAULT_OPTIONS, ...options }
  const values = Array.isArray(probs) ? probs : Array.from(probs)
  if (values.length === 0) return []

  const speech = values.map((value) => value >= config.threshold)
  const minSpeech = Math.max(1, Math.round(config.minSpeechFrames))
  const hangover = Math.max(0, Math.round(config.minSilenceFrames))
  const mergeFrames = Math.max(0, Math.round(config.mergeGapSeconds / config.frameSeconds))

  let spans = frameRuns(speech).filter(([start, end]) => end - start >= minSpeech)

  // Extend each span by the silence hangover so word endings are not clipped.
  spans = spans.map(([start, end]): [number, number] => [
    start,
    Math.min(speech.length, end + hangover),
  ])

  const merged: Array<[number, number]> = []
  for (const [start, end] of spans) {
    const previous = merged[merged.length - 1]
    if (previous && start - previous[1] <= mergeFrames) {
      previous[1] = Math.max(previous[1], end)
    } else {
      merged.push([start, end])
    }
  }

  return merged.map(([start, end]) => ({
    start: start * config.frameSeconds,
    end: end * config.frameSeconds,
  }))
}

/**
 * Maps words (timed relative to the audio actually sent to the recogniser)
 * back to original-audio time. The sent window starts at
 * `span.start - padBeforeSeconds`.
 */
export function mapSpanWordsToOriginal(
  words: readonly AsrWord[],
  span: SpeechSpan,
  padBeforeSeconds = 0.2,
): AsrWord[] {
  const origin = span.start - padBeforeSeconds
  const shift = (time: number): number => Math.max(0, time + origin)
  return words.map((word) => ({
    ...word,
    start: shift(word.start),
    end: shift(word.end),
  }))
}

/** Silero VAD v5 frame params. */
export const VAD_CONTEXT_SAMPLES = 64
export const VAD_FRAME_SAMPLES = 512
export const VAD_WINDOW_SAMPLES = VAD_CONTEXT_SAMPLES + VAD_FRAME_SAMPLES // 576
export const VAD_SAMPLE_RATE = 16000

/**
 * Builds Silero VAD v5 inputs: each frame = previous frame's last 64 samples
 * (context) + current 512 samples, shape [1, 576]. The first frame's context is
 * zero-padded. The final frame is zero-padded if it is short.
 */
export function frameVadWindows(audio: Float32Array): Float32Array[] {
  const windows: Float32Array[] = []
  let context = new Float32Array(VAD_CONTEXT_SAMPLES)
  let offset = 0
  while (offset < audio.length) {
    const frame = new Float32Array(VAD_FRAME_SAMPLES)
    frame.set(audio.subarray(offset, offset + VAD_FRAME_SAMPLES))
    const window = new Float32Array(VAD_WINDOW_SAMPLES)
    window.set(context, 0)
    window.set(frame, VAD_CONTEXT_SAMPLES)
    windows.push(window)
    // 下一帧的上下文 = 本帧末尾 64 个采样。
    context = new Float32Array(VAD_CONTEXT_SAMPLES)
    context.set(frame.subarray(VAD_FRAME_SAMPLES - VAD_CONTEXT_SAMPLES))
    offset += VAD_FRAME_SAMPLES
  }
  return windows
}

/** Splits 16 kHz PCM into fixed-length chunks (seconds), the last may be shorter. */
export function chunkPcm16k(
  pcm: Float32Array,
  secondsPerChunk: number,
): Float32Array[] {
  const size = Math.max(1, Math.round(secondsPerChunk * VAD_SAMPLE_RATE))
  const chunks: Float32Array[] = []
  for (let offset = 0; offset < pcm.length; offset += size) {
    chunks.push(pcm.slice(offset, Math.min(pcm.length, offset + size)))
  }
  return chunks
}

/** Returns the max value of a probability array (0 when empty). */
export function maxProbability(probs: Float32Array | readonly number[]): number {
  const values = Array.isArray(probs) ? probs : Array.from(probs)
  let max = 0
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] > max) max = values[i]
  }
  return max
}

export interface SpeechBlock {
  start: number
  end: number
}

export interface SpeechBlockOptions {
  /** 前后留白（秒），默认 0.2。 */
  padSeconds?: number
  /** 间隔小于该值的相邻人声合并为一块，默认 0.4。 */
  mergeGapSeconds?: number
  /** 单块最大时长，超过则切分，默认 28。 */
  maxBlockSeconds?: number
}

/**
 * 把 VAD 检出的语音区间整理成「送识别的人声块」：前后留白、近邻合并、
 * 超长切分，并夹在音频总时长内。块起点锚定在真实人声位置（而非 0）。
 */
export function buildSpeechBlocks(
  spans: readonly { start: number; end: number }[],
  totalDuration: number,
  options: SpeechBlockOptions = {},
): SpeechBlock[] {
  const pad = Math.max(0, options.padSeconds ?? 0.2)
  const mergeGap = Math.max(0, options.mergeGapSeconds ?? 0.4)
  const maxBlock = Math.max(0.1, options.maxBlockSeconds ?? 28)
  const total = Math.max(0, totalDuration)
  const EPS = 1e-6

  const padded = spans
    .filter((span) => span.end > span.start)
    .map((span) => ({
      start: Math.max(0, span.start - pad),
      end: Math.min(total, span.end + pad),
    }))
    .filter((span) => span.end > span.start)
    .sort((left, right) => left.start - right.start)

  const merged: SpeechBlock[] = []
  for (const span of padded) {
    const previous = merged[merged.length - 1]
    if (previous && span.start - previous.end < mergeGap - EPS) {
      previous.end = Math.max(previous.end, span.end)
    } else {
      merged.push({ ...span })
    }
  }

  const blocks: SpeechBlock[] = []
  for (const block of merged) {
    let cursor = block.start
    while (block.end - cursor > maxBlock + EPS) {
      blocks.push({ start: cursor, end: cursor + maxBlock })
      cursor += maxBlock
    }
    blocks.push({ start: cursor, end: block.end })
  }
  return blocks
}