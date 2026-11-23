import type { ClipMask, MaskShape } from './types'

/**
 * 形状蒙版：**唯一**的蒙版生成实现，预览（clipRender）、截帧（frameCompose）、
 * 动画烘焙（animationRenderer）与导出（把蒙版渲染成灰度 PNG 再 alphamerge）都走这里，
 * 从源头保证预览与导出一致。
 *
 * 坐标系：蒙版定义在「裁切 + 翻转之后、旋转与缩放之前」的片段画面坐标里，
 * x/y/width/height 都是该画面宽高的比例（0..1），因此与分辨率无关，
 * 并且会跟随片段一起旋转、缩放、移动。
 *
 * core 层不碰 document：羽化需要离屏画布时由调用方注入 `createCanvas`，
 * 注入失败时退化为「不羽化」（形状仍然正确）。
 */

export interface MaskCanvasTarget {
  canvas: CanvasImageSource
  ctx: CanvasRenderingContext2D
}

export const MASK_SHAPES: readonly { value: MaskShape; label: string }[] = [
  { value: 'rect', label: '矩形' },
  { value: 'ellipse', label: '椭圆' },
  { value: 'linear', label: '线性' },
  { value: 'mirror', label: '镜面' },
]

export const MASK_DEFAULTS = {
  shape: 'rect' as MaskShape,
  x: 0.5,
  y: 0.5,
  width: 0.6,
  height: 0.6,
  rotation: 0,
  roundness: 0,
  feather: 0.08,
  invert: false,
} as const

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

/**
 * 把（可能来自旧草稿 / 手工编辑的）蒙版参数夹到合法范围。
 * 旧草稿没有该字段时返回 undefined（= 没有蒙版）。
 */
export function normalizeMask(value: unknown): ClipMask | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Partial<ClipMask>
  const shape: MaskShape =
    raw.shape === 'rect' || raw.shape === 'ellipse' || raw.shape === 'linear' || raw.shape === 'mirror'
      ? raw.shape
      : MASK_DEFAULTS.shape
  const roundness = raw.roundness === undefined ? MASK_DEFAULTS.roundness : clamp01(num(raw.roundness, 0))
  return {
    shape,
    x: clamp01(num(raw.x, MASK_DEFAULTS.x)),
    y: clamp01(num(raw.y, MASK_DEFAULTS.y)),
    // 允许 0（完全不可见），但限制在 0..1；linear 不使用宽高。
    width: clamp01(num(raw.width, MASK_DEFAULTS.width)),
    height: clamp01(num(raw.height, MASK_DEFAULTS.height)),
    rotation: ((num(raw.rotation, 0) % 360) + 360) % 360,
    roundness,
    feather: clamp01(num(raw.feather, MASK_DEFAULTS.feather)),
    invert: raw.invert === true,
  }
}

/** 蒙版短边（像素）：羽化半径按它的比例换算，与分辨率无关。 */
export function maskShortSide(width: number, height: number, mask: ClipMask): number {
  if (mask.shape === 'linear') return Math.min(width, height)
  const boxW = Math.max(1, mask.width * width)
  const boxH = Math.max(1, mask.height * height)
  return Math.max(1, Math.min(boxW, boxH))
}

/**
 * 在 width×height 的画布上画出白色不透明（alpha 即覆盖率）的蒙版形状。
 *
 * - `feather > 0`：用离屏画布 + `ctx.filter = blur(px)` 做羽化，px = feather × 短边；
 *   没有注入离屏画布时退化为硬边（形状仍正确）。
 * - `invert`：整块铺白后用 `destination-out` 抠掉形状，得到「只保留形状外」。
 */
export function drawMaskShape(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  mask: ClipMask,
  createCanvas?: (w: number, h: number) => MaskCanvasTarget | null,
): void {
  if (width <= 0 || height <= 0) return
  const shortSide = maskShortSide(width, height, mask)
  const blurPx = mask.feather * shortSide

  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  if (mask.invert) {
    // 反向：先整块不透明，再把形状抠掉。
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, width, height)
    ctx.globalCompositeOperation = 'destination-out'
  } else {
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = '#fff'
  }
  paintShape(ctx, width, height, mask, blurPx, createCanvas)
  ctx.globalCompositeOperation = 'source-over'
  ctx.restore()
}

