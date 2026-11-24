import { BACKGROUND_FALLBACK, backgroundBlurPx, backgroundCssColor, clipBackground } from './background'
import { hasAnimation, resolveClipOverrides } from './animation'
import { getOutputDimensions } from './aspect'
import { drawClipFrame } from './clipRender'
import { paintTransitionFrame } from './transitionRender'
import { formatPlayhead } from './format'
import { resolveCaptionStyle, textClipDuration } from './text'
import { drawTextClip } from './textRender'
import { resolveTextOverrides } from './textAnimation'
import { findSegmentAt, segmentsAt } from './timeline'
import { isMainVideoVisible, isOverlayVideoVisible, isTextTrackVisible } from './tracks'
import { normalizeTransitionType, transitionProgress } from './transition'
import type {
  Clip,
  ExportFps,
  Project,
  SourceInfo,
  TextClip,
  TimelineSegment,
  TransitionType,
} from './types'

/**
 * `frameCompose` 负责「把某一时刻的画面合成到一块离屏画布上」，供
 * 「导出当前帧」使用。它不碰 DOM、不 seek 视频：调用方（services/frameCapture）
 * 先把每个片段需要的那一帧解码好，以 `clip.id → 画面源` 的形式传进来。
 *
 * 绘制顺序与 components/Preview.tsx 的 draw() 逐段对应（清屏底色 → 画布背景 →
 * 主轨（含转场中间态）→ 叠加轨（自下而上）→ 文字 / 字幕），因此截出来的
 * 静止帧和预览看到的是同一套合成规则；只是尺寸换成导出分辨率、不含任何 UI 叠层。
 */

/** 已解码的一帧画面（video 元素 / Image）及其像素尺寸。 */
export interface FrameImage {
  source: CanvasImageSource
  width: number
  height: number
}

/** 一个需要绘制画面的图层。 */
export interface FrameLayer {
  clip: Clip
  /** 主轨为 null；叠加轨为轨道 id。 */
  trackId: string | null
  /** 片段在时间轴上的起点与时长（关键帧求值用）。 */
  start: number
  duration: number
}

/** 某一时刻的图层清单（顺序即绘制顺序，自下而上）。 */
export interface FrameComposition {
  /** 画布背景所属片段（主轨该时刻的片段）；主轨不可见时为 null。 */
  backgroundClip: Clip | null
  /** 主轨图层：单段 1 个，转场重叠时 2 个（[左段, 右段]）。 */
  main: FrameLayer[]
  /** 叠加轨图层，按 overlayTracks 数组顺序（自下而上）。 */
  overlays: FrameLayer[]
  /** 该时刻可见的文字 / 字幕（含已解析的样式）。 */
  texts: { clip: TextClip; style: TextClip }[]
  /** 主轨是否有可见画面（hidden / disabled 时只画叠加轨与文字）。 */
  mainVisible: boolean
}

const toLayer = (segment: TimelineSegment, trackId: string | null): FrameLayer => ({
  clip: segment.clip,
  trackId,
  start: segment.start,
  duration: segment.duration,
})

/**
 * 某时刻需要绘制的图层清单。遵守主轨 / 叠加轨 / 文字轨的 enabled 与 hidden，
 * 以及字幕的 linkHidden；转场重叠区会返回两段主轨图层。
 */
export function frameCompositionAt(project: Project, time: number): FrameComposition {
  const mainVisible = isMainVideoVisible(project)
  const baseSegment = findSegmentAt(project.clips, time)
  const main: FrameLayer[] = []
  if (mainVisible && baseSegment) {
    // 转场重叠区同时命中两段：先画「左段」，再按进度叠加「右段」。
    const overlapping = segmentsAt(project.clips, time)
    const layers = overlapping.length >= 2 ? overlapping.slice(0, 2) : [baseSegment]
    for (const segment of layers) main.push(toLayer(segment, null))
  }

  const overlays: FrameLayer[] = []
  for (const track of project.overlayTracks ?? []) {
    if (!isOverlayVideoVisible(track)) continue
    const segment = findSegmentAt(track.clips, time)
    if (!segment) continue
    overlays.push(toLayer(segment, track.id))
  }

  const texts: { clip: TextClip; style: TextClip }[] = []
  for (const track of project.textTracks ?? []) {
    if (!isTextTrackVisible(track)) continue
    for (const clip of track.clips) {
      if (clip.link?.linkHidden) continue
      // 与预览一致：起点含、终点不含（边界上交给下一个片段，避免重影）。
      if (time < clip.start - 0.001 || time >= clip.end - 0.001) continue
      texts.push({ clip, style: resolveCaptionStyle(clip, track.captionStyle) })
    }
  }

  return {
    backgroundClip: mainVisible ? baseSegment?.clip ?? null : null,
    main,
    overlays,
    texts,
    mainVisible,
  }
}

export interface ComposeFrameInput {
  ctx: CanvasRenderingContext2D
  /** 目标画布像素尺寸（已含导出分辨率，不含 DPR）。 */
  width: number
  height: number
  project: Project
  /** 要截取的时间轴时刻（秒）。 */
  time: number
  /** `clip.id → 该片段此刻的画面`；缺失的片段直接跳过（与预览的「素材已移除」一致）。 */
  frames: Map<string, FrameImage>
  /** 离屏画布注入（蒙版用）。core 不碰 document，由调用方提供。 */
  createCanvas?: (width: number, height: number) => {
    canvas: CanvasImageSource
    ctx: CanvasRenderingContext2D
  } | null
  /** 抠像处理器注入（截帧必须用全分辨率）。 */
  keyFrame?: import('./clipRender').ClipRenderInput['keyFrame']
}

