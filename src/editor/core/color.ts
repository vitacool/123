import type { Clip } from './types'

/** 调色四参数的范围与默认值（都是 -100…100，缺省 0）。 */
export const COLOR_MIN = -100
export const COLOR_MAX = 100
export const COLOR_DEFAULT = 0

export interface ColorAdjustments {
  brightness: number
  contrast: number
  saturation: number
  temperature: number
}

export const NEUTRAL_COLOR: ColorAdjustments = {
  brightness: COLOR_DEFAULT,
  contrast: COLOR_DEFAULT,
  saturation: COLOR_DEFAULT,
  temperature: COLOR_DEFAULT,
}

/** 单项：非法/缺省 → 0，并夹到 ±100（保留两位小数）。 */
export function clampColorValue(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return COLOR_DEFAULT
  const rounded = Math.round(value * 100) / 100
  return Math.max(COLOR_MIN, Math.min(COLOR_MAX, rounded))
}

/** 把片段上可选的 color 字段归一化成完整的四个数值。 */
export function normalizeColor(color?: Clip['color'] | null): ColorAdjustments {
  return {
    brightness: clampColorValue(color?.brightness),
    contrast: clampColorValue(color?.contrast),
    saturation: clampColorValue(color?.saturation),
    temperature: clampColorValue(color?.temperature),
  }
}

/** 片段当前生效的调色参数（缺省按 0）。 */
export function clipColor(clip: Pick<Clip, 'color'>): ColorAdjustments {
  return normalizeColor(clip.color)
}

export function isNeutralColor(color: ColorAdjustments): boolean {
  return (
    color.brightness === 0 &&
    color.contrast === 0 &&
    color.saturation === 0 &&
    color.temperature === 0
  )
}

export function isSameColor(a: ColorAdjustments, b: ColorAdjustments): boolean {
  return (
    a.brightness === b.brightness &&
    a.contrast === b.contrast &&
    a.saturation === b.saturation &&
    a.temperature === b.temperature
  )
}

/** 预览用的 CSS filter（不含色温，色温由叠加层实现）。 */
export function cssColorFilter(color: ColorAdjustments): string {
  const parts: string[] = []
  if (color.brightness !== 0) parts.push(`brightness(${1 + color.brightness / 100})`)
  if (color.contrast !== 0) parts.push(`contrast(${1 + color.contrast / 100})`)
  if (color.saturation !== 0) parts.push(`saturate(${1 + color.saturation / 100})`)
  return parts.join(' ')
}

/**
 * 预览用的色温叠加层：暖调叠橙、冷调叠蓝，强度 |t|/400（±100 → ±0.25 alpha）。
 * 返回 null 表示不需要叠加。
 */
export function temperatureTint(
  color: ColorAdjustments,
): { color: string; alpha: number } | null {
  if (color.temperature === 0) return null
  const alpha = Math.min(0.25, Math.abs(color.temperature) / 400)
  return color.temperature > 0
    ? { color: 'rgb(255, 160, 60)', alpha }
    : { color: 'rgb(60, 160, 255)', alpha }
}

const num = (value: number): string => {
  const rounded = Math.round(value * 10000) / 10000
  return String(rounded)
}

/**
 * 饱和度映射（校准得出）：预览用 CSS saturate(1+s/100)，导出用 eq saturation；
 * 两者对饱和度的定义不同（eq 在 YUV 色度空间、CSS 在 sRGB 通道上）。
 * 实测直接取 1+s/100 时 +80 偏大约 19、-80 偏小约 42，
 * 改用幂函数 (1+s/100)^0.65 后两端 3×3 采样残差都 ≤12。
 */
const SATURATION_EXPONENT = 0.65

const eqSaturation = (saturation: number): number => {
  const base = Math.max(0, 1 + saturation / 100)
  return Math.pow(base, SATURATION_EXPONENT)
}

/**
 * 导出用的 FFmpeg 滤镜（插到单片段视频链的 scale 之前）。
 *
 * - eq.brightness 的合法区间是 -1…1，这里取 b/200 得到 ±0.5；
 * - contrast / saturation 直接取 1+c/100、1+s/100（0 → 1，即不变）；
 * - 色温用 colorbalance：暖（t>0）加红减蓝，冷（t<0）反之。
 *
 * 系数校准见 exportPlan 里 videoTransformChain 的注释（3×3 采样，单通道误差 ≤12）。
 */
export function ffmpegColorFilters(color: ColorAdjustments): string[] {
  const filters: string[] = []
  if (color.brightness !== 0 || color.contrast !== 0 || color.saturation !== 0) {
    filters.push(
      `eq=brightness=${num(color.brightness / 200)}:contrast=${num(
        1 + color.contrast / 100,
      )}:saturation=${num(eqSaturation(color.saturation))}`,
    )
  }
  if (color.temperature !== 0) {
    filters.push(
      `colorbalance=rs=${num(color.temperature / 200)}:bs=${num(-color.temperature / 200)}`,
    )
  }
  return filters
}