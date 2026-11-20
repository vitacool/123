import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { aspectValue } from '../core/aspect'
import { audioClipDuration, audioFadeGain } from '../core/audio'
import { clipFrameSourceAt } from '../core/clipTime'
import { clipGainAt } from '../core/clipAudio'
import {
  BACKGROUND_FALLBACK,
  backgroundBlurPx,
  backgroundCssColor,
  clipBackground,
} from '../core/background'
import { clampPlaybackRate, PLAYBACK_RATE_MIN, PLAYBACK_RATE_MAX } from '../core/speed'
import {
  isAudioTrackActive,
  isMainAudioActive,
  isMainVideoVisible,
  isOverlayAudioActive,
  isOverlayVideoVisible,
  isTextLocked,
  isTextTrackVisible,
} from '../core/tracks'
import { findTextClipLocation, resolveCaptionStyle } from '../core/text'
import { drawTextClip } from '../core/textRender'
import { formatPlayhead } from '../core/format'
import { hasAnimation, resolveClipOverrides } from '../core/animation'
import { drawClipFrame } from '../core/clipRender'
import { sourceFitRect } from '../core/geometry'
import { findClipLocation, findSegmentAt, getProjectEnd, getTimeline, segmentsAt } from '../core/timeline'
import {
  normalizeTransitionType,
  transitionProgress,
} from '../core/transition'
import type { Clip, Project, SourceInfo, TransitionType } from '../core/types'
import type { CropSession, PreviewPatch } from '../store/editorStore'
import { useEditorStore, useEditorStoreApi } from '../store/EditorProvider'
import { CropOverlay } from './CropOverlay'
import { Icon } from './Icon'

interface PreviewProps {
  onPickFile: () => void
  loading: boolean
  error: string | null
  loadingLabel?: string | null
}

interface SourceTarget {
  clip: Clip
  time: number
  /** 主轨为 null，叠加轨为轨道 id（用于取对应的 video 元素）。 */
  trackId?: string | null
}

/**
 * 片段画面的调色绘制：CSS filter（亮度/对比度/饱和度）+ 色温叠加层。
 *
 * 只对「片段画面」调用（背景层、文本层、字幕层不走这里）。绘制完成后立刻把
 * filter 复位为 none、把 globalCompositeOperation / globalAlpha 复原，
 * 否则会污染后续绘制的背景、叠加轨与文本图层。
 */
function getSourceTarget(
  project: Project,
  playhead: number,
  cropSession: CropSession | null,
): SourceTarget | null {
  if (cropSession) {
    // 主轨与叠加轨都支持画面裁剪：按 id 全工程查找。
    const location = findClipLocation(project, cropSession.clipId)
    if (!location) return null
    const segment = location.segment
    const local = Math.min(
      Math.max(0, playhead - segment.start),
      Math.max(0, segment.duration - 1 / 60),
    )
    return {
      clip: segment.clip,
      time: clipFrameSourceAt(segment.clip, local),
      trackId: location.track?.id ?? null,
    }
  }
  const segment = findSegmentAt(project.clips, playhead)
  if (!segment) return null
  const local = Math.max(0, Math.min(segment.duration, playhead - segment.start))
  return {
    clip: segment.clip,
    time: clipFrameSourceAt(segment.clip, local),
  }
}

/** 已提示过的播放速率（按元素去重，避免每帧刷屏）。 */
const speedWarnedRate = new WeakMap<HTMLVideoElement, number>()

type PreviewState = { previewPatch: PreviewPatch | null }

/** 与目标片段匹配的临时预览补丁（未命中返回 null）。 */
function previewClipPatch(state: PreviewState, clipId: string): Partial<Clip> | null {
  const patch = state.previewPatch
  return patch?.clipId === clipId ? patch.patch : null
}

/** 片段音量的预览值（拖动 ClipAudioSection / AudioPropertiesPanel 音量滑块时生效）。 */
function effectiveClipVolume(state: PreviewState, clip: { id: string; volume?: number }): number {
  const patch = state.previewPatch
  if (patch?.clipId === clip.id && typeof patch.patch.volume === 'number') {
    return patch.patch.volume
  }
  return clip.volume ?? 1
}

/** 轨道音量的预览值（拖动「轨道音量」滑块时生效）。 */
function effectiveTrackVolume(
  state: PreviewState,
  track: { id: string; volume: number },
): number {
  const preview = state.previewPatch?.trackVolume
  return preview && preview.trackId === track.id ? preview.volume : track.volume
}

/**
 * 把片段倍率与「保持音调」同步到视频元素；元素播放速度决定声音与画面。
 * 超出浏览器支持的 [0.0625, 16] 时钳制并提示一次（导出仍按真实倍率）。
 */
function applySpeedToVideo(
  video: HTMLVideoElement,
  clip: Clip,
  notify?: (message: string, tone: 'warning') => void,
): void {
  const requested = clip.speed ?? 1
  const { rate, clamped } = clampPlaybackRate(requested)
  if (clamped) {
    const lastWarned = speedWarnedRate.get(video)
    if (lastWarned !== rate) {
      speedWarnedRate.set(video, rate)
      notify?.(
        `预览播放速率仅支持 ${PLAYBACK_RATE_MIN}x – ${PLAYBACK_RATE_MAX}x，` +
          `画面按 ${rate}x 播放；导出仍按 ${Number(requested.toFixed(2))}x。`,
        'warning',
      )
    }
  } else {
    speedWarnedRate.delete(video)
  }
  if (Math.abs(video.playbackRate - rate) > 0.001) {
    try {
      video.playbackRate = rate
    } catch {
      // 极少数环境仍会拒绝赋值：提示一次，不阻断绘制。
      if (speedWarnedRate.get(video) !== -1) {
        speedWarnedRate.set(video, -1)
        notify?.(`当前浏览器拒绝了 ${rate}x 的播放速率，预览按原速播放。`, 'warning')
      }
    }
  }
  const keepPitch = clip.keepPitch !== false
  const target = video as HTMLVideoElement & {
    preservesPitch?: boolean
    webkitPreservesPitch?: boolean
    mozPreservesPitch?: boolean
  }
  if (target.preservesPitch !== keepPitch) target.preservesPitch = keepPitch
  if (target.webkitPreservesPitch !== keepPitch) target.webkitPreservesPitch = keepPitch
  if (target.mozPreservesPitch !== keepPitch) target.mozPreservesPitch = keepPitch
}

