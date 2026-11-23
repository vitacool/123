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
/**
 * 各模式与 Canvas `globalCompositeOperation` 的对照（8-bit sRGB、gbrp、纯色实测）：
 * - multiply / screen / darken / lighten：交换两个输入结果相同，与 Canvas 公式一致
 *   （仅 8-bit 舍入差 1；gbrp 下没有 YUV 色度偏移）。
 * - overlay：FFmpeg 的条件判断看**第二个输入**（backdrop），因此调用必须写成
 *   `[底层][叠加层]blend=all_mode=overlay`；写反会得到 hardlight 的观感。
 * - normal：`blend` 直接输出第一个输入，不能拿来做 alpha 合成；普通叠加请用
 *   `overlay` 滤镜（它会按 alpha 合成）。
 * - blend 只逐平面计算、**不按 alpha 合成**：透明区域也会参与运算。所以带透明/半透明
 *   的混合必须先用叠加层的 alpha 做 `alphamerge`，再 `overlay` 回底图
 *   （见 exportPlan 的 mainCompositeLines 与叠加轨混合段）。
 */
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