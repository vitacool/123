import { clipBlendMode, clipOpacity } from './blend'
import { canvasCompositeOperation } from './blend'
import { clipColor, cssColorFilter, isNeutralColor, temperatureTint } from './color'
import { computeClipGeometry } from './geometry'
import type { Clip, MediaAsset, Point } from './types'

/** 逐帧渲染单个片段时可被关键帧覆盖的属性。 */
export interface ClipRenderOverrides {
  position?: Point
  scale?: number
  rotation?: number
  opacity?: number
}

export interface ClipRenderInput {
  ctx: CanvasRenderingContext2D
  clip: Clip
  /** 该片段在时间线上的本地时间（秒，从片段起点算）。 */
  localTime: number
  asset: MediaAsset | undefined
  /** 画布像素尺寸（已含 DPR）。 */
  canvasW: number
  canvasH: number
  /** 画面源（video 元素 / Image）。 */
  source: CanvasImageSource | null
  /** 可选的属性覆盖，用于关键帧求值后的结果。 */
  overrides?: ClipRenderOverrides
  /** 画面源的像素尺寸（视频元素 videoWidth / 图片 naturalWidth）。 */
  sourceWidth?: number
  sourceHeight?: number
  /** 额外的不透明度系数（转场淡入淡出用；与 clip.opacity 相乘）。 */
  alphaScale?: number
}

/**
 * 调色：亮度/对比度/饱和度走 ctx.filter，色温用 overlay 叠加层近似。
 * 绘制完立刻复位 filter 与 composite/alpha，避免影响后续绘制。
 */
export function drawSourceWithColor(
  ctx: CanvasRenderingContext2D,
  color: Parameters<typeof isNeutralColor>[0],
  rect: { width: number; height: number },
  draw: () => void,
): void {
  if (isNeutralColor(color)) {
    draw()
    return
  }
  const filter = cssColorFilter(color)
  if (filter) ctx.filter = filter
  draw()
  if (filter) ctx.filter = 'none'

  const tint = temperatureTint(color)
  if (!tint) return
  const savedAlpha = ctx.globalAlpha
  const savedOperation = ctx.globalCompositeOperation
  ctx.globalCompositeOperation = 'overlay'
  ctx.globalAlpha = savedAlpha * tint.alpha
  ctx.fillStyle = tint.color
  ctx.fillRect(-rect.width / 2, -rect.height / 2, rect.width, rect.height)
  ctx.globalAlpha = savedAlpha
  ctx.globalCompositeOperation = savedOperation
}

/**
 * 把单个片段绘制到画布上（几何变换 + 裁剪 + 翻转 + 旋转 + 缩放 + 位置 + 不透明度 +
 * 混合模式 + 调色）。
 *
 * 这段逻辑原本内联在 Preview 的 draw 里；抽出来后预览、动画片段的离屏渲染
 * （导出）与逐帧中间视频渲染共用同一份实现，保证三者像素一致。
 */
export function drawClipFrame(input: ClipRenderInput): void {
  const {
    ctx,
    clip,
    asset,
    canvasW,
    canvasH,
    source,
    overrides,
    alphaScale = 1,
  } = input
  const sourceWidth = input.sourceWidth ?? (asset?.width ?? 0)
  const sourceHeight = input.sourceHeight ?? (asset?.height ?? 0)
  if (!source || sourceWidth <= 0 || sourceHeight <= 0) return

  // 关键帧求值后的属性覆盖：只影响几何与不透明度，裁剪/翻转/调色仍来自 clip。
  const effective: Clip = overrides
    ? {
        ...clip,
        position: overrides.position ?? clip.position,
        scale: overrides.scale ?? clip.scale,
        rotation: overrides.rotation ?? clip.rotation,
        opacity: overrides.opacity ?? clipOpacity(clip),
      }
    : clip

  const geometry = computeClipGeometry(
    effective,
    { width: sourceWidth, height: sourceHeight },
    canvasW,
    canvasH,
  )
  const layerScale = geometry.rendered.w / Math.max(1, geometry.rotated.w)
  const radians = (effective.rotation * Math.PI) / 180
  const crop = geometry.source

  ctx.save()
  // 不透明度 + 混合模式：与导出侧的 colorchannelmixer / blend 对应。
  ctx.globalAlpha = alphaScale * clipOpacity(effective)
  ctx.globalCompositeOperation = canvasCompositeOperation(clipBlendMode(effective))
  ctx.translate(
    geometry.rendered.x + geometry.rendered.w / 2,
    geometry.rendered.y + geometry.rendered.h / 2,
  )
  ctx.rotate(radians)
  ctx.scale(
    (effective.flipH ? -1 : 1) * layerScale,
    (effective.flipV ? -1 : 1) * layerScale,
  )
  // 只对片段画面应用调色；背景/文本/字幕不经过这里。
  drawSourceWithColor(
    ctx,
    clipColor(effective),
    { width: crop.w, height: crop.h },
    () => {
      ctx.drawImage(source, crop.x, crop.y, crop.w, crop.h, -crop.w / 2, -crop.h / 2, crop.w, crop.h)
    },
  )
  ctx.restore()
}