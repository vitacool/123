import { clipBlendMode, clipOpacity } from './blend'
import { canvasCompositeOperation } from './blend'
import { clipColor, cssColorFilter, isNeutralColor, temperatureTint } from './color'
import { computeClipGeometry } from './geometry'
import { drawMaskShape, type MaskCanvasTarget } from './mask'
import type { Clip, Point, SourceInfo } from './types'

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
  asset: SourceInfo | undefined
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
  /**
   * 离屏画布注入（有蒙版时需要）。core 层不碰 document。
   * 注入失败时蒙版退化为「不画蒙版」（保证不崩），调用方应尽量提供。
   */
  createCanvas?: (width: number, height: number) => MaskCanvasTarget | null
  /**
   * 画面处理器注入（色度抠像）。core 只认识这个接口，具体实现是 services/webglKeyer。
   * 返回「已抠像、带 alpha」的画布；返回 null 时退回原画面。
   */
  keyFrame?: {
    keyFrame(
      source: CanvasImageSource,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      width: number,
      height: number,
      key: NonNullable<Clip['chromaKey']>,
    ): CanvasImageSource | null
  }
}

// ---------------------------------------------------------------------------
// 蒙版图缓存：按「蒙版参数 + 像素尺寸」缓存，参数不变时不重新生成（不每帧新建）。
// ---------------------------------------------------------------------------
const maskCache = new Map<string, MaskCanvasTarget>()

function maskKey(mask: NonNullable<Clip['mask']>, width: number, height: number): string {
  return [
    mask.shape,
    mask.x,
    mask.y,
    mask.width,
    mask.height,
    mask.rotation,
    mask.roundness ?? 0,
    mask.feather,
    mask.invert ? 1 : 0,
    width,
    height,
  ].join('|')
}

/** 清空蒙版缓存（测试用；参数或尺寸变化会自动生成新条目）。 */
export function resetMaskCache(): void {
  maskCache.clear()
}

/** 取（或生成）指定尺寸的蒙版图。 */
function maskSurface(
  mask: NonNullable<Clip['mask']>,
  width: number,
  height: number,
  createCanvas?: (width: number, height: number) => MaskCanvasTarget | null,
): MaskCanvasTarget | null {
  const key = maskKey(mask, width, height)
  const cached = maskCache.get(key)
  if (cached) return cached
  const target = createCanvas?.(width, height) ?? null
  if (!target) return null
  const inner = target.ctx
  inner.setTransform(1, 0, 0, 1, 0, 0)
  inner.globalAlpha = 1
  inner.globalCompositeOperation = 'source-over'
  inner.clearRect(0, 0, width, height)
  drawMaskShape(inner, width, height, mask, createCanvas)
  maskCache.set(key, target)
  return target
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
  // ---- 色度抠像 ----
  // 先把「裁切区域」交给注入的处理器抠像，得到一张带 alpha 的画布，
  // 之后照常走蒙版 / 变换 / 不透明度 / 混合模式（处理器只替换源画面）。
  let sourceForDraw = source
  let cropForDraw = crop
  {
    const key = effective.chromaKey
    if (key && input.keyFrame) {
      // 处理尺寸上限 = 画面在画布上的渲染尺寸（不超过源分辨率），控制开销。
      const limitW = Math.max(1, Math.round(geometry.rendered.w))
      const limitH = Math.max(1, Math.round(geometry.rendered.h))
      const keyW = Math.max(1, Math.min(limitW, Math.round(crop.w)))
      const keyH = Math.max(1, Math.min(limitH, Math.round(crop.h)))
      const keyed = input.keyFrame.keyFrame(source, crop.x, crop.y, crop.w, crop.h, keyW, keyH, key)
      if (keyed) {
        sourceForDraw = keyed
        // keyed 画布已经裁切好了，接下来的 drawImage 直接用整张。
        cropForDraw = { x: 0, y: 0, w: keyW, h: keyH }
      }
    }
  }

  // ---- 蒙版路径 ----
  // 先把「裁切 + 翻转后」的画面画到离屏画布（尺寸 = 画布上的渲染尺寸，不是源分辨率），
  // 再用 destination-in 叠同尺寸蒙版，最后整体做旋转/缩放/位置上屏。
  // 没有蒙版时完全走原来的路径（逐像素不变）。
  if (effective.mask && input.createCanvas) {
    const rotatedW = Math.max(1, Math.round(geometry.rotated.w))
    const rotatedH = Math.max(1, Math.round(geometry.rotated.h))
    const scene = input.createCanvas(rotatedW, rotatedH)
    if (scene) {
      const inner = scene.ctx
      inner.setTransform(1, 0, 0, 1, 0, 0)
      inner.globalAlpha = 1
      inner.globalCompositeOperation = 'source-over'
      inner.filter = 'none'
      inner.clearRect(0, 0, rotatedW, rotatedH)
      // 画面铺满离屏（保持裁切比例），翻转在这里完成——蒙版坐标正是「翻转后」的空间。
      const fit = Math.min(rotatedW / Math.max(1, crop.w), rotatedH / Math.max(1, crop.h))
      const drawW = crop.w * fit
      const drawH = crop.h * fit
      inner.save()
      inner.translate(rotatedW / 2, rotatedH / 2)
      inner.scale(effective.flipH ? -1 : 1, effective.flipV ? -1 : 1)
      drawSourceWithColor(inner, clipColor(effective), { width: drawW, height: drawH }, () => {
        inner.drawImage(
          sourceForDraw,
          cropForDraw.x,
          cropForDraw.y,
          cropForDraw.w,
          cropForDraw.h,
          -drawW / 2,
          -drawH / 2,
          drawW,
          drawH,
        )
      })
      inner.restore()

      // 叠蒙版（同尺寸）：destination-in 只保留蒙版内。
      const maskSurfaceTarget = maskSurface(effective.mask, rotatedW, rotatedH, input.createCanvas)
      if (maskSurfaceTarget) {
        inner.setTransform(1, 0, 0, 1, 0, 0)
        inner.globalAlpha = 1
        inner.globalCompositeOperation = 'destination-in'
        inner.drawImage(maskSurfaceTarget.canvas, 0, 0, rotatedW, rotatedH)
        inner.globalCompositeOperation = 'source-over'
      }

      const maskedScale = geometry.rendered.w / Math.max(1, rotatedW)
      ctx.save()
      ctx.globalAlpha = alphaScale * clipOpacity(effective)
      ctx.globalCompositeOperation = canvasCompositeOperation(clipBlendMode(effective))
      ctx.translate(
        geometry.rendered.x + geometry.rendered.w / 2,
        geometry.rendered.y + geometry.rendered.h / 2,
      )
      ctx.rotate(radians)
      ctx.scale(maskedScale, maskedScale)
      ctx.drawImage(scene.canvas, -rotatedW / 2, -rotatedH / 2, rotatedW, rotatedH)
      ctx.restore()
      return
    }
  }

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
      ctx.drawImage(
        sourceForDraw,
        cropForDraw.x,
        cropForDraw.y,
        cropForDraw.w,
        cropForDraw.h,
        -crop.w / 2,
        -crop.h / 2,
        crop.w,
        crop.h,
      )
    },
  )
  ctx.restore()
}