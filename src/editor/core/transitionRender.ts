import type { TransitionType } from './types'

/**
 * 主轨转场的**唯一**预览绘制实现：预览画布与「导出当前帧」共用。
 *
 * 语义以 FFmpeg 的 `xfade` 为准（libavfilter/vf_xfade.c）。xfade 内部用
 * `progress = 0 → 1` 表示「A 段 → B 段」，本模块的 `progress` 与之同向，
 * 因此不需要像旧 Preview 那样自己做 1-p 换算。
 *
 * 约定：
 * - `drawLeft(target, alpha)` / `drawRight(target, alpha)` 负责把 A / B 段画到给定
 *   ctx 上（alpha 是额外透明度系数）；调用方已经把 p（0→1）算好。
 * - 平移 / 缩放类转场通过在本模块里设置 ctx 变换后调用 draw* 实现。
 * - 需要离屏画布的效果（柔边擦除、溶解、像素化、模糊）通过注入的 `createCanvas`
 *   取得，失败（返回 null）时降级为 fade。
 * - 本文件不触碰 document/window：可作为 core 纯绘制模块在 node 里测。
 */

export interface TransitionCanvasTarget {
  canvas: CanvasImageSource
  ctx: CanvasRenderingContext2D
}

export interface PaintTransitionInput {
  ctx: CanvasRenderingContext2D
  width: number
  height: number
  type: TransitionType
  /** 0 = 完全是 A，1 = 完全是 B。 */
  progress: number
  drawLeft: (target: CanvasRenderingContext2D, alpha: number) => void
  drawRight: (target: CanvasRenderingContext2D, alpha: number) => void
  /** 需要离屏画布时由调用方提供；不可用时返回 null（自动降级为 fade）。 */
  createCanvas?: (width: number, height: number) => TransitionCanvasTarget | null
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

/** 记录「哪些类型是真的有分支」的清单（单测用：防止悄悄落回 fade）。 */
export const TRANSITION_RENDER_KINDS = [
  'fade',
  'fadeblack',
  'fadewhite',
  'fadegrays',
  'wipeleft',
  'wiperight',
  'wipeup',
  'wipedown',
  'smoothleft',
  'smoothright',
  'smoothup',
  'smoothdown',
  'slideleft',
  'slideright',
  'slideup',
  'slidedown',
  'circleopen',
  'circleclose',
  'circlecrop',
  'rectcrop',
  'vertopen',
  'vertclose',
  'horzopen',
  'horzclose',
  'radial',
  'dissolve',
  'pixelize',
  'hblur',
  'zoomin',
  'squeezeh',
  'squeezev',
] as const satisfies readonly TransitionType[]

// ---------------------------------------------------------------------------
// 离屏画布缓存：柔边擦除 / 溶解 / 像素化 / 模糊共用，按用途 + 尺寸缓存，不每帧新建。
// ---------------------------------------------------------------------------
const scratchCache = new Map<string, TransitionCanvasTarget | null>()

function scratch(
  input: PaintTransitionInput,
  role: string,
  width: number,
  height: number,
): TransitionCanvasTarget | null {
  const key = `${role}:${width}x${height}`
  if (scratchCache.has(key)) return scratchCache.get(key) ?? null
  const created = input.createCanvas?.(width, height) ?? null
  if (created) {
    created.ctx.setTransform(1, 0, 0, 1, 0, 0)
    created.ctx.imageSmoothingEnabled = true
  }
  scratchCache.set(key, created)
  return created
}

/** 清空离屏缓存（测试或尺寸变化时调用；正常使用无需手动清）。 */
export function resetTransitionScratch(): void {
  scratchCache.clear()
}

// 溶解用的有序抖动噪声（固定种子，缓存）：把画面分成小块，按 noise 阈值逐块显露 B。
const dissolveCache = new Map<string, { canvas: CanvasImageSource; ctx: CanvasRenderingContext2D }>()
const DISSOLVE_STEPS = 16

function seededNoise(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

/**
 * 取第 step（0…15）级溶解遮罩：阈值以下的小块为不透明，其余透明。
 * 生成一次后按 (尺寸, step) 缓存，播放时不再重算。
 */
function dissolveMask(
  input: PaintTransitionInput,
  step: number,
): { canvas: CanvasImageSource; ctx: CanvasRenderingContext2D } | null {
  const cell = 12
  const cols = Math.max(1, Math.ceil(input.width / cell))
  const rows = Math.max(1, Math.ceil(input.height / cell))
  const key = `${cols}x${rows}:${step}`
  const cached = dissolveCache.get(key)
  if (cached) return cached
  const target = scratch({ ...input, createCanvas: input.createCanvas }, `dissolve-${step}`, cols, rows)
  if (!target) return null
  const noise = seededNoise(0x9e3779b9)
  const threshold = (step + 1) / DISSOLVE_STEPS
  target.ctx.clearRect(0, 0, cols, rows)
  target.ctx.fillStyle = '#fff'
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < cols; column += 1) {
      if (noise() < threshold) target.ctx.fillRect(column, row, 1, 1)
    }
  }
  const value = { canvas: target.canvas, ctx: target.ctx }
  dissolveCache.set(key, value)
  return value
}

