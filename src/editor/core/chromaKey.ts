/**
 * 色度抠像 + 去溢色（阶段 B）。
 *
 * 本文件是**唯一**的算法定义：CPU 实现供单测与 WebGL 不可用时的兜底使用，
 * services/webglKeyer.ts 的 GLSL 是它的逐行翻译。
 *
 * 公式严格照抄 FFmpeg：
 * - libavfilter/vf_chromakey.c（滤镜 chromakey）
 * - libavfilter/vf_despill.c（滤镜 despill）
 */

/** 抠像参数（Clip.chromaKey）。 */
export interface ChromaKey {
  /** 要抠掉的颜色，#rrggbb。 */
  color: string
  /** 强度，对应 FFmpeg chromakey 的 similarity，0.01..0.5。 */
  similarity: number
  /** 边缘柔和，对应 blend，0..0.5。 */
  blend: number
  /** 去溢色强度 0..1，0 表示不做 despill。 */
  spill: number
}

export const CHROMA_KEY_DEFAULTS = {
  color: '#00ff00',
  similarity: 0.1,
  blend: 0.08,
  spill: 0,
} as const

export const CHROMA_SIMILARITY_MIN = 0.01
export const CHROMA_SIMILARITY_MAX = 0.5
export const CHROMA_BLEND_MAX = 0.5

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/** #rrggbb / #rgb → [r,g,b]（0..255）；非法回退纯绿。 */
export function parseHexColor(value: string | undefined | null): [number, number, number] {
  const text = typeof value === 'string' ? value.trim().replace(/^#/, '') : ''
  if (/^[0-9a-fA-F]{6}$/.test(text)) {
    return [0, 2, 4].map((i) => parseInt(text.slice(i, i + 2), 16)) as [number, number, number]
  }
  if (/^[0-9a-fA-F]{3}$/.test(text)) {
    return [0, 1, 2].map((i) => parseInt(text[i] + text[i], 16)) as [number, number, number]
  }
  return [0, 255, 0]
}

/** [r,g,b] → #rrggbb。 */
export function formatHexColor(rgb: readonly [number, number, number]): string {
  return `#${rgb
    .map((channel) => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, '0'))
    .join('')}`
}

/**
 * FFmpeg 的 RGB→U/V 定点换算（vf_chromakey.c）：
 *
 *   U = ((-FIXNUM(0.16874)·r - FIXNUM(0.33126)·g + FIXNUM(0.5)·b + 511) >> 10) + 128
 *   V = (( FIXNUM(0.5)·r - FIXNUM(0.41869)·g - FIXNUM(0.08131)·b + 511) >> 10) + 128
 *
 * FIXNUM(x) = lrint(x · 1024)：0.16874→173，0.33126→339，0.5→512，0.41869→429，0.08131→83。
 * `>> 10` 对负数是向下取整，与 C 的算术右移一致（JS 用 Math.floor 复现）。
 */
export function rgbToChromaUV(r: number, g: number, b: number): { u: number; v: number } {
  const u = Math.floor((-173 * r - 339 * g + 512 * b + 511) / 1024) + 128
  const v = Math.floor((512 * r - 429 * g - 83 * b + 511) / 1024) + 128
  return { u: clamp(u, 0, 255), v: clamp(v, 0, 255) }
}

/** 抠像颜色的 U/V（对应 ctx->chromakey_uv）。 */
export function keyUV(key: ChromaKey): { u: number; v: number } {
  const [r, g, b] = parseHexColor(key.color)
  return rgbToChromaUV(r, g, b)
}

/**
 * 单个采样点的色差（与 FFmpeg 完全一致）：
 *   sqrt((du² + dv²) / (255² · 2))
 */
function uvDistance(u: number, v: number, keyU: number, keyV: number): number {
  const du = u - keyU
  const dv = v - keyV
  return Math.sqrt((du * du + dv * dv) / (255 * 255 * 2))
}

/**
 * 由色差算 alpha（0..1）——对应 do_chromakey_pixel：
 *   blend > 0.0001 → clip((diff - similarity) / blend, 0, 1)
 *   否则          → diff > similarity ? 1 : 0
 */
export function chromaAlphaFromDiff(diff: number, key: ChromaKey): number {
  try {
    if (key.blend > 0.0001) {
      return clamp((diff - key.similarity) / key.blend, 0, 1)
    }
    return diff > key.similarity ? 1 : 0
  } catch {
    return 1
  }
}

/**
 * 单个像素的 alpha。
 *
 * FFmpeg 在 U/V 平面上取 3×3 邻域再平均（`diff /= 9`）；预览是 RGB 全分辨率，
 * 这里传入 3×3 邻域（已按 FFmpeg 的 2×2 色度子采样做过映射）的像素 RGB。
 * 邻域不足 9 个时用边界像素补齐。
 */
export function chromaAlphaAtNeighborhood(
  neighborhood: readonly [number, number, number][],
  key: ChromaKey,
): number {
  const { u: keyU, v: keyV } = keyUV(key)
  if (neighborhood.length === 0) return 1
  let sum = 0
  for (const [r, g, b] of neighborhood) {
    const { u, v } = rgbToChromaUV(r, g, b)
    sum += uvDistance(u, v, keyU, keyV)
  }
  return chromaAlphaFromDiff(sum / neighborhood.length, key)
}

/** 单像素便捷版（无邻域平均）。 */
export function chromaAlphaAtPixel(r: number, g: number, b: number, key: ChromaKey): number {
  return chromaAlphaAtNeighborhood([[r, g, b]], key)
}

/**
 * CPU 兜底：就地把 RGBA 像素抠成带 alpha 的图像。
 *
 * 与 WebGL/FFmpeg 的差异：为了在 1080p 下还能跑，**不做 3×3 邻域平均**，
 * 只按单像素色差计算（边缘会略硬）；色差/alpha/despill 公式仍与导出一致。
 * 仅在 WebGL 不可用时用于预览；导出始终走 FFmpeg。
 */
export function keyChromaImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  key: ChromaKey,
): void {
  const count = Math.max(0, Math.floor(width) * Math.floor(height))
  if (count <= 0 || data.length < count * 4) return
  const { u: keyU, v: keyV } = keyUV(key)
  const despill = despillParams(key)
  for (let index = 0; index < count; index += 1) {
    const offset = index * 4
    const r = data[offset]
    const g = data[offset + 1]
    const b = data[offset + 2]
    const { u, v } = rgbToChromaUV(r, g, b)
    const du = u - keyU
    const dv = v - keyV
    const diff = Math.sqrt((du * du + dv * dv) / (255 * 255 * 2))
    const alpha = chromaAlphaFromDiff(diff, key)
    if (alpha <= 0) {
      data[offset + 3] = 0
      continue
    }
    if (alpha < 1) data[offset + 3] = Math.round(data[offset + 3] * alpha)
    if (despill) {
      const [dr, dg, db] = despillPixel([r, g, b], despill)
      data[offset] = dr
      data[offset + 1] = dg
      data[offset + 2] = db
    }
  }
}

