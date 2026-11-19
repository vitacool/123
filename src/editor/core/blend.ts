import type { BlendMode, Clip } from './types'

/** 不透明度范围与默认值。 */
export const OPACITY_MIN = 0
export const OPACITY_MAX = 1
export const DEFAULT_OPACITY = 1

/** 默认混合模式。 */
export const DEFAULT_BLEND_MODE: BlendMode = 'normal'

export interface BlendModeOption {
  value: BlendMode
  label: string
  /** Canvas globalCompositeOperation。 */
  canvas: GlobalCompositeOperation
  /** FFmpeg blend 滤镜的 all_mode 取值。 */
  ffmpeg: string
}

/**
 * 六个混合模式的三方映射表（类型 / Canvas / FFmpeg），保证预览与导出一致。
 * `normal` 在 Canvas 用 source-over，在 FFmpeg 走普通 overlay 合成。
 */
export const BLEND_MODES: readonly BlendModeOption[] = [
  { value: 'normal', label: '正常', canvas: 'source-over', ffmpeg: 'normal' },
  { value: 'screen', label: '滤色', canvas: 'screen', ffmpeg: 'screen' },
  { value: 'multiply', label: '正片叠底', canvas: 'multiply', ffmpeg: 'multiply' },
  { value: 'overlay', label: '叠加', canvas: 'overlay', ffmpeg: 'overlay' },
  { value: 'lighten', label: '变亮', canvas: 'lighten', ffmpeg: 'lighten' },
  { value: 'darken', label: '变暗', canvas: 'darken', ffmpeg: 'darken' },
]

const BLEND_BY_VALUE = new Map(BLEND_MODES.map((mode) => [mode.value, mode]))

/** 把任意输入收敛成合法混合模式。 */
export function normalizeBlendMode(value: unknown): BlendMode {
  if (typeof value === 'string' && BLEND_BY_VALUE.has(value as BlendMode)) {
    return value as BlendMode
  }
  return DEFAULT_BLEND_MODE
}

/** 片段混合模式（缺省 normal）。 */
export function clipBlendMode(clip: Pick<Clip, 'blendMode'>): BlendMode {
  return normalizeBlendMode(clip.blendMode)
}

/** 片段不透明度，夹在 0–1；缺省 1。 */
export function clipOpacity(clip: Pick<Clip, 'opacity'>): number {
  const raw = clip.opacity
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_OPACITY
  return Math.max(OPACITY_MIN, Math.min(OPACITY_MAX, raw))
}

/** 是否需要额外处理（非默认值）。 */
export function hasBlendSettings(clip: Pick<Clip, 'opacity' | 'blendMode'>): boolean {
  return clipOpacity(clip) < 1 - 1e-6 || clipBlendMode(clip) !== DEFAULT_BLEND_MODE
}

/** Canvas 合成算子。 */
export function canvasCompositeOperation(mode: BlendMode): GlobalCompositeOperation {
  return (BLEND_BY_VALUE.get(mode) ?? BLEND_MODES[0]).canvas
}

/** FFmpeg blend 的 all_mode 取值。 */
export function ffmpegBlendMode(mode: BlendMode): string {
  return (BLEND_BY_VALUE.get(mode) ?? BLEND_MODES[0]).ffmpeg
}

/** 混合模式的中文名。 */
export function blendModeLabel(mode: BlendMode): string {
  return (BLEND_BY_VALUE.get(mode) ?? BLEND_MODES[0]).label
}

/**
 * 导出侧的不透明度滤镜：先转成带 alpha 的 yuva420p，再用 colorchannelmixer
 * 把 alpha 整体乘以 opacity。
 */
export function opacityFilters(opacity: number): string[] {
  const value = Math.max(OPACITY_MIN, Math.min(OPACITY_MAX, opacity))
  if (value >= 1 - 1e-6) return []
  return ['format=yuva420p', `colorchannelmixer=aa=${Number(value.toFixed(4))}`]
}