// ---------------------------------------------------------------------------
// 绘制基元
// ---------------------------------------------------------------------------

/** 在裁剪到给定路径的上下文里画右段。 */
function clipAndDrawRight(
  input: PaintTransitionInput,
  path: (ctx: CanvasRenderingContext2D) => void,
  alpha = 1,
): void {
  const { ctx } = input
  ctx.save()
  ctx.beginPath()
  path(ctx)
  ctx.clip()
  input.drawRight(ctx, alpha)
  ctx.restore()
}

/** 整个画面铺一层颜色（黑场 / 白场用），alpha 控制浓度。 */
function overlayColor(input: PaintTransitionInput, color: string, alpha: number): void {
  if (alpha <= 0) return
  const { ctx, width, height } = input
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = clamp01(alpha)
  ctx.fillStyle = color
  ctx.fillRect(0, 0, width, height)
  ctx.restore()
}

/**
 * 柔边擦除：把右段画进离屏画布，用线性渐变做 alpha 遮罩后贴回。
 * 渐变方向按 (dx, dy) 决定；边缘宽度取画面的 12%。
 */
function softWipe(
  input: PaintTransitionInput,
  progress: number,
  dx: number,
  dy: number,
): void {
  const { ctx, width, height } = input
  const target = scratch(input, 'soft-wipe', width, height)
  if (!target) {
    // 离屏画布不可用：降级为 fade。
    input.drawRight(ctx, progress)
    return
  }
  const inner = target.ctx
  inner.setTransform(1, 0, 0, 1, 0, 0)
  inner.globalAlpha = 1
  inner.globalCompositeOperation = 'source-over'
  inner.clearRect(0, 0, width, height)
  input.drawRight(inner, 1)

  // 渐变：从「已显露」到「未显露」过渡，边缘宽度 12%。
  const band = 0.12
  const horizontal = dx !== 0
  const start = horizontal ? (dx > 0 ? 0 : width) : dy > 0 ? 0 : height
  const end = horizontal ? (dx > 0 ? width : 0) : dy > 0 ? height : 0
  const gradient = horizontal
    ? inner.createLinearGradient(start, 0, end, 0)
    : inner.createLinearGradient(0, start, 0, end)
  const edge = clamp01(progress)
  const soft = Math.min(1, Math.max(0, edge - band))
  gradient.addColorStop(0, 'rgba(0,0,0,0)')
  gradient.addColorStop(soft, 'rgba(0,0,0,0)')
  gradient.addColorStop(edge, 'rgba(0,0,0,1)')
  gradient.addColorStop(1, 'rgba(0,0,0,1)')
  inner.setTransform(1, 0, 0, 1, 0, 0)
  inner.globalAlpha = 1
  inner.globalCompositeOperation = 'destination-in'
  inner.fillStyle = gradient
  inner.fillRect(0, 0, width, height)
  inner.globalCompositeOperation = 'source-over'
  ctx.drawImage(target.canvas, 0, 0, width, height)
}

/** 溶解：按抖动遮罩逐块显露右段（图案与 FFmpeg 不同，进度与观感一致）。 */
function dissolve(input: PaintTransitionInput, progress: number): void {
  const { ctx, width, height } = input
  const step = Math.min(DISSOLVE_STEPS - 1, Math.floor(progress * DISSOLVE_STEPS))
  const mask = dissolveMask(input, step)
  const target = scratch(input, 'dissolve-frame', width, height)
  if (!mask || !target) {
    input.drawRight(ctx, progress)
    return
  }
  const inner = target.ctx
  inner.setTransform(1, 0, 0, 1, 0, 0)
  inner.globalAlpha = 1
  inner.globalCompositeOperation = 'source-over'
  inner.clearRect(0, 0, width, height)
  input.drawRight(inner, 1)
  inner.globalCompositeOperation = 'destination-in'
  inner.imageSmoothingEnabled = false
  inner.drawImage(mask.canvas, 0, 0, width, height)
  inner.imageSmoothingEnabled = true
  inner.globalCompositeOperation = 'source-over'
  ctx.drawImage(target.canvas, 0, 0, width, height)
}

