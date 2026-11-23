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
/** `#rgb` / `#rrggbb` → [r, g, b]（0–255）；识别不了返回 null。 */
function hexToRgb(value: string): [number, number, number] | null {
  const raw = value.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]+$/.test(raw)) return null
  if (raw.length === 3) {
    return [
      parseInt(raw[0] + raw[0], 16),
      parseInt(raw[1] + raw[1], 16),
      parseInt(raw[2] + raw[2], 16),
    ]
  }
  if (raw.length === 6) {
    return [
      parseInt(raw.slice(0, 2), 16),
      parseInt(raw.slice(2, 4), 16),
      parseInt(raw.slice(4, 6), 16),
    ]
  }
  return null
}

/**
 * 解析一个 CSS 颜色的不透明度（0–1）：支持 `#rrggbbaa` / `rgba(...)`，
 * 其余（`#rrggbb`、`rgb(...)`、颜色名、transparent）按不透明处理。
 * 无法识别时返回 null。
 */
export function colorAlphaOf(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  if (!text) return null
  if (text === 'transparent') return 0
  const hex = /^#([0-9a-f]{8})$/.exec(text)
  if (hex) return parseInt(hex[1].slice(6, 8), 16) / 255
  const rgba = /^rgba?\(([^)]+)\)$/.exec(text)
  if (rgba) {
    const parts = rgba[1].split(',').map((part) => part.trim())
    if (parts.length === 4) {
      const alpha = Number.parseFloat(parts[3])
      return Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : null
    }
    return parts.length === 3 ? 1 : null
  }
  if (hexToRgb(text) || /^[a-z]+$/.test(text)) return 1
  return null
}

/** 把颜色转成 `<input type="color">` 需要的 `#rrggbb`（识别不了时用 fallback）。 */
export function colorToHex(value: string | null | undefined, fallback = '#000000'): string {
  if (typeof value !== 'string') return fallback
  const text = value.trim()
  const rgb = hexToRgb(text)
  if (rgb) {
    return `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(text.toLowerCase())
  if (rgba) {
    const parts = rgba[1].split(',').map((part) => Number.parseFloat(part.trim()))
    if (parts.length >= 3 && parts.slice(0, 3).every((part) => Number.isFinite(part))) {
      return `#${parts
        .slice(0, 3)
        .map((channel) =>
          Math.min(255, Math.max(0, Math.round(channel))).toString(16).padStart(2, '0'),
        )
        .join('')}`
    }
  }
  return fallback
}

/**
 * 用色板选了一个新颜色，但**保留原来的不透明度**。
 *
 * 颜色选择器只能给 `#rrggbb`（没有 alpha），直接写回会把 `rgba(0,0,0,0.55)`
 * 变成不透明的 `#rrggbb`，阴影会突然变重。这里统一写成 rgba(...)。
 */
export function recolorKeepingAlpha(
  nextHex: string,
  previous: string | null | undefined,
  fallbackAlpha = 1,
): string {
  const rgb = hexToRgb(nextHex) ?? hexToRgb(colorToHex(previous)) ?? [0, 0, 0]
  const alpha = colorAlphaOf(previous) ?? fallbackAlpha
  const safeAlpha = Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : fallbackAlpha))
  const rounded = Math.round(safeAlpha * 1000) / 1000
  if (rounded >= 1) return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${rounded})`
}
