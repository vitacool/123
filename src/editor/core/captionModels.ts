/**
 * Built-in local Whisper model registry. The model id must end in
 * `_timestamped`: only those ONNX exports carry the cross-attention
 * `alignment_heads` that make `return_timestamps: 'word'` work.
 */

export interface CaptionModelInfo {
  /** Hugging Face model id; also used as the built-in provider's cache key. */
  id: string
  label: string
  sizeHint: string
}

export const DEFAULT_CAPTION_MODEL_ID = 'onnx-community/whisper-small_timestamped'

export const CAPTION_MODELS: CaptionModelInfo[] = [
  {
    id: 'onnx-community/whisper-small_timestamped',
    label: 'Whisper small（推荐）',
    sizeHint: '约 480 MB（int8），又快又稳，日常识别首选',
  },
  {
    id: 'onnx-community/whisper-medium_timestamped',
    label: 'Whisper medium（更准）',
    sizeHint: '约 1.5 GB，准确率更高，但更慢、更占内存，适合长片/正式导出前重新识别',
  },
]

export function captionModelInfo(id: string): CaptionModelInfo {
  return CAPTION_MODELS.find((model) => model.id === id) ?? CAPTION_MODELS[0]
}

/** Fallback when a legacy `task`/`model` value is passed by a host. */
export function isCaptionModelId(value: string): boolean {
  return CAPTION_MODELS.some((model) => model.id === value)
}