// ---------------------------------------------------------------------------
// despill（vf_despill.c）
// ---------------------------------------------------------------------------

export type DespillType = 'green' | 'blue'

/**
 * spill（0..1）→ despill 参数映射（本项目的约定）：
 *   - type：由抠像颜色偏绿还是偏蓝决定（见 despillTypeFor）。
 *   - mix 固定 0.5（FFmpeg 默认值，决定 spillmap 的基准）。
 *   - expand = spill：expand 越大 → factor=(1-mix)(1-expand) 越小 → spillmap 越大 → 去溢色越强。
 *   - red/green/blue 用 FFmpeg 默认（0 / -1 / 0）：绿幕减绿、蓝幕也减绿。
 *     FFmpeg 默认 type=blue 时也是减绿，这里保持一致。
 */
export function despillParams(key: ChromaKey): {
  type: DespillType
  mix: number
  expand: number
} | null {
  if (!(key.spill > 0.0001)) return null
  return { type: despillTypeFor(key.color), mix: 0.5, expand: clamp(key.spill, 0, 1) }
}

/** 抠像颜色偏绿 → green，否则 blue（比较 g 与 b 分量）。 */
export function despillTypeFor(color: string): DespillType {
  const [, g, b] = parseHexColor(color)
  return g >= b ? 'green' : 'blue'
}