/** 画形状本体；羽化时先画到离屏再模糊贴回。 */
function paintShape(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  mask: ClipMask,
  blurPx: number,
  createCanvas?: (w: number, h: number) => MaskCanvasTarget | null,
): void {
  const path = (target: CanvasRenderingContext2D): void => {
    target.beginPath()
    buildPath(target, width, height, mask)
  }

  if (blurPx <= 0.35 || !createCanvas) {
    path(ctx)
    ctx.fill()
    return
  }

  const off = createCanvas(width, height)
  if (!off) {
    // 离屏不可用：退化为硬边，形状与位置仍然正确。
    path(ctx)
    ctx.fill()
    return
  }
  const inner = off.ctx
  inner.setTransform(1, 0, 0, 1, 0, 0)
  inner.globalAlpha = 1
  inner.globalCompositeOperation = 'source-over'
  inner.clearRect(0, 0, width, height)
  inner.save()
  if (mask.invert) inner.globalCompositeOperation = 'source-over'
  inner.fillStyle = '#fff'
  path(inner)
  inner.fill()
  inner.restore()

  // 在目标 ctx 上模糊合成（filter 作用于 drawImage）。
  const supportsFilter = typeof ctx.filter === 'string'
  ctx.save()
  if (supportsFilter) ctx.filter = `blur(${blurPx.toFixed(2)}px)`
  ctx.drawImage(off.canvas, 0, 0, width, height)
  if (supportsFilter) ctx.filter = 'none'
  ctx.restore()
}

/** 构造形状路径（已含中心偏移与旋转）。 */
function buildPath(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  mask: ClipMask,
): void {
  const cx = mask.x * width
  const cy = mask.y * height
  const radians = (mask.rotation * Math.PI) / 180

  if (mask.shape === 'linear') {
    // 一刀切：过中心、方向为 rotation 的直线，保留「线的法线正方向」这一半。
    // 用一条足够长的线段把画面切成两半（沿着线两侧各延伸对角线长度）。
    const length = Math.hypot(width, height) * 2
    const dx = Math.cos(radians) * length
    const dy = Math.sin(radians) * length
    // 法线方向（顺时针 90°），保留法线正侧。
    const nx = -Math.sin(radians)
    const ny = Math.cos(radians)
    const reach = Math.hypot(width, height)
    ctx.moveTo(cx - dx, cy - dy)
    ctx.lineTo(cx + dx, cy + dy)
    ctx.lineTo(cx + dx + nx * reach, cy + dy + ny * reach)
    ctx.lineTo(cx - dx + nx * reach, cy - dy + ny * reach)
    ctx.closePath()
    return
  }

  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(radians)

  if (mask.shape === 'ellipse') {
    const rx = Math.max(0.5, (mask.width * width) / 2)
    const ry = Math.max(0.5, (mask.height * height) / 2)
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2)
    ctx.restore()
    return
  }

  if (mask.shape === 'mirror') {
    // 镜面条带：厚度取 height 比例，长度贯穿画面（用对角线保证转起来也够长）。
    const thickness = Math.max(0.5, mask.height * height)
    const length = Math.hypot(width, height) * 1.5
    ctx.rect(-thickness / 2, -length / 2, thickness, length)
    ctx.restore()
    return
  }

  // rect（含圆角）
  const w = Math.max(0.5, mask.width * width)
  const h = Math.max(0.5, mask.height * height)
  const radius = Math.min(w, h) / 2 * clamp01(mask.roundness ?? 0)
  if (radius <= 0.25) {
    ctx.rect(-w / 2, -h / 2, w, h)
  } else {
    roundedRect(ctx, -w / 2, -h / 2, w, h, radius)
  }
  ctx.restore()
}

/** 圆角矩形路径（ctx 已做平移/旋转）。 */
function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2))
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + width - r, y)
  ctx.arcTo(x + width, y, x + width, y + r, r)
  ctx.lineTo(x + width, y + height - r)
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r)
  ctx.lineTo(x + r, y + height)
  ctx.arcTo(x, y + height, x, y + height - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}

/** 片段类型是否支持蒙版（文字片段不支持）。 */
export function supportsMask(type: string): boolean {
  return type === 'video' || type === 'freeze' || type === 'image'
}