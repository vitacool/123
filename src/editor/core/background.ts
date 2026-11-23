import type { CanvasBackground, Clip, Project } from './types'

/** 背景类型的中文名与顺序。 */
export const BACKGROUND_TYPES: readonly { value: CanvasBackground['type']; label: string }[] = [
  { value: 'black', label: '黑色' },
  { value: 'color', label: '纯色' },
  { value: 'blur', label: '模糊填充' },
  { value: 'image', label: '图片' },
]

/** 默认背景：与既有预览底色一致的黑场。 */
export const DEFAULT_BACKGROUND: CanvasBackground = { type: 'black' }
export const DEFAULT_BACKGROUND_COLOR = '#000000'
export const DEFAULT_BLUR_AMOUNT = 24
export const BLUR_MIN = 0
export const BLUR_MAX = 80

/** 预览里“画面未铺满”时的底色（与画布一致）。 */
export const BACKGROUND_FALLBACK = '#070808'

const TYPE_VALUES = new Set<string>(BACKGROUND_TYPES.map((item) => item.value))

function clampBlur(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_BLUR_AMOUNT
  return Math.max(BLUR_MIN, Math.min(BLUR_MAX, value))
}

/** 归一化背景配置：补齐缺省值，非法类型回退黑色。 */
export function normalizeBackground(value: unknown): CanvasBackground {
  if (!value || typeof value !== 'object') return { ...DEFAULT_BACKGROUND }
  const raw = value as Partial<CanvasBackground>
  const type = typeof raw.type === 'string' && TYPE_VALUES.has(raw.type) ? raw.type : 'black'
  const color =
    typeof raw.color === 'string' && raw.color.trim().length > 0
      ? raw.color
      : DEFAULT_BACKGROUND_COLOR
  if (type === 'color') return { type, color }
  if (type === 'blur') return { type, blurAmount: clampBlur(raw.blurAmount) }
  if (type === 'image') {
    return {
      type,
      imageUrl: typeof raw.imageUrl === 'string' && raw.imageUrl ? raw.imageUrl : undefined,
      blurAmount: clampBlur(raw.blurAmount),
    }
  }
  return { type: 'black' }
}

/** 工程级背景（旧草稿缺字段时回退默认）。 */
export function projectBackground(project: Project): CanvasBackground {
  return normalizeBackground(project.canvasBackground)
}

/**
 * 某个片段实际使用的背景：片段级覆盖优先，否则用工程级。
 * 返回 `null` 表示该片段不需要额外背景层（黑场直接留白即可）。
 */
export function clipBackground(clip: Clip, project: Project): CanvasBackground {
  return clip.background ? normalizeBackground(clip.background) : projectBackground(project)
}

/** 背景类型的中文名。 */
export function backgroundLabel(type: CanvasBackground['type']): string {
  return BACKGROUND_TYPES.find((item) => item.value === type)?.label ?? '黑色'
}

/** 预览用的 CSS 背景色（黑场用画布底色，保证与旧行为一致）。 */
export function backgroundCssColor(background: CanvasBackground): string {
  if (background.type === 'black') return BACKGROUND_FALLBACK
  if (background.type === 'color') return background.color ?? DEFAULT_BACKGROUND_COLOR
  return BACKGROUND_FALLBACK
}

/** 预览 Canvas filter 中的模糊半径（px）。 */
export function backgroundBlurPx(background: CanvasBackground): number {
  return background.type === 'blur' || background.type === 'image'
    ? clampBlur(background.blurAmount)
    : 0
}

/** FFmpeg pad 用的颜色值（0xRRGGBB）。 */
export function backgroundFfmpegColor(background: CanvasBackground): string {
  const hex =
    background.type === 'color'
      ? (background.color ?? DEFAULT_BACKGROUND_COLOR)
      : DEFAULT_BACKGROUND_COLOR
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  return match ? `0x${match[1].toLowerCase()}` : '0x000000'
}

/**
 * 「画面层合成」用的背景色（不透明度 / 混合模式 / 蒙版）。
 *
 * 与预览一致：黑场在画布上铺的是 `BACKGROUND_FALLBACK`（#070808），不是纯黑，
 * 所以半透明片段「透出」的也是这个底色；纯色背景用配置色。
 */
export function compositeBackgroundFfmpegColor(background: CanvasBackground): string {
  if (background.type === 'black') return `0x${BACKGROUND_FALLBACK.replace('#', '')}`
  return backgroundFfmpegColor(background)
}

/**
 * 该片段是否需要独立的背景层（模糊/图片）。
 * 黑场与纯色可以直接用 pad 颜色实现，无需额外滤镜分支。
 */
export function needsBackgroundLayer(background: CanvasBackground): boolean {
  if (background.type === 'blur') return true
  if (background.type === 'image') return Boolean(background.imageUrl)
  return false
}

/** 是否把背景应用到所有片段（用于「应用到全部」按钮的提示）。 */
export function isDefaultBackground(background: CanvasBackground): boolean {
  return background.type === 'black'
}

/** 给片段设置背景（不影响其它片段）。 */
export function withClipBackground(clip: Clip, background: CanvasBackground): Clip {
  if (background.type === 'black') {
    const { background: _removed, ...rest } = clip
    return rest
  }
  return { ...clip, background: normalizeBackground(background) }
}