/**
 * 单个像素的去溢色（对应 do_despill_slice，默认 redscale=0/greenscale=-1/bluescale=0/brightness=0）：
 *   factor = (1 - mix)(1 - expand)
 *   green: spillmap = max(g - (r·mix + b·factor), 0)
 *   blue : spillmap = max(b - (r·mix + g·factor), 0)
 *   g' = max(g + spillmap·greenscale, 0)   （其余通道 redscale/bluescale = 0，不变）
 */
export function despillPixel(
  rgb: readonly [number, number, number],
  params: { type: DespillType; mix: number; expand: number },
): [number, number, number] {
  const red = rgb[0] / 255
  const green = rgb[1] / 255
  const blue = rgb[2] / 255
  const factor = (1 - params.mix) * (1 - params.expand)
  const spillmap =
    params.type === 'blue'
      ? Math.max(blue - (red * params.mix + green * factor), 0)
      : Math.max(green - (red * params.mix + blue * factor), 0)
  const greenscale = -1
  return [
    clamp(Math.round(red * 255), 0, 255),
    clamp(Math.round(Math.max(green + spillmap * greenscale, 0) * 255), 0, 255),
    clamp(Math.round(blue * 255), 0, 255),
  ]
}

// ---------------------------------------------------------------------------
// 归一化 / 导出参数
// ---------------------------------------------------------------------------

/** 夹取抠像参数；非法 / 缺失返回 undefined（= 不抠像）。 */
export function normalizeChromaKey(value: unknown): ChromaKey | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Partial<ChromaKey>
  if (!raw.color && raw.similarity === undefined && raw.blend === undefined && raw.spill === undefined) {
    return undefined
  }
  const similarity =
    typeof raw.similarity === 'number' && Number.isFinite(raw.similarity)
      ? clamp(raw.similarity, CHROMA_SIMILARITY_MIN, CHROMA_SIMILARITY_MAX)
      : CHROMA_KEY_DEFAULTS.similarity
  const blend =
    typeof raw.blend === 'number' && Number.isFinite(raw.blend)
      ? clamp(raw.blend, 0, CHROMA_BLEND_MAX)
      : CHROMA_KEY_DEFAULTS.blend
  const spill =
    typeof raw.spill === 'number' && Number.isFinite(raw.spill) ? clamp(raw.spill, 0, 1) : 0
  return {
    color: formatHexColor(parseHexColor(raw.color)),
    similarity,
    blend,
    spill,
  }
}

/** chromakey 滤镜参数串（不含 format=）——导出与单测共用同一份格式化。 */
export function chromaKeyFilter(key: ChromaKey): string {
  const [r, g, b] = parseHexColor(key.color)
  const hex = [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')
  return `chromakey=color=0x${hex}:similarity=${trim(key.similarity)}:blend=${trim(key.blend)}`
}

/** despill 滤镜参数串；spill=0 时返回 null。 */
export function despillFilter(key: ChromaKey): string | null {
  const params = despillParams(key)
  if (!params) return null
  return `despill=type=${params.type}:mix=${trim(params.mix)}:expand=${trim(params.expand)}`
}

const trim = (value: number): string => {
  const text = value.toFixed(4)
  return text.replace(/0+$/, '').replace(/\.$/, '')
}

// ---------------------------------------------------------------------------
// 背景色猜测（第一次开启抠像时用四个角取样）
// ---------------------------------------------------------------------------

/**
 * 四角取样的 RGB → 猜测的幕布颜色。
 * 规则：四角平均饱和度高且绿/蓝明显占优 → 返回该色的纯色版本；否则返回 null。
 */
export function guessKeyColor(
  corners: readonly [number, number, number][],
): string | null {
  if (corners.length === 0) return null
  let r = 0
  let g = 0
  let b = 0
  for (const corner of corners) {
    r += corner[0]
    g += corner[1]
    b += corner[2]
  }
  r /= corners.length
  g /= corners.length
  b /= corners.length
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max <= 0) return null
  const saturation = (max - min) / max
  if (saturation < 0.25) return null
  // 偏绿 / 偏蓝才认为是抠像幕布（偏红不要自动猜）
  if (g >= max - 1e-6) return '#00ff00'
  if (b >= max - 1e-6) return '#0000ff'
  return null
}