const safeMediaTime = (time: number, source: SourceInfo, video?: HTMLVideoElement | null): number => {
  const maximum = Math.max(
    0,
    Math.min(
      source.duration > 0 ? source.duration : Number.POSITIVE_INFINITY,
      video && Number.isFinite(video.duration) ? video.duration : Number.POSITIVE_INFINITY,
    ) - 0.001,
  )
  return Math.min(Math.max(0, time), maximum)
}

export function Preview({ onPickFile, loading, error, loadingLabel }: PreviewProps) {
  const store = useEditorStoreApi()
  const source = useEditorStore((state) => state.source)
  const assets = useEditorStore((state) => state.assets)
  const project = useEditorStore((state) => state.project)
  const playhead = useEditorStore((state) => state.playhead)
  const isPlaying = useEditorStore((state) => state.isPlaying)
  const selectedClipId = useEditorStore((state) => state.selectedClipId)
  const cropSession = useEditorStore((state) => state.cropSession)
  const cover = useEditorStore((state) => state.project.cover)
  const coverPreview = useEditorStore((state) => state.coverPreview)
  const previewPatch = useEditorStore((state) => state.previewPatch)
  const setPreviewPatch = useEditorStore((state) => state.setPreviewPatch)
  const setPosition = useEditorStore((state) => state.setPosition)
  const selectClip = useEditorStore((state) => state.selectClip)
  const updateTextClip = useEditorStore((state) => state.updateTextClip)
  const updateCaptionStyle = useEditorStore((state) => state.updateCaptionStyle)
  const captionApplyAll = useEditorStore((state) => state.captionApplyAll)
  const captionStylePreview = useEditorStore((state) => state.captionStylePreview)
  const previewFullscreen = useEditorStore((state) => state.previewFullscreen)
  const setPreviewFullscreen = useEditorStore((state) => state.setPreviewFullscreen)
  const setPlaying = useEditorStore((state) => state.setPlaying)
  const replay = useEditorStore((state) => state.replay)

  const stageRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const baseVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map())
  const audioRefs = useRef<Map<string, HTMLAudioElement>>(new Map())
  const paintedRef = useRef(false)
  const overlayVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map())
  /** 已解码的图片素材（url → Image），供 Canvas 直接绘制。 */
  const imageRefs = useRef<Map<string, HTMLImageElement>>(new Map())
  const drawRef = useRef<() => void>(() => undefined)
  const dragRef = useRef<{
    pointerId: number
    clipId: string
    startX: number
    startY: number
    posX: number
    posY: number
    x: number
    y: number
  } | null>(null)
  const [frame, setFrame] = useState({ width: 0, height: 0 })
  const [dragging, setDragging] = useState(false)
  const [textDragging, setTextDragging] = useState(false)
  const textDragRef = useRef<{
    pointerId: number
    trackId: string
    clipId: string
    startX: number
    startY: number
    origX: number
    origY: number
    x: number
    y: number
    dx: number
    dy: number
    isCaption: boolean
    applyAll: boolean
    moved: boolean
  } | null>(null)

  const aspect = useMemo(
    () => aspectValue(project.aspectRatio, source),
    [project.aspectRatio, source],
  )
  const totalDuration = useMemo(() => getProjectEnd(project), [project])
  const overlayTrackKey = useMemo(
    () =>
      (project.overlayTracks ?? [])
        .map((track) => {
          const segment = findSegmentAt(track.clips, playhead)
          return `${track.id}:${segment?.clip.sourceUrl ?? ''}`
        })
        .join('|'),
    [project.overlayTracks, playhead],
  )
  const activeSegment = useMemo(
    () => findSegmentAt(project.clips, playhead),
    [project.clips, playhead],
  )
  const assetByUrl = useMemo(
    () => new Map(assets.map((asset) => [asset.url, asset])),
    [assets],
  )
  const assetForClip = useCallback(
    (clip: Clip): SourceInfo | null => assetByUrl.get(clip.sourceUrl) ?? source,
    [assetByUrl, source],
  )
  const baseAsset = activeSegment ? assetForClip(activeSegment.clip) : source
  const baseVideoUrls = useMemo(() => {
    const urls: string[] = []
    const seen = new Set<string>()
    for (const clip of project.clips) {
      if (seen.has(clip.sourceUrl)) continue
      seen.add(clip.sourceUrl)
      urls.push(clip.sourceUrl)
    }
    if (source && !seen.has(source.url)) urls.push(source.url)
    return urls
  }, [project.clips, source])
  const baseVideoKey = baseVideoUrls.join('|')
  const timecodeFps = project.exportQuality.fps

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const measure = () => {
      const availableWidth = Math.max(160, stage.clientWidth - 32)
      const availableHeight = Math.max(120, stage.clientHeight - 32)
      let width = Math.min(availableWidth, availableHeight * aspect)
      if (!Number.isFinite(width) || width <= 0) width = availableWidth
      const height = width / aspect
      setFrame((previous) => {
        const next = { width: Math.round(width), height: Math.round(height) }
        if (
          Math.abs(previous.width - next.width) < 1 &&
          Math.abs(previous.height - next.height) < 1
        ) {
          return previous
        }
        return next
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [aspect])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const state = store.getState()
    const currentSource = state.source
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const width = canvas.width
    const height = canvas.height
    const clearFrame = () => {
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.filter = 'none'
      context.fillStyle = BACKGROUND_FALLBACK
      context.fillRect(0, 0, width, height)
    }

    /**
     * 画布背景：片段画面未铺满时先铺一层底。
     * - black / color：直接填充
     * - image：等比铺满后裁切
     * - blur：用该片段自身画面放大铺满并高斯模糊（Canvas filter）
     */
    const paintBackground = (clip: Clip, source: CanvasImageSource | null, sw: number, sh: number) => {
      // 拖动背景模糊滑块时，优先用临时预览值（不写 project）。
      const background =
        state.previewPatch?.canvasBackground ?? clipBackground(clip, state.project)
      if (background.type === 'black' || background.type === 'color') {
        context.save()
        context.setTransform(1, 0, 0, 1, 0, 0)
        context.filter = 'none'
        context.fillStyle = backgroundCssColor(background)
        context.fillRect(0, 0, width, height)
        context.restore()
        return
      }
      if (!source || sw <= 0 || sh <= 0) return
      context.save()
      context.setTransform(1, 0, 0, 1, 0, 0)
      // 等比铺满画布（cover），再按画布裁切。
      const scale = Math.max(width / sw, height / sh)
      const dw = sw * scale
      const dh = sh * scale
      const blur = backgroundBlurPx(background)
      context.filter = blur > 0 ? `blur(${blur}px)` : 'none'
      context.drawImage(source, (width - dw) / 2, (height - dh) / 2, dw, dh)
      context.filter = 'none'
      context.restore()
    }
    context.setTransform(1, 0, 0, 1, 0, 0)

    if (!currentSource && state.assets.length === 0) {
      clearFrame()
      return
    }
    const resolveAsset = (clip: Clip): SourceInfo | null =>
      state.assets.find((asset) => asset.url === clip.sourceUrl) ?? currentSource
    // 素材已从素材库移除：该片段不绘制，画布背景留着（主轨 / 叠加轨 / 转场都适用）。
    const isMissing = (clip: Clip): boolean =>
      !state.assets.some((asset) => asset.url === clip.sourceUrl)

    const paintSource = (
      clip: Clip,
      source: CanvasImageSource | null,
      sourceWidth: number,
      sourceHeight: number,
      alphaOverride?: number,
    ) => {
      if (!source || sourceWidth <= 0 || sourceHeight <= 0) return
      if (isMissing(clip)) return
      const clipSource = resolveAsset(clip)
      if (!clipSource) return
      const patch = state.previewPatch
      const effective = patch && patch.clipId === clip.id ? { ...clip, ...patch.patch } : clip
      // 关键帧：把片段本地时间换算成动画时间后求值；没有动画的片段不额外计算。
      const located = hasAnimation(effective) ? findClipLocation(state.project, clip.id) : null
      const overrides =
        located && hasAnimation(effective)
          ? resolveClipOverrides(
              effective,
              Math.max(0, state.playhead - located.segment.start),
              located.segment.duration,
            )
          : undefined
      // 几何变换 + 裁剪/翻转/旋转/缩放/位置 + 不透明度/混合模式 + 调色
      // 全部收敛到 core/clipRender.drawClipFrame，预览与导出逐帧渲染共用同一份实现。
      drawClipFrame({
        ctx: context,
        clip: effective,
        localTime: 0,
        asset: clipSource,
        canvasW: width,
        canvasH: height,
        source,
        sourceWidth,
        sourceHeight,
        alphaScale: alphaOverride ?? 1,
        overrides,
      })
    }

    const paintClip = (clip: Clip, layerVideo: HTMLVideoElement | null) => {
      if (!layerVideo || layerVideo.readyState < 2 || layerVideo.videoWidth === 0) return
      paintSource(clip, layerVideo, layerVideo.videoWidth, layerVideo.videoHeight)
    }

    /** 图片片段：用已解码的 Image 直接绘制。 */
    const paintImageClip = (clip: Clip) => {
      const image = imageRefs.current.get(clip.sourceUrl)
      if (!image || !image.complete) return
      paintSource(clip, image, image.naturalWidth, image.naturalHeight)
    }

    /** 取某个片段可用于绘制的画面源（视频元素 / 已解码图片）。 */
    const sourceFor = (clip: Clip): { source: CanvasImageSource; w: number; h: number } | null => {
      if (isMissing(clip)) return null
      if (clip.type === 'image') {
        const image = imageRefs.current.get(clip.sourceUrl)
        if (!image || !image.complete) return null
        return { source: image, w: image.naturalWidth, h: image.naturalHeight }
      }
      const video = baseVideoRefs.current.get(clip.sourceUrl) ?? null
      if (!video || video.readyState < 2 || video.videoWidth === 0) return null
      return { source: video, w: video.videoWidth, h: video.videoHeight }
    }

    /**
     * 转场合成：先画左段（保持不透明），再按进度叠加右段。
     * 淡入淡出/黑场/圆形展开用 alpha 逼近；擦除/滑动用位移裁剪逼近，
     * 与导出侧 xfade 的 transition 类型对应。
     */
    const paintTransition = (
      left: Clip,
      right: Clip,
      progress: number,
      type: TransitionType,
    ) => {
      const leftSource = sourceFor(left)
      if (leftSource) paintSource(left, leftSource.source, leftSource.w, leftSource.h)
      const rightSource = sourceFor(right)
      if (!rightSource) return
      const p = Math.max(0, Math.min(1, progress))
      if (type === 'fadeblack') {
        // 黑场：前 1/2 左段淡出到黑，后 1/2 右段淡入。
        if (p < 0.5) {
          // 左段已被完整绘制，用黑色以 2p 的强度压暗。
          context.save()
          context.globalAlpha = Math.min(1, p * 2)
          context.fillStyle = '#000'
          context.fillRect(0, 0, width, height)
          context.restore()
          return
        }
        paintSource(right, rightSource.source, rightSource.w, rightSource.h, (p - 0.5) * 2)
        return
      }
      if (type === 'wipeleft' || type === 'slideleft') {
        // 擦除/滑动：右段从右侧推入，露出宽度随进度增长。
        const offsetX = type === 'slideleft' ? (1 - p) * width : 0
        context.save()
        context.beginPath()
        context.rect(width * (1 - p) + offsetX, 0, width, height)
        context.clip()
        paintSource(right, rightSource.source, rightSource.w, rightSource.h)
        context.restore()
        return
      }
      if (type === 'circleopen') {
        // 圆形展开：以画面中心为圆心的圆形裁切逐帧放大。
        const radius = p * Math.hypot(width, height) * 0.5
        context.save()
        context.beginPath()
        context.arc(width / 2, height / 2, Math.max(0, radius), 0, Math.PI * 2)
        context.clip()
        paintSource(right, rightSource.source, rightSource.w, rightSource.h)
        context.restore()
        return
      }
      // fade：右段按进度淡入。
      paintSource(right, rightSource.source, rightSource.w, rightSource.h, p)
    }

    const paintText = () => {
      const textDrag = textDragRef.current
      for (const track of state.project.textTracks ?? []) {
        if (!isTextTrackVisible(track)) continue
        for (const clip of track.clips) {
          if (clip.link?.linkHidden) continue
          if (
            state.playhead >= clip.start - 0.001 &&
            state.playhead < clip.end - 0.001
          ) {
            const stylePreview = captionStylePreview?.trackId === track.id ? captionStylePreview.style : undefined
            let display = resolveCaptionStyle(clip, stylePreview ? { ...track.captionStyle, ...stylePreview } : track.captionStyle)
            if (textDrag) {
              if (textDrag.applyAll && textDrag.trackId === track.id) {
                display = { ...display, x: display.x + textDrag.dx, y: display.y + textDrag.dy }
              } else if (!textDrag.applyAll && textDrag.clipId === clip.id) {
                display = { ...display, x: textDrag.x, y: textDrag.y }
              }
            }
            drawTextClip(context, display, width, height)
          }
        }
      }
    }

    if (state.cropSession) {
      clearFrame()
      const target = getSourceTarget(state.project, state.playhead, state.cropSession)
      const targetAsset = target ? resolveAsset(target.clip) : null
      const targetVideo = target
        ? target.trackId
          ? overlayVideoRefs.current.get(target.trackId) ?? null
          : baseVideoRefs.current.get(target.clip.sourceUrl) ?? null
        : null
      if (!target || !targetAsset || !targetVideo || targetVideo.readyState < 2) return
      const fit = sourceFitRect(targetAsset.width, targetAsset.height, width, height)
      context.drawImage(
        targetVideo,
        0,
        0,
        targetVideo.videoWidth,
        targetVideo.videoHeight,
        fit.x,
        fit.y,
        fit.w,
        fit.h,
      )
      return
    }

    const baseSegment = findSegmentAt(state.project.clips, state.playhead)
    if (!isMainVideoVisible(state.project) || !baseSegment) {
      clearFrame()
      for (const track of state.project.overlayTracks ?? []) {
        if (!isOverlayVideoVisible(track)) continue
        const segment = findSegmentAt(track.clips, state.playhead)
        if (!segment) continue
        if (segment.clip.type === 'image') paintImageClip(segment.clip)
        else paintClip(segment.clip, overlayVideoRefs.current.get(track.id) ?? null)
      }
      paintText()
      paintedRef.current = true
      return
    }

    const baseVideo = baseVideoRefs.current.get(baseSegment.clip.sourceUrl) ?? null
    const baseIsImage = baseSegment.clip.type === 'image'
    if (!baseIsImage && (!baseVideo || baseVideo.readyState < 2 || baseVideo.videoWidth === 0)) {
      // Keep the last rendered frame on screen while the next source loads or
      // seeks, so a clip switch never flashes a black canvas.
      if (!paintedRef.current) {
        clearFrame()
        paintedRef.current = true
      }
      return
    }

    clearFrame()
    // 背景：先铺底，再画片段画面（片段未铺满时露出背景）。
    const baseSourceForBg = baseIsImage
      ? (() => {
          const image = imageRefs.current.get(baseSegment.clip.sourceUrl)
          return image && image.complete
            ? { source: image as CanvasImageSource, w: image.naturalWidth, h: image.naturalHeight }
            : null
        })()
      : baseVideo && baseVideo.readyState >= 2
        ? { source: baseVideo as CanvasImageSource, w: baseVideo.videoWidth, h: baseVideo.videoHeight }
        : null
    if (baseSourceForBg) {
      paintBackground(
        baseSegment.clip,
        baseSourceForBg.source,
        baseSourceForBg.w,
        baseSourceForBg.h,
      )
    } else {
      paintBackground(baseSegment.clip, null, 0, 0)
    }
    // 转场重叠区：同时合成两段，按进度做淡入淡出/擦除/滑动等近似效果。
    const overlapping = segmentsAt(state.project.clips, state.playhead)
    if (overlapping.length >= 2) {
      const [leftSegment, rightSegment] = overlapping
      const overlapStart = rightSegment.start
      const overlapEnd = Math.min(leftSegment.end, rightSegment.end)
      const progress = transitionProgress(overlapStart, overlapEnd, state.playhead)
      const type = normalizeTransitionType(leftSegment.clip.transitionOut?.type)
      paintTransition(
        leftSegment.clip,
        rightSegment.clip,
        progress,
        type,
      )
    } else if (baseIsImage) {
      paintImageClip(baseSegment.clip)
    } else if (baseVideo) {
      paintClip(baseSegment.clip, baseVideo)
    }

    for (const track of state.project.overlayTracks ?? []) {
      if (!isOverlayVideoVisible(track)) continue
      const segment = findSegmentAt(track.clips, state.playhead)
      if (!segment) continue
      if (segment.clip.type === 'image') {
        paintImageClip(segment.clip)
      } else {
        paintClip(segment.clip, overlayVideoRefs.current.get(track.id) ?? null)
      }
    }
    paintText()
    paintedRef.current = true
  }, [store])

  drawRef.current = draw

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || frame.width <= 0 || frame.height <= 0) return
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.max(2, Math.round(frame.width * ratio))
    canvas.height = Math.max(2, Math.round(frame.height * ratio))
    paintedRef.current = false
    draw()
  }, [frame.width, frame.height, draw])

  const syncAudio = useCallback(
    (
      state: ReturnType<typeof store.getState>,
      time: number,
      playing: boolean,
    ) => {
      for (const track of state.project.audioTracks ?? []) {
        for (const clip of track.clips) {
          const element = audioRefs.current.get(clip.id)
          if (!element) continue
          const duration = audioClipDuration(clip)
          const local = time - clip.start
          const active =
            isAudioTrackActive(state.project, track) &&
            local >= -0.01 &&
            local < duration
          if (!active) {
            if (!element.paused) element.pause()
            element.muted = true
            continue
          }
          const target = clipFrameSourceAt(clip, Math.max(0, local))
          if (Math.abs(element.currentTime - target) > 0.15) {
            try {
              element.currentTime = target
            } catch {
              // The media may still be loading.
            }
          }
          const gain = active
            ? Math.min(
                1,
                Math.max(
                  0,
                  effectiveTrackVolume(state, track) *
                    effectiveClipVolume(state, clip) *
                    audioFadeGain(clip, Math.max(0, local)),
                ),
              )
            : 0
          element.volume = gain
          element.muted = gain <= 0.001
          if (playing) {
            if (element.paused) void element.play().catch(() => undefined)
          } else if (!element.paused) {
            element.pause()
          }
        }
      }
    },
    [store],
  )

  const syncPausedFrame = useCallback(
    (force: boolean) => {
      const state = store.getState()
      const currentSource = state.source
      if (!currentSource && state.assets.length === 0) return
      const resolveAsset = (clip: Clip): SourceInfo | null =>
        state.assets.find((asset) => asset.url === clip.sourceUrl) ?? currentSource
      for (const element of baseVideoRefs.current.values()) {
        if (!element.paused) element.pause()
        element.muted = true
      }
      const target = getSourceTarget(state.project, state.playhead, state.cropSession)
      if (target) {
        const targetAsset = resolveAsset(target.clip)
        const video = baseVideoRefs.current.get(target.clip.sourceUrl) ?? null
        if (targetAsset && video) {
          const nextTime = safeMediaTime(target.time, targetAsset, video)
          if (force || Math.abs(video.currentTime - nextTime) > 0.035) {
            try {
              video.currentTime = nextTime
            } catch {
              // The media may still be loading; a later event will retry.
            }
          }
        }
      }

      for (const track of state.project.overlayTracks ?? []) {
        const layerVideo = overlayVideoRefs.current.get(track.id)
        if (!layerVideo) continue
        const segment = findSegmentAt(track.clips, state.playhead)
        // 叠加轨声音按轨道 muted/solo 与片段音量/淡入淡出参与混音。
        const audioActive = isOverlayAudioActive(state.project, track)
        layerVideo.muted = !audioActive || !segment
        if (segment) {
          const local = Math.max(0, Math.min(segment.duration, state.playhead - segment.start))
          layerVideo.volume = Math.max(
            0,
            Math.min(1, clipGainAt({ ...segment.clip, ...(previewClipPatch(state, segment.clip.id) ?? {}) }, local)),
          )
        }
        if (isOverlayVideoVisible(track) && segment) {
          const segmentAsset = resolveAsset(segment.clip)
          if (!segmentAsset) continue
          const local = Math.max(0, Math.min(segment.duration, state.playhead - segment.start))
          const targetTime = clipFrameSourceAt(segment.clip, local)
          const nextTime = safeMediaTime(targetTime, segmentAsset, layerVideo)
          if (force || Math.abs(layerVideo.currentTime - nextTime) > 0.035) {
            try {
              layerVideo.currentTime = nextTime
            } catch {
              // The media may still be loading; a later event will retry.
            }
          }
        }
        layerVideo.pause()
      }

      syncAudio(state, state.playhead, false)
      draw()
    },
    [draw, store, syncAudio],
  )

  useEffect(() => {
    if (isPlaying) return
    syncPausedFrame(false)
  }, [
    isPlaying,
    playhead,
    project,
    cropSession,
    previewPatch,
    source,
    frame.width,
    frame.height,
    syncPausedFrame,
  ])

  useEffect(() => {
    if (!isPlaying) return
    const currentSource = source
    if (!currentSource && assets.length === 0) return
    const stateAtStart = store.getState()
    const total = getProjectEnd(stateAtStart.project)
    if (total <= 0) {
      setPlaying(false)
      return
    }
    const timeline = getTimeline(stateAtStart.project.clips)
    const startPlayhead = stateAtStart.playhead
    const started = performance.now()
    let activeElement: HTMLVideoElement | null = null
    let activeClipId: string | null = null
    let preparedClipId: string | null = null
    let lastSeek = 0
    let lastPlayAttempt = 0
    let playBlockedAt = 0
    let raf = 0
    const overlayRuntimes = new Map<string, { clipId: string | null; lastSeek: number }>()

    const syncOverlayPlayback = (state: ReturnType<typeof store.getState>, time: number, now: number) => {
      for (const track of state.project.overlayTracks ?? []) {
        const layerVideo = overlayVideoRefs.current.get(track.id)
        if (!layerVideo) continue
        const audioActive = isOverlayAudioActive(state.project, track)
        const segment = findSegmentAt(track.clips, time)
        const activeSegment = segment && isOverlayVideoVisible(track) ? segment : null
        layerVideo.muted = !audioActive || activeSegment === null
        if (activeSegment) {
          const local = Math.max(0, Math.min(activeSegment.duration, time - activeSegment.start))
          layerVideo.volume = Math.max(
            0,
            Math.min(
              1,
              clipGainAt(
                { ...activeSegment.clip, ...(previewClipPatch(state, activeSegment.clip.id) ?? {}) },
                local,
              ),
            ),
          )
        }
        if (!segment || !isOverlayVideoVisible(track)) {
          if (!layerVideo.paused) layerVideo.pause()
          overlayRuntimes.set(track.id, { clipId: null, lastSeek: 0 })
          continue
        }
        const runtime = overlayRuntimes.get(track.id) ?? { clipId: null, lastSeek: 0 }
        const segmentAsset =
          state.assets.find((asset) => asset.url === segment.clip.sourceUrl) ?? currentSource
        if (!segmentAsset) continue
        const switching = runtime.clipId !== segment.clip.id
        const local = Math.max(0, Math.min(segment.duration, time - segment.start))
        if (segment.clip.type === 'freeze') {
          if (!layerVideo.paused) layerVideo.pause()
          const frameTime = safeMediaTime(
            clipFrameSourceAt(segment.clip, local),
            segmentAsset,
            layerVideo,
          )
          const needsSeek = switching || Math.abs(layerVideo.currentTime - frameTime) > 0.08
          if (needsSeek && (switching || now - runtime.lastSeek > 220)) {
            try {
              layerVideo.currentTime = frameTime
            } catch {
              // Ignore transient seek errors.
            }
            runtime.lastSeek = now
          }
        } else {
          const target = safeMediaTime(
            clipFrameSourceAt(segment.clip, local),
            segmentAsset,
            layerVideo,
          )
          applySpeedToVideo(layerVideo, segment.clip, (message, tone) =>
            store.getState().notify(message, tone),
          )
          if (
            switching ||
            (now - runtime.lastSeek > 450 && Math.abs(layerVideo.currentTime - target) > 0.38)
          ) {
            try {
              layerVideo.currentTime = target
            } catch {
              // Ignore transient seek errors.
            }
            runtime.lastSeek = now
          }
          if (layerVideo.paused) {
            void layerVideo.play().catch(() => undefined)
          }
        }
        runtime.clipId = segment.clip.id
        overlayRuntimes.set(track.id, runtime)
      }
    }

    const prepareNext = (
      state: ReturnType<typeof store.getState>,
      time: number,
      currentUrl: string | null,
    ) => {
      const next = timeline.find((segment) => segment.start > time + 0.001)
      if (!next || next.start - time > 1.5) return
      if (next.clip.sourceUrl === currentUrl) return
      if (preparedClipId === next.clip.id) return
      const element = baseVideoRefs.current.get(next.clip.sourceUrl)
      const asset =
        state.assets.find((item) => item.url === next.clip.sourceUrl) ?? currentSource
      if (!element || !asset) return
      // Wait for metadata before seeking; otherwise the seek is dropped and
      // the next clip would start from the wrong source position.
      if (element.readyState < 1) return
      const frame = clipFrameSourceAt(next.clip, 0)
      element.pause()
      element.muted = true
      try {
        element.currentTime = safeMediaTime(frame, asset, element)
        preparedClipId = next.clip.id
      } catch {
        preparedClipId = null
      }
    }

    const tick = (now: number) => {
      const state = store.getState()
      if (!state.isPlaying) return
      const elapsed = (now - started) / 1000
      const time = Math.min(total, startPlayhead + elapsed)
      const segment = findSegmentAt(state.project.clips, time)
      if (!segment) {
        // A trim gap: show black plus any overlay tracks, keep advancing.
        if (activeElement) {
          if (!activeElement.paused) activeElement.pause()
          activeElement.muted = true
        }
        activeClipId = null
        prepareNext(state, time, null)
        syncOverlayPlayback(state, time, now)
        syncAudio(state, time, true)
        state.setPlayhead(time)
        drawRef.current()
        if (time >= total - 0.001) {
          state.setPlayhead(total)
          state.finishPlayback()
          drawRef.current()
          return
        }
        raf = requestAnimationFrame(tick)
        return
      }
      const clip = segment.clip
      const clipAsset =
        state.assets.find((asset) => asset.url === clip.sourceUrl) ?? currentSource
      const video = baseVideoRefs.current.get(clip.sourceUrl) ?? null
      if (!clipAsset || !video) {
        raf = requestAnimationFrame(tick)
        return
      }
      const switching = activeClipId !== clip.id || activeElement !== video
      if (activeElement && activeElement !== video) {
        if (!activeElement.paused) activeElement.pause()
        activeElement.muted = true
      }
      activeElement = video
      video.muted = !isMainAudioActive(state.project)
      {
        // 片段音量/淡入淡出 + 临时预览：拖动音量滑块时能立刻听到变化。
        const local = Math.max(0, Math.min(segment.duration, time - segment.start))
        const gain = clipGainAt(
          { ...clip, ...(previewClipPatch(state, clip.id) ?? {}) },
          local,
        )
        video.volume = Math.max(0, Math.min(1, gain))
      }
      if (switching) {
        preparedClipId = null
        playBlockedAt = 0
      }
      if (clip.type === 'freeze') {
        if (!video.paused) video.pause()
        const frameTime = safeMediaTime(
          clipFrameSourceAt(clip, 0),
          clipAsset,
          video,
        )
        const needsFreezeSeek =
          switching || Math.abs(video.currentTime - frameTime) > 0.08
        if (needsFreezeSeek && (switching || now - lastSeek > 220)) {
          try {
            video.currentTime = frameTime
          } catch {
            // Ignore transient seek errors.
          }
          lastSeek = now
        }
      } else {
        const expected = clipFrameSourceAt(clip, time - segment.start)
        const target = safeMediaTime(expected, clipAsset, video)
        applySpeedToVideo(video, clip, (message, tone) => store.getState().notify(message, tone))
        if (
          switching ||
          (now - lastSeek > 450 && Math.abs(video.currentTime - target) > 0.38)
        ) {
          try {
            video.currentTime = target
          } catch {
            // Ignore transient seek errors.
          }
          lastSeek = now
        }
        if (switching && video.paused) {
          lastPlayAttempt = now
          void video.play().catch(() => undefined)
        }
        if (!video.paused) {
          playBlockedAt = 0
        } else if (now - lastPlayAttempt > 260) {
          lastPlayAttempt = now
          void video.play().then(
            () => {
              playBlockedAt = 0
            },
            () => {
              if (playBlockedAt === 0) playBlockedAt = now
            },
          )
        }
        if (playBlockedAt !== 0 && now - playBlockedAt > 1600) {
          const latest = store.getState()
          latest.setPlaying(false)
          latest.notify('浏览器阻止了视频播放，请再次点击播放。', 'warning')
          return
        }
      }
      prepareNext(state, time, clip.sourceUrl)
      syncOverlayPlayback(state, time, now)
      syncAudio(state, time, true)
      activeClipId = clip.id
      state.setPlayhead(time)
      drawRef.current()
      if (time >= total - 0.001) {
        state.setPlayhead(total)
        state.finishPlayback()
        drawRef.current()
        return
      }
      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      for (const element of baseVideoRefs.current.values()) {
        if (!element.paused) element.pause()
        element.muted = true
      }
      for (const layerVideo of overlayVideoRefs.current.values()) layerVideo.pause()
      for (const audio of audioRefs.current.values()) audio.pause()
    }
  }, [isPlaying, source, store, setPlaying, assets.length])

  useEffect(() => {
    // 预解码所有图片素材，加载完成后重绘（图片不依赖 video 的 timeupdate）。
    const urls = new Set<string>()
    for (const asset of assets) {
      if (asset.kind === 'image') urls.add(asset.url)
    }
    for (const clip of store.getState().project.clips) {
      if (clip.type === 'image') urls.add(clip.sourceUrl)
    }
    for (const track of store.getState().project.overlayTracks ?? []) {
      for (const clip of track.clips) {
        if (clip.type === 'image') urls.add(clip.sourceUrl)
      }
    }
    for (const url of urls) {
      if (imageRefs.current.has(url)) continue
      const image = new Image()
      image.onload = () => {
        imageRefs.current.set(url, image)
        drawRef.current()
      }
      image.src = url
    }
  }, [assets, store])

  useEffect(() => {
    const redraw = () => drawRef.current()
    const events = ['loadeddata', 'loadedmetadata', 'canplay', 'seeked'] as const
    const videos = [...baseVideoRefs.current.values()]
    for (const video of videos) {
      for (const event of events) video.addEventListener(event, redraw)
    }
    return () => {
      for (const video of videos) {
        for (const event of events) video.removeEventListener(event, redraw)
      }
    }
  }, [baseVideoKey])

  useEffect(() => {
    const redraw = () => drawRef.current()
    const events = ['loadeddata', 'loadedmetadata', 'canplay', 'seeked'] as const
    const videos = [...overlayVideoRefs.current.values()]
    for (const video of videos) {
      for (const event of events) video.addEventListener(event, redraw)
    }
    return () => {
      for (const video of videos) {
        for (const event of events) video.removeEventListener(event, redraw)
      }
    }
  }, [baseVideoKey, overlayTrackKey])

  useEffect(() => {
    if ((assets.length === 0 && !source) || isPlaying) return
    syncPausedFrame(true)
  }, [baseAsset?.url, overlayTrackKey, isPlaying, syncPausedFrame])

  const selectedTextLocation = findTextClipLocation(project, selectedClipId)
  const canTextDrag =
    Boolean(selectedTextLocation) &&
    !isTextLocked(selectedTextLocation!.track) &&
    !isPlaying &&
    !cropSession

  const canDrag =
    Boolean(baseAsset) &&
    !isPlaying &&
    !cropSession &&
    Boolean(activeSegment) &&
    activeSegment?.clip.id === selectedClipId

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const selectedText = findTextClipLocation(
      store.getState().project,
      store.getState().selectedClipId,
    )
    if (
      selectedText &&
      !isTextLocked(selectedText.track) &&
      !isPlaying &&
      !cropSession
    ) {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      const resolved = resolveCaptionStyle(selectedText.clip, selectedText.track.captionStyle)
      const isCaption = selectedText.track.kind === 'caption'
      textDragRef.current = {
        pointerId: event.pointerId,
        trackId: selectedText.track.id,
        clipId: selectedText.clip.id,
        startX: event.clientX,
        startY: event.clientY,
        origX: resolved.x,
        origY: resolved.y,
        x: resolved.x,
        y: resolved.y,
        dx: 0,
        dy: 0,
        isCaption,
        applyAll: isCaption && captionApplyAll,
        moved: false,
      }
      setTextDragging(true)
      return
    }
    if (!baseAsset || !activeSegment || isPlaying || cropSession) return
    if (activeSegment.clip.id !== selectedClipId) {
      selectClip(activeSegment.clip.id)
      return
    }
    const clip = activeSegment.clip
    const base = previewPatch?.clipId === clip.id ? { ...clip, ...previewPatch.patch } : clip
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      clipId: clip.id,
      startX: event.clientX,
      startY: event.clientY,
      posX: base.position.x,
      posY: base.position.y,
      x: base.position.x,
      y: base.position.y,
    }
    setDragging(true)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const textDrag = textDragRef.current
    if (
      textDrag &&
      textDrag.pointerId === event.pointerId &&
      frame.width > 0 &&
      frame.height > 0
    ) {
      event.preventDefault()
      const nextX = Math.max(
        0,
        Math.min(1, textDrag.origX + (event.clientX - textDrag.startX) / frame.width),
      )
      const nextY = Math.max(
        0,
        Math.min(1, textDrag.origY + (event.clientY - textDrag.startY) / frame.height),
      )
      textDrag.x = nextX
      textDrag.y = nextY
      textDrag.dx = nextX - textDrag.origX
      textDrag.dy = nextY - textDrag.origY
      textDrag.moved = textDrag.moved || Math.abs(nextX - textDrag.origX) > 0.002 || Math.abs(nextY - textDrag.origY) > 0.002
      drawRef.current()
      return
    }
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId || frame.width <= 0 || frame.height <= 0) {
      return
    }
    const nextX = Math.max(-2, Math.min(2, drag.posX + (event.clientX - drag.startX) / frame.width))
    const nextY = Math.max(-2, Math.min(2, drag.posY + (event.clientY - drag.startY) / frame.height))
    drag.x = nextX
    drag.y = nextY
    setPreviewPatch({ clipId: drag.clipId, patch: { position: { x: nextX, y: nextY } } })
  }

  const finishDrag = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const textDrag = textDragRef.current
    if (textDrag && textDrag.pointerId === event.pointerId) {
      textDragRef.current = null
      setTextDragging(false)
      try {
        event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {
        // Pointer capture may already be gone.
      }
      if (textDrag.moved) {
        if (textDrag.isCaption) {
          updateCaptionStyle(
            textDrag.trackId,
            textDrag.clipId,
            { x: textDrag.x, y: textDrag.y },
            textDrag.applyAll,
            '拖动字幕位置',
          )
        } else {
          updateTextClip(
            textDrag.trackId,
            textDrag.clipId,
            { x: textDrag.x, y: textDrag.y },
            '拖动文本位置',
          )
        }
      } else {
        drawRef.current()
      }
      return
    }
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // Pointer capture may already be gone.
    }
    setPosition(drag.x, drag.y)
    setPreviewPatch(null)
  }

  const empty = (assets.length === 0 && !source) || totalDuration <= 0
  const frameStyle = frame.width > 0 ? { width: frame.width, height: frame.height } : undefined
  const hasSourceButNoClips =
    (assets.length > 0 || Boolean(source)) && totalDuration <= 0

  return (
    <section
      className={`preview-pane${previewFullscreen ? ' is-fullscreen' : ''}`}
      aria-label="预览"
    >
      <div className="preview-stage" ref={stageRef}>
        <div className="preview-halo" aria-hidden="true" />
        <div className="preview-frame" style={frameStyle}>
          <canvas
            ref={canvasRef}
            className={`preview-canvas${canDrag || canTextDrag ? ' is-draggable' : ''}${dragging || textDragging ? ' is-dragging' : ''}`}
            aria-label="视频画面预览"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
          />
          {cover && (coverPreview || (playhead <= 0.001 && cover.mode === 'first-frame')) && (
            <img
              className="preview-cover-overlay"
              src={cover.dataUrl}
              alt="封面预览"
              draggable={false}
            />
          )}
          {assets.length > 0 && (
            <>
              {baseVideoUrls.map((url) => (
                <video
                  key={url}
                  ref={(element) => {
                    if (element) baseVideoRefs.current.set(url, element)
                    else baseVideoRefs.current.delete(url)
                  }}
                  className="preview-video-source"
                  src={url}
                  preload="auto"
                  playsInline
                  muted
                />
              ))}
              {(project.overlayTracks ?? []).map((track) => {
                const overlaySegment = findSegmentAt(track.clips, playhead)
                const overlayAsset = overlaySegment ? assetForClip(overlaySegment.clip) : null
                if (!overlayAsset) return null
                return (
                  <video
                    key={`${track.id}:${overlayAsset.url}`}
                    ref={(element) => {
                      if (element) overlayVideoRefs.current.set(track.id, element)
                      else overlayVideoRefs.current.delete(track.id)
                    }}
                    className="preview-video-source"
                    src={overlayAsset.url}
                    preload="auto"
                    muted={!isOverlayAudioActive(project, track)}
                    playsInline
                    aria-hidden="true"
                  />
                )
              })}
              {(project.audioTracks ?? []).map((track) =>
                track.clips.map((clip) => {
                  const audioAsset = assetByUrl.get(clip.sourceUrl)
                  if (!audioAsset) return null
                  return (
                    <audio
                      key={clip.id}
                      ref={(element) => {
                        if (element) audioRefs.current.set(clip.id, element)
                        else audioRefs.current.delete(clip.id)
                      }}
                      className="preview-audio-source"
                      src={audioAsset.url}
                      preload="auto"
                      aria-hidden="true"
                    />
                  )
                }),
              )}
            </>
          )}
          {assets.length > 0 && !cropSession && (
            <div className="preview-badges">
              <span className="badge badge-live">
                <span className="live-dot" />
                实时预览
              </span>
              <span className="badge">
                {baseAsset ? `${baseAsset.width} × ${baseAsset.height}` : '叠加合成'}
              </span>
              {activeSegment && (
                <span className="badge badge-soft">
                  {activeSegment.clip.type === 'freeze' ? '定格' : '片段'}{' '}
                  {activeSegment.index + 1}/{project.clips.length}
                </span>
              )}
              {activeSegment?.clip.type === 'freeze' && activeSegment.end - playhead > 0.05 && (
                <span className="badge badge-freeze">
                  <Icon name="freeze" size={12} />
                  定格保持 {Math.max(0, activeSegment.end - playhead).toFixed(1)}s
                </span>
              )}
            </div>
          )}
          {assets.length > 0 && !cropSession && (
            <div className="preview-frame-note">
              {isPlaying ? '播放中' : canDrag ? '拖动画面调整位置' : '暂停'}
            </div>
          )}
          {baseAsset && cropSession && (
            <CropOverlay
              frameWidth={frame.width}
              frameHeight={frame.height}
              source={baseAsset}
            />
          )}
          {empty && (
            <div className={`preview-empty${loading ? ' is-loading' : ''}`}>
              {loading ? (
                <>
                  <span className="loading-orbit" />
                  <p className="empty-kicker">正在读取素材</p>
                  <h3>准备你的画布…</h3>
                  <p className="empty-copy">
                    {loadingLabel ?? '读取视频时长与分辨率，不会上传到服务器。'}
                  </p>
                </>
              ) : (
                <>
                  <span className="empty-icon">
                    <Icon name={hasSourceButNoClips ? 'film' : 'upload'} size={26} />
                  </span>
                  <p className="empty-kicker">
                    {hasSourceButNoClips ? '时间轴已清空' : '新建项目'}
                  </p>
                  <h3>
                    {hasSourceButNoClips
                      ? '所有片段已删除'
                      : error
                        ? '这个视频暂时打不开'
                        : '放入一段视频，开始剪'}
                  </h3>
                  <p className="empty-copy">
                    {hasSourceButNoClips
                      ? '按 Ctrl/⌘ + Z 撤销删除，或重新选择视频开始新的时间轴。'
                      : error ??
                        '支持浏览器可播放的 MP4 / WebM · 所有处理都在本地完成 · 建议单个文件不超过 500MB'}
                  </p>
                  <button type="button" className="button primary large" onClick={onPickFile}>
                    <Icon name="film" size={17} />
                    {hasSourceButNoClips || error ? '重新选择视频' : '选择视频'}
                  </button>
                  <p className="empty-foot">按 Ctrl/⌘ + B 分割 · Q 左裁 · W 右裁 · M 标记</p>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="preview-transport">
        <div className="transport-main">
          <button
            type="button"
            className="transport-play"
            disabled={totalDuration <= 0 || Boolean(cropSession)}
            onClick={() => store.getState().togglePlay()}
            aria-label={isPlaying ? '暂停' : '播放'}
            title={isPlaying ? '暂停（空格）' : '播放（空格）'}
          >
            <Icon name={isPlaying ? 'pause' : 'play'} size={19} />
          </button>
          <button
            type="button"
            className="transport-button"
            disabled={totalDuration <= 0 || Boolean(cropSession)}
            onClick={replay}
            aria-label="重播"
            title="回到 0 秒并播放"
          >
            <Icon name="replay" size={17} />
          </button>
          <button
            type="button"
            className="transport-button"
            onClick={() => setPreviewFullscreen(!previewFullscreen)}
            aria-label={previewFullscreen ? '退出全屏预览' : '全屏预览'}
            title={previewFullscreen ? '退出全屏（Esc）' : '全屏预览（F）'}
          >
            <Icon name={previewFullscreen ? 'collapse' : 'expand'} size={17} />
          </button>
          <div className="transport-time">
            <span className="timecode">{formatPlayhead(playhead, timecodeFps)}</span>
            <span className="timecode-sep">/</span>
            <span className="timecode muted">{formatPlayhead(totalDuration, timecodeFps)}</span>
          </div>
        </div>
        <div className="transport-meta">
          <span className="transport-hint">
            <Icon name="mouse" size={14} />
            拖动画面可调整位置
          </span>
          <span className="transport-divider" />
          <span className="transport-fps">{timecodeFps} fps</span>
        </div>
      </div>
    </section>
  )
}