/** 像素化：缩到很小的画布再放大（关闭平滑），块大小先变大后变小，中点换画面。 */
function pixelize(input: PaintTransitionInput, progress: number): void {
  const { ctx, width, height } = input
  const scale = Math.abs(progress - 0.5) * 2 // 1 → 0 → 1
  const block = Math.max(1, Math.round(1 + scale * 46))
  const smallW = Math.max(2, Math.round(width / block))
  const smallH = Math.max(2, Math.round(height / block))
  const target = scratch(input, `pixelize-${block}`, smallW, smallH)
  /**
   * 必须先在**全尺寸**离屏上画好这一帧，再缩到 smallW×smallH。
   *
   * drawLeft/drawRight 是按整幅 width/height 计算几何的（缩放、裁切、定位都在里面），
   * 直接画进只有 1/block 大小的画布，画面会被整体推出画布外或只剩左上角一块 ——
   * 表现就是「选像素化转场后画面基本全黑」。
   */
  const full = scratch(input, `pixelize-full-${block}`, width, height)
  if (!target) {
    input.drawRight(ctx, progress)
    return
  }
  const source = full ?? target
  const sourceWidth = full ? width : smallW
  const sourceHeight = full ? height : smallH
  const sourceCtx = source.ctx
  sourceCtx.setTransform(1, 0, 0, 1, 0, 0)
  sourceCtx.globalAlpha = 1
  sourceCtx.globalCompositeOperation = 'source-over'
  sourceCtx.clearRect(0, 0, sourceWidth, sourceHeight)
  // 中点之前画 A，之后画 B：像素块最大时正好换画面。
  if (progress < 0.5) input.drawLeft(sourceCtx, 1)
  else input.drawRight(sourceCtx, 1)

  const inner = target.ctx
  inner.setTransform(1, 0, 0, 1, 0, 0)
  inner.globalAlpha = 1
  inner.globalCompositeOperation = 'source-over'
  inner.clearRect(0, 0, smallW, smallH)
  if (full) {
    // 缩到小块：关闭平滑才能得到硬边像素块。
    inner.imageSmoothingEnabled = false
    inner.drawImage(full.canvas, 0, 0, width, height, 0, 0, smallW, smallH)
    inner.imageSmoothingEnabled = true
  }

  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(target.canvas, 0, 0, smallW, smallH, 0, 0, width, height)
  ctx.imageSmoothingEnabled = true
  ctx.restore()
}

/** 模糊过渡：Canvas 只能各向同性模糊，用 blur() 近似 xfade 的 hblur。 */
function blurredMix(input: PaintTransitionInput, progress: number): void {
  const { ctx, width, height } = input
  const strength = Math.sin(Math.PI * clamp01(progress)) * 18
  const supportsFilter = typeof ctx.filter === 'string'
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  if (supportsFilter && strength > 0.2) ctx.filter = `blur(${strength.toFixed(2)}px)`
  // 前半段 A 变糊，后半段 B 从糊变清晰：两段交叉淡入淡出。
  input.drawLeft(ctx, 1 - progress)
  input.drawRight(ctx, progress)
  if (supportsFilter) ctx.filter = 'none'
  ctx.restore()
  // 轻微压暗边缘，弥补模糊在边界处的外扩。
  void width
  void height
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 画一帧转场。progress=0 时画面就是 A，progress=1 时画面就是 B。
 *
 * 每种类型的公式见下方分支注释（`P` 即 progress）。
 */
export function paintTransitionFrame(input: PaintTransitionInput): void {
  const { ctx, width, height } = input
  const p = clamp01(input.progress)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'

  switch (input.type) {
    // ---- 基础 ----
    // xfade fade: out = A*(1-P) + B*P
    case 'fade': {
      input.drawLeft(ctx, 1)
      input.drawRight(ctx, p)
      return
    }
    // xfade fadeblack: P<0.5 → A 线性压到黑；P>=0.5 → B 从黑淡入。
    case 'fadeblack': {
      input.drawLeft(ctx, 1)
      if (p < 0.5) {
        overlayColor(input, '#000', p * 2)
        return
      }
      overlayColor(input, '#000', 1)
      input.drawRight(ctx, (p - 0.5) * 2)
      return
    }
    // xfade fadewhite: 同 fadeblack，但中间是白场。
    case 'fadewhite': {
      input.drawLeft(ctx, 1)
      if (p < 0.5) {
        overlayColor(input, '#fff', p * 2)
        return
      }
      overlayColor(input, '#fff', 1)
      input.drawRight(ctx, (p - 0.5) * 2)
      return
    }
    // xfade fadegrays: 先褪色到灰度，再交叉淡入 B（灰度强度随进度先升后降）。
    case 'fadegrays': {
      const gray = 1 - Math.abs(p - 0.5) * 2
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      if (typeof ctx.filter === 'string') ctx.filter = `grayscale(${clamp01(gray).toFixed(3)})`
      input.drawLeft(ctx, 1)
      if (typeof ctx.filter === 'string') ctx.filter = 'none'
      ctx.restore()
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      if (typeof ctx.filter === 'string') ctx.filter = `grayscale(${clamp01(gray).toFixed(3)})`
      input.drawRight(ctx, p)
      if (typeof ctx.filter === 'string') ctx.filter = 'none'
      ctx.restore()
      return
    }

    // ---- 擦除（硬边）----
    // xfade wipeleft: 显露边从右向左移动 → B 出现在 [w*(1-P), w]。
    case 'wipeleft': {
      input.drawLeft(ctx, 1)
      clipAndDrawRight(input, (c) => c.rect(width * (1 - p), 0, width * p, height))
      return
    }
    // xfade wiperight: 显露边从左向右移动 → B 出现在 [0, w*P]。
    case 'wiperight': {
      input.drawLeft(ctx, 1)
      clipAndDrawRight(input, (c) => c.rect(0, 0, width * p, height))
      return
    }
    // xfade wipeup: 显露边自下而上 → B 出现在 [h*(1-P), h]。
    case 'wipeup': {
      input.drawLeft(ctx, 1)
      clipAndDrawRight(input, (c) => c.rect(0, height * (1 - p), width, height * p))
      return
    }
    // xfade wipedown: 显露边自上而下 → B 出现在 [0, h*P]。
    case 'wipedown': {
      input.drawLeft(ctx, 1)
      clipAndDrawRight(input, (c) => c.rect(0, 0, width, height * p))
      return
    }

    // ---- 柔边擦除（渐变遮罩）----
    case 'smoothleft':
    case 'smoothright':
    case 'smoothup':
    case 'smoothdown': {
      input.drawLeft(ctx, 1)
      const dx = input.type === 'smoothleft' ? -1 : input.type === 'smoothright' ? 1 : 0
      const dy = input.type === 'smoothup' ? -1 : input.type === 'smoothdown' ? 1 : 0
      softWipe(input, p, dx, dy)
      return
    }

    // ---- 滑动（两段一起平移）----
    // xfade slideleft: A 左移、B 从右侧进入，两者位移都为 P*w。
    case 'slideleft': {
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, -p * width, 0)
      input.drawLeft(ctx, 1)
      ctx.restore()
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, (1 - p) * width, 0)
      input.drawRight(ctx, 1)
      ctx.restore()
      return
    }
    case 'slideright': {
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, p * width, 0)
      input.drawLeft(ctx, 1)
      ctx.restore()
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, -(1 - p) * width, 0)
      input.drawRight(ctx, 1)
      ctx.restore()
      return
    }
    case 'slideup': {
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, -p * height)
      input.drawLeft(ctx, 1)
      ctx.restore()
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, (1 - p) * height)
      input.drawRight(ctx, 1)
      ctx.restore()
      return
    }
    case 'slidedown': {
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, p * height)
      input.drawLeft(ctx, 1)
      ctx.restore()
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, -(1 - p) * height)
      input.drawRight(ctx, 1)
      ctx.restore()
      return
    }

    // ---- 形状 ----
    // xfade circleopen: B 以圆心为原点向外扩圆显露。
    case 'circleopen':
    case 'circlecrop': {
      input.drawLeft(ctx, 1)
      const radius = clamp01(p) * Math.hypot(width, height) * 0.5
      clipAndDrawRight(input, (c) => c.arc(width / 2, height / 2, Math.max(0, radius), 0, Math.PI * 2))
      return
    }
    // xfade circleclose: A 以圆心为原点向内收圆，露出 B。
    case 'circleclose': {
      input.drawRight(ctx, 1)
      const radius = (1 - clamp01(p)) * Math.hypot(width, height) * 0.5
      ctx.save()
      ctx.beginPath()
      ctx.arc(width / 2, height / 2, Math.max(0, radius), 0, Math.PI * 2)
      ctx.clip()
      input.drawLeft(ctx, 1)
      ctx.restore()
      return
    }
    // xfade rectcrop: B 以中心矩形向外扩张显露。
    case 'rectcrop': {
      input.drawLeft(ctx, 1)
      const w = width * clamp01(p)
      const h = height * clamp01(p)
      clipAndDrawRight(input, (c) => c.rect((width - w) / 2, (height - h) / 2, w, h))
      return
    }
    // xfade vertopen: 竖向从中心向左右打开（显露边水平扩张）。
    case 'vertopen': {
      input.drawLeft(ctx, 1)
      const w = width * clamp01(p)
      clipAndDrawRight(input, (c) => c.rect((width - w) / 2, 0, w, height))
      return
    }
    // xfade vertclose: 竖向从两侧向中心闭合（两侧先显露 B）。
    case 'vertclose': {
      input.drawRight(ctx, 1)
      const w = width * (1 - clamp01(p))
      ctx.save()
      ctx.beginPath()
      ctx.rect((width - w) / 2, 0, w, height)
      ctx.clip()
      input.drawLeft(ctx, 1)
      ctx.restore()
      return
    }
    // xfade horzopen: 横向从中心向上下打开。
    case 'horzopen': {
      input.drawLeft(ctx, 1)
      const h = height * clamp01(p)
      clipAndDrawRight(input, (c) => c.rect(0, (height - h) / 2, width, h))
      return
    }
    // xfade horzclose: 横向从上下向中心闭合。
    case 'horzclose': {
      input.drawRight(ctx, 1)
      const h = height * (1 - clamp01(p))
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, (height - h) / 2, width, h)
      ctx.clip()
      input.drawLeft(ctx, 1)
      ctx.restore()
      return
    }
    // xfade radial: 从 12 点方向顺时针扫过的扇形擦除。
    case 'radial': {
      input.drawLeft(ctx, 1)
      const start = -Math.PI / 2
      const end = start + Math.PI * 2 * clamp01(p)
      const radius = Math.hypot(width, height)
      clipAndDrawRight(input, (c) => {
        c.moveTo(width / 2, height / 2)
        c.arc(width / 2, height / 2, radius, start, end)
        c.closePath()
      })
      return
    }

    // ---- 特效 ----
    case 'dissolve': {
      input.drawLeft(ctx, 1)
      dissolve(input, p)
      return
    }
    case 'pixelize': {
      pixelize(input, p)
      return
    }
    case 'hblur': {
      blurredMix(input, p)
      return
    }
    // xfade zoomin: B 从画面中心放大进入。
    case 'zoomin': {
      input.drawLeft(ctx, 1)
      const scale = 0.35 + 0.65 * clamp01(p)
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalAlpha = 1
      ctx.translate(width / 2, height / 2)
      ctx.scale(scale, scale)
      ctx.translate(-width / 2, -height / 2)
      input.drawRight(ctx, Math.min(1, p * 1.6))
      ctx.restore()
      return
    }
    // xfade squeezeh: A 横向压缩到中间，B 在两侧显露。
    case 'squeezeh': {
      input.drawRight(ctx, 1)
      const scale = 1 - clamp01(p)
      if (scale <= 0.001) return
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.translate(width / 2, height / 2)
      ctx.scale(scale, 1)
      ctx.translate(-width / 2, -height / 2)
      input.drawLeft(ctx, 1)
      ctx.restore()
      return
    }
    // xfade squeezev: A 纵向压缩到中间，B 在上下显露。
    case 'squeezev': {
      input.drawRight(ctx, 1)
      const scale = 1 - clamp01(p)
      if (scale <= 0.001) return
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.translate(width / 2, height / 2)
      ctx.scale(1, scale)
      ctx.translate(-width / 2, -height / 2)
      input.drawLeft(ctx, 1)
      ctx.restore()
      return
    }
    // 未知类型（理论上不会出现）：与导出侧 normalizeTransitionType 一致地回退 fade。
    default: {
      input.drawLeft(ctx, 1)
      input.drawRight(ctx, p)
    }
  }
}