/**
 * 把 `time` 时刻的画面合成到 `ctx` 上（尺寸为 width×height）。
 *
 * 该函数是纯绘制：只读 project / frames / time，不 seek、不加载、不写状态。
 */
export function composeFrame(input: ComposeFrameInput): void {
  const { ctx, width, height, project, time, frames, createCanvas, keyFrame } = input
  const composition = frameCompositionAt(project, time)

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.filter = 'none'
  // 与预览的 clearFrame 一致：先铺一层画布底色，再按背景设置覆盖。
  ctx.fillStyle = BACKGROUND_FALLBACK
  ctx.fillRect(0, 0, width, height)

  const paintSource = (
    layer: FrameLayer,
    alphaScale = 1,
    targetCtx: CanvasRenderingContext2D = ctx,
  ): void => {
    const frame = frames.get(layer.clip.id)
    if (!frame || frame.width <= 0 || frame.height <= 0) return
    const local = Math.max(0, time - layer.start)
    const overrides = hasAnimation(layer.clip)
      ? resolveClipOverrides(layer.clip, local, layer.duration)
      : undefined
    drawClipFrame({
      ctx: targetCtx,
      clip: layer.clip,
      localTime: local,
      asset: undefined,
      canvasW: width,
      canvasH: height,
      source: frame.source,
      sourceWidth: frame.width,
      sourceHeight: frame.height,
      alphaScale,
      overrides,
      createCanvas,
      keyFrame,
    })
  }

  /**
   * 画布背景：与 Preview.paintBackground 相同的规则。
   * black / color 直接填充；blur（以及 image）用该片段自身画面放大铺满并模糊——
   * 预览目前就是这么画的，截帧跟随预览，保证「所见即所得」。
   */
  const paintBackground = (clip: Clip): void => {
    const background = clipBackground(clip, project)
    if (background.type === 'black' || background.type === 'color') {
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.filter = 'none'
      ctx.fillStyle = backgroundCssColor(background)
      ctx.fillRect(0, 0, width, height)
      ctx.restore()
      return
    }
    const frame = frames.get(clip.id)
    if (!frame || frame.width <= 0 || frame.height <= 0) return
    const scale = Math.max(width / frame.width, height / frame.height)
    const drawWidth = frame.width * scale
    const drawHeight = frame.height * scale
    const blur = backgroundBlurPx(background, height)
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.filter = blur > 0 ? `blur(${blur}px)` : 'none'
    ctx.drawImage(
      frame.source,
      (width - drawWidth) / 2,
      (height - drawHeight) / 2,
      drawWidth,
      drawHeight,
    )
    ctx.filter = 'none'
    ctx.restore()
  }

  /** 转场中间态：与 Preview.paintTransition 一致（近似 xfade 的观感）。 */
  /**
   * 转场：与预览共用 core/transitionRender 的同一份绘制逻辑
   * （截帧与预览看到的必须完全一致）。
   */
  const paintTransition = (
    left: FrameLayer,
    right: FrameLayer,
    progress: number,
    type: TransitionType,
  ): void => {
    paintTransitionFrame({
      ctx,
      width,
      height,
      type,
      progress,
      drawLeft: (target, alpha) => paintSource(left, alpha, target),
      drawRight: (target, alpha) => paintSource(right, alpha, target),
      createCanvas: (w, h) => {
        if (typeof document === 'undefined') return null
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(w))
        canvas.height = Math.max(1, Math.round(h))
        const inner = canvas.getContext('2d')
        return inner ? { canvas, ctx: inner } : null
      },
    })
  }

  if (!composition.mainVisible || composition.main.length === 0) {
    // 主轨隐藏 / 该时刻没有主轨画面：只画叠加轨与文字（底色已铺好）。
    for (const layer of composition.overlays) paintSource(layer)
  } else {
    const base = composition.main[0]
    paintBackground(base.clip)
    if (composition.main.length >= 2) {
      const left = composition.main[0]
      const right = composition.main[1]
      const overlapStart = right.start
      const overlapEnd = Math.min(left.start + left.duration, right.start + right.duration)
      paintTransition(
        left,
        right,
        transitionProgress(overlapStart, overlapEnd, time),
        normalizeTransitionType(left.clip.transitionOut?.type),
      )
    } else {
      paintSource(base)
    }
    for (const layer of composition.overlays) paintSource(layer)
  }

  for (const text of composition.texts) {
    const local = Math.max(0, Math.min(textClipDuration(text.clip), time - text.clip.start))
    drawTextClip(ctx, text.style, width, height, resolveTextOverrides(text.clip, local, text.style))
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.filter = 'none'
}

/**
 * 截帧输出尺寸：直接等于导出设置的分辨率（getOutputDimensions），
 * 不会放大超过参考素材，横竖比例跟随工程。
 */
export function frameCaptureSize(
  project: Project,
  reference?: Pick<SourceInfo, 'width' | 'height'> | null,
): { width: number; height: number } {
  return getOutputDimensions(
    project.aspectRatio,
    project.exportQuality.resolution,
    reference ?? { width: 1920, height: 1080 },
  )
}

/**
 * 截帧文件名：`<素材名>-<时间码>.png`。
 * 时间码复用 core/format 的 formatPlayhead（时:分:秒:帧），冒号换成 `-`
 * 以满足 Windows 文件名限制；素材名去掉扩展名并替换非法字符。
 */
export function frameFileName(
  sourceName: string | null | undefined,
  time: number,
  fps: ExportFps = 30,
): string {
  const base =
    (sourceName ?? '')
      .replace(/\.[^.]+$/, '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
      .trim()
      .slice(0, 64) || 'framecut'
  const code = formatPlayhead(Math.max(0, Number.isFinite(time) ? time : 0), fps).replace(
    /:/g,
    '-',
  )
  return `${base}-${code}.png`
}