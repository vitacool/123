import type { AsrLanguage, AsrScript, AsrWord } from '../../core/asr'

export type { AsrLanguage, AsrScript, AsrWord }

/**
 * A pluggable speech-recognition engine. `VideoEditor` exposes an optional
 * `transcribeProvider` prop so a host can inject its own implementation (for
 * example a cloud ASR). When omitted, the built-in local Whisper provider is
 * used.
 */
export interface TranscribeProvider {
  /** Stable identifier, also used as the cache-key `providerId`. */
  id: string
  /** Human-readable name shown in the UI. */
  label: string
  /**
   * Transcribes raw 16 kHz mono PCM (Float32, samples in [-1, 1]) into
   * word-level segments timed relative to the start of `pcm16k`.
   */
  transcribe(
    pcm16k: Float32Array,
    opts: {
      language: AsrLanguage
      /** 输出字形；缺省 simplified（保持历史行为）。 */
      script?: AsrScript
      signal?: AbortSignal
      onProgress?: (stage: 'model' | 'transcribe', pct: number, detail: string) => void
    },
  ): Promise<AsrWord[]>
}