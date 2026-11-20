import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { hasTransitionPair, normalizeTransitionType, transitionLabel } from '../core/transition'
import { keyframeAt, type KeyframeRef } from '../core/keyframeEdit'
import { findAnimationTarget } from '../core/animationTargets'
import { ClipKeyframeBand } from './ClipKeyframeBand'
import { EasingPopover } from './EasingPopover'
import type { Easing } from '../core/types'
import { clipSpeedValue } from '../core/speed'
import { idsInRect, type SelectableSpan } from '../core/selection'
import type {
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import {
  CLIP_EDGE_EPSILON,
  FREEZE_MAX_DURATION,
  FREEZE_MIN_DURATION,
  MAX_OVERLAY_TRACKS,
  MIN_CLIP_DURATION,
  TIMELINE_MAX_ZOOM,
  TIMELINE_MIN_ZOOM,
} from '../core/constants'
import { formatClock, formatRulerTime, getRulerStep } from '../core/format'
import { findAudioClipLocation, getAudioActionAvailability } from '../core/audio'
import { findTextClipLocation, getTextActionAvailability } from '../core/text'
import {
  clamp,
  findClipLocation,
  getActionAvailability,
  getProjectEnd,
  getTimeline,
} from '../core/timeline'
import { isAudioLocked, isMainLocked, isOverlayLocked, isTextLocked } from '../core/tracks'
import type { Clip, Marker, OverlayTrack, SourceInfo } from '../core/types'
import { useEditorStore, useEditorStoreApi } from '../store/EditorProvider'
import { Icon } from './Icon'
import { AudioTracks } from './AudioTracks'
import { ClipFilmstrip } from './ClipFilmstrip'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { TrackGutter } from './TrackGutter'
import { TextTracks } from './TextTracks'
import { MarkerPopover } from './MarkerPopover'

const BASE_PAD = 12
/** 封面块宽度与它和 t=0 之间的间隙（只在有封面时占用）。 */
const COVER_BLOCK_WIDTH = 56
const COVER_GAP = 8
const ASSET_DRAG_TYPE = 'application/x-framecut-asset'
const POPOVER_OPEN_DELAY = 180
const POPOVER_CLOSE_DELAY = 320

interface TimelineProps {
  onPickFile: () => void
}

/** 右键菜单的目标类型：主轨/叠加轨视频、音频片段时间轴上的音频片段、文本片段。 */
type ClipMenuKind = 'video' | 'audio' | 'text'

interface ClipMenuState {
  kind: ClipMenuKind
  clipId: string
  x: number
  y: number
}

interface MarkerPopoverState {
  id: string
  anchor: DOMRect
  pinned: boolean
}

interface EdgeDrag {
  clipId: string
  edge: 'left' | 'right'
  pointerId: number
  startX: number
  delta: number
  minDelta: number
  maxDelta: number
  snapTime: number | null
}

interface ClipDrag {
  clipId: string
  trackId: string | null
  targetTrackId: string | null
  targetTime: number
  grabOffset: number
  duration: number
  isFreeze: boolean
  snapKind: 'auto' | 'magnet' | null
  snapLabel: string | null
  pointerId: number
  startX: number
  startY: number
  targetIndex: number
  active: boolean
  clientX: number
  clientY: number
}

export function Timeline({ onPickFile }: TimelineProps) {
  const store = useEditorStoreApi()
  const project = useEditorStore((state) => state.project)
  const source = useEditorStore((state) => state.source)
  const assets = useEditorStore((state) => state.assets)
  const playhead = useEditorStore((state) => state.playhead)
  const isPlaying = useEditorStore((state) => state.isPlaying)
  const pps = useEditorStore((state) => state.timelineZoom)
  const selectedIds = useEditorStore((state) => state.selectedIds)
  const selectIds = useEditorStore((state) => state.selectIds)
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const selectClip = useEditorStore((state) => state.selectClip)
  const toggleSelectClip = useEditorStore((state) => state.toggleSelectClip)
  const rangeSelectClip = useEditorStore((state) => state.rangeSelectClip)
  const setPlayhead = useEditorStore((state) => state.setPlayhead)
  const moveKeyframes = useEditorStore((state) => state.moveKeyframes)
  const setKeyframeEasing = useEditorStore((state) => state.setKeyframeEasing)
  const deleteKeyframes = useEditorStore((state) => state.deleteKeyframes)
  // ---- 关键帧交互 ----
  const selectKeyframes = (clipId: string, refs: KeyframeRef[], additive: boolean) => {
    setKeySelection((current) => {
      if (!additive || !current || current.clipId !== clipId) return { clipId, refs }
      const merged = [...current.refs]
      for (const ref of refs) {
        const hit = merged.findIndex(
          (item) => item.prop === ref.prop && Math.abs(item.t - ref.t) < 5e-4,
        )
        if (hit >= 0) merged.splice(hit, 1)
        else merged.push(ref)
      }
      return merged.length > 0 ? { clipId, refs: merged } : null
    })
  }

  const commitKeyframeMove = (clipId: string, refs: KeyframeRef[], deltaT: number) => {
    moveKeyframes(clipId, refs, deltaT)
    setKeySelection({ clipId, refs: refs.map((ref) => ({ ...ref, t: Math.min(1, Math.max(0, ref.t + deltaT)) })) })
  }

  /** 关键帧拖动/提示用的吸附候选：播放头 + 片段两端（与片段拖动同一阈值 12px）。 */
  const keyframeSnapCandidates = (clipId: string) => {
    const target = findAnimationTarget(project, clipId)
    if (!target) return [] as { time: number; label: string }[]
    return [
      { time: playhead, label: '播放头' },
      { time: target.start, label: '片段起点' },
      { time: target.start + target.duration, label: '片段终点' },
    ]
  }

  /** 选中关键帧共有的缓动；不一致时返回 null（浮层不高亮任何项）。 */
  const commonEasing = (target: { clipId: string; refs: KeyframeRef[] }): Easing | null => {
    const location = findAnimationTarget(project, target.clipId)
    if (!location) return null
    const eases = target.refs
      .map((ref) => keyframeAt(location.clip.anim, ref.prop, ref.t)?.ease ?? null)
      .filter((ease): ease is Easing => ease !== null)
    if (eases.length === 0) return null
    return eases.every((ease) => ease === eases[0]) ? eases[0] : null
  }

  const openCoverPanel = useEditorStore((state) => state.openCoverPanel)
  const setCoverPreview = useEditorStore((state) => state.setCoverPreview)
  const setPlaying = useEditorStore((state) => state.setPlaying)
  const setTimelineZoom = useEditorStore((state) => state.setTimelineZoom)
  const setTimelineViewportWidth = useEditorStore((state) => state.setTimelineViewportWidth)
  const zoomToFit = useEditorStore((state) => state.zoomToFit)
  const resizeClipEdge = useEditorStore((state) => state.resizeClipEdge)
  const addOverlayTrack = useEditorStore((state) => state.addOverlayTrack)
  const addAudioTrack = useEditorStore((state) => state.addAudioTrack)
  const addTextAtPlayhead = useEditorStore((state) => state.addTextAtPlayhead)
  const removeOverlayTrack = useEditorStore((state) => state.removeOverlayTrack)
  const toggleOverlayTrackVisibility = useEditorStore(
    (state) => state.toggleOverlayTrackVisibility,
  )
  const moveClipToTrackAtTime = useEditorStore((state) => state.moveClipToTrackAtTime)
  const addAssetToTimeline = useEditorStore((state) => state.addAssetToTimeline)
  const timelineSettings = useEditorStore((state) => state.timelineSettings)
  const toggleTimelineSetting = useEditorStore((state) => state.toggleTimelineSetting)
  // 右键菜单全部复用既有 action（各自是 1 个命令 / 1 条撤销）。
  const selectedClipId = useEditorStore((state) => state.selectedClipId)
  const splitAtPlayhead = useEditorStore((state) => state.splitAtPlayhead)
  const trimLeftAtPlayhead = useEditorStore((state) => state.trimLeftAtPlayhead)
  const trimRightAtPlayhead = useEditorStore((state) => state.trimRightAtPlayhead)
  const copySelection = useEditorStore((state) => state.copySelection)
  const cutSelection = useEditorStore((state) => state.cutSelection)
  const detachAudio = useEditorStore((state) => state.detachAudio)
  const insertFreeze = useEditorStore((state) => state.insertFreeze)
  const deleteSelectedClip = useEditorStore((state) => state.deleteSelectedClip)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const gutterRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const hoverTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  const edgeDragRef = useRef<EdgeDrag | null>(null)
  const clipDragRef = useRef<ClipDrag | null>(null)
  const [viewportWidth, setViewportWidth] = useState(960)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [scrub, setScrub] = useState<{ pointerId: number } | null>(null)
  const [edgeDrag, setEdgeDrag] = useState<EdgeDrag | null>(null)
  const [clipDrag, setClipDrag] = useState<ClipDrag | null>(null)
  const [popover, setPopover] = useState<MarkerPopoverState | null>(null)
  const [clipMenu, setClipMenu] = useState<ClipMenuState | null>(null)
  /** 关键帧选中态：属于哪个片段 + 选中的 {prop,t} 列表（不进草稿、不进撤销栈）。 */
  const [keySelection, setKeySelection] = useState<{ clipId: string; refs: KeyframeRef[] } | null>(null)
  const [keyMenu, setKeyMenu] = useState<{ x: number; y: number; clipId: string; refs: KeyframeRef[] } | null>(null)
  const [easingPopover, setEasingPopover] = useState<{
    x: number
    y: number
    clipId: string
    refs: KeyframeRef[]
  } | null>(null)
  const [hoverTime, setHoverTime] = useState<number | null>(null)
  const [playheadDrag, setPlayheadDrag] = useState<{ pointerId: number } | null>(null)
  /** 空白处拖拽框选：先在空白 pointerdown 记录起点，移动超过阈值才真正进入框选。 */
  const [boxSelect, setBoxSelect] = useState<{
    pointerId: number
    startX: number
    startY: number
    x: number
    y: number
    active: boolean
    additive: boolean
  } | null>(null)

  // 变速拖动中的实时预览：只改内存里的倍率，不进撤销栈（previewPatch 不会被 run 记录）。
  const previewPatch = useEditorStore((state) => state.previewPatch)
  // 拖动滑块时的通用实时预览：把 previewPatch 合并到目标片段后重算时间轴，
// 这样倍率（宽度变化）与定格时长（sourceEnd 变化）都能跟着手指实时变化。
  const previewProject = useMemo(() => {
    const patch = previewPatch
    if (!patch?.clipId) return project
    const id = patch.clipId
    const apply = (clip: Clip): Clip => (clip.id === id ? { ...clip, ...patch.patch } : clip)
    return {
      ...project,
      clips: project.clips.map(apply),
      overlayTracks: (project.overlayTracks ?? []).map((track) => ({
        ...track,
        clips: track.clips.map(apply),
      })),
    }
  }, [project, previewPatch])

  const total = useMemo(() => getProjectEnd(previewProject), [previewProject])
  const segments = useMemo(() => getTimeline(previewProject.clips), [previewProject.clips])
  const overlayTracks = project.overlayTracks ?? []
  /** 素材库现有素材的 url 集合：用于判断片段的素材是否已被移除。 */
  const assetUrls = useMemo(() => new Set(assets.map((asset) => asset.url)), [assets])
  // 有封面时把时间轴左侧的留白加宽，避免封面块压住 t=0 的片段与标尺刻度。
  const hasCoverBlock = Boolean(project.cover?.dataUrl)
  const pad = BASE_PAD + (hasCoverBlock ? COVER_BLOCK_WIDTH + COVER_GAP : 0)
  const assetByUrl = useMemo(
    () => new Map(assets.map((asset) => [asset.url, asset])),
    [assets],
  )
  const assetForClip = useCallback(
    (clip: Clip | null | undefined): SourceInfo | null => {
      if (!clip) return null
      return assetByUrl.get(clip.sourceUrl) ?? (clip.sourceUrl === source?.url ? source : null)
    },
    [assetByUrl, source],
  )
  const thumbnailFor = useCallback(
    (clip: Clip | null | undefined): string | undefined =>
      assetForClip(clip)?.thumbnail,
    [assetForClip],
  )
  const contentWidth = Math.max(viewportWidth, total * pps + pad * 2 + 36)
  const visibleDuration = Math.max(0.1, (contentWidth - pad * 2) / pps)

  let majorStep = getRulerStep(pps)
  while (visibleDuration / majorStep > 220) majorStep *= 2
  const tickStepPx = Math.max(8, majorStep * pps)

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const measure = () => {
      const width = Math.max(320, element.clientWidth)
      setViewportWidth(width)
      setTimelineViewportWidth(width)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [setTimelineViewportWidth])

  useEffect(() => {
    return () => {
      if (hoverTimer.current) window.clearTimeout(hoverTimer.current)
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
    }
  }, [])

  useEffect(() => {
    if (!isPlaying) return
    const element = scrollRef.current
    if (!element) return
    const x = pad + playhead * pps
    if (x > element.scrollLeft + element.clientWidth - 70) {
      element.scrollLeft = Math.max(0, x - element.clientWidth * 0.34)
    } else if (x < element.scrollLeft + 34) {
      element.scrollLeft = Math.max(0, x - element.clientWidth * 0.2)
    }
  }, [playhead, isPlaying, pps])

  useEffect(() => {
    if (isPlaying) setPopover(null)
  }, [isPlaying])

  useEffect(() => {
    if (!popover) return
    if (!project.markers.some((marker) => marker.id === popover.id)) setPopover(null)
  }, [project.markers, popover])

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const content = contentRef.current
      if (!content) return
      const rect = content.getBoundingClientRect()
      const x = clientX - rect.left - pad
      const time = clamp(x / pps, 0, total)
      const snapDistance = 7 / pps
      setPlayhead(time, snapDistance)
    },
    [pps, setPlayhead, total],
  )

  /**
   * 拖动播放头手柄时的定位：坐标换算与 seekFromClientX 一致，
   * 但吸附点包含「所有轨道的片段边界 + 标记 + 0」，阈值 12px 与片段拖动相同。
   * （红线本体 pointer-events:none，只有 14×14 的手柄可抓。）
   */
  const movePlayheadTo = useCallback(
    (clientX: number) => {
      const content = contentRef.current
      if (!content) return
      const rect = content.getBoundingClientRect()
      const raw = clamp((clientX - rect.left - pad) / pps, 0, total)
      let target = raw
      if (timelineSettings.autoSnap) {
        const threshold = 12 / pps
        let bestDelta = Number.POSITIVE_INFINITY
        const consider = (value: number) => {
          const delta = Math.abs(value - raw)
          if (delta < bestDelta) {
            bestDelta = delta
            target = value
          }
        }
        consider(0)
        for (const segment of segments) {
          consider(segment.start)
          consider(segment.end)
        }
        for (const track of overlayTracks) {
          for (const segment of getTimeline(track.clips)) {
            consider(segment.start)
            consider(segment.end)
          }
        }
        for (const marker of project.markers) consider(marker.time)
        if (bestDelta > threshold) target = raw
      }
      setPlayhead(clamp(target, 0, total))
    },
    [pps, total, setPlayhead, timelineSettings.autoSnap, segments, overlayTracks, project.markers],
  )

  const handlePlayheadPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLSpanElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.setPointerCapture(event.pointerId)
      setPlaying(false)
      setPlayheadDrag({ pointerId: event.pointerId })
      movePlayheadTo(event.clientX)
    },
    [setPlaying, movePlayheadTo],
  )

  useEffect(() => {
    if (!playheadDrag) return
    const handleMove = (event: PointerEvent) => {
      if (event.pointerId !== playheadDrag.pointerId) return
      movePlayheadTo(event.clientX)
    }
    const handleUp = (event: PointerEvent) => {
      if (event.pointerId !== playheadDrag.pointerId) return
      movePlayheadTo(event.clientX)
      setPlayheadDrag(null)
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
    }
  }, [playheadDrag, movePlayheadTo])

  useEffect(() => {
    if (!scrub) return
    const handleMove = (event: PointerEvent) => {
      if (event.pointerId !== scrub.pointerId) return
      seekFromClientX(event.clientX)
    }
    const handleUp = () => setScrub(null)
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
    }
  }, [scrub, seekFromClientX])

  useEffect(() => {
    if (!edgeDrag?.pointerId) return
    const start = edgeDragRef.current
    if (!start) return

    const handleMove = (event: PointerEvent) => {
      const current = edgeDragRef.current
      if (!current || event.pointerId !== current.pointerId) return
      const delta = clamp(
        (event.clientX - current.startX) / pps,
        current.minDelta,
        current.maxDelta,
      )
      const state = store.getState()
      let snappedDelta = delta
      let snapTime: number | null = null
      if (state.timelineSettings.autoSnap) {
        const location = findClipLocation(state.project, current.clipId)
        if (location) {
          const edgeTime =
            (current.edge === 'left' ? location.segment.start : location.segment.end) + delta
          const points: number[] = []
          for (const segment of getTimeline(state.project.clips)) {
            if (segment.clip.id === current.clipId) continue
            points.push(segment.start, segment.end)
          }
          for (const track of state.project.overlayTracks ?? []) {
            for (const segment of getTimeline(track.clips)) {
              if (segment.clip.id === current.clipId) continue
              points.push(segment.start, segment.end)
            }
          }
          for (const marker of state.project.markers) points.push(marker.time)
          if (
            state.playhead <= location.segment.start - 0.0001 ||
            state.playhead >= location.segment.end + 0.0001
          ) {
            points.push(state.playhead)
          }
          points.push(0)
          let bestPoint: number | null = null
          let bestDistance = 12 / pps
          for (const point of points) {
            const distance = Math.abs(point - edgeTime)
            if (distance <= bestDistance) {
              bestDistance = distance
              bestPoint = point
            }
          }
          if (bestPoint !== null) {
            snappedDelta = clamp(
              delta + (bestPoint - edgeTime),
              current.minDelta,
              current.maxDelta,
            )
            snapTime = bestPoint
          }
        }
      }
      const next = { ...current, delta: snappedDelta, snapTime }
      edgeDragRef.current = next
      setEdgeDrag(next)
    }
    const finish = () => {
      const current = edgeDragRef.current
      if (current && Math.abs(current.delta) >= 0.0005) {
        resizeClipEdge(current.clipId, current.edge, current.delta)
      }
      edgeDragRef.current = null
      setEdgeDrag(null)
    }
    const cancel = () => {
      edgeDragRef.current = null
      setEdgeDrag(null)
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancel)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancel)
    }
  }, [edgeDrag?.pointerId, pps, resizeClipEdge])

  useEffect(() => {
    if (!clipDrag?.pointerId) return
    const handleMove = (event: PointerEvent) => {
      const current = clipDragRef.current
      if (!current || event.pointerId !== current.pointerId) return
      const content = contentRef.current
      if (!content) return
      const distance = Math.hypot(event.clientX - current.startX, event.clientY - current.startY)
      if (!current.active && distance < 5) return
      const rect = content.getBoundingClientRect()
      const rawTime = clamp(
        (event.clientX - rect.left - pad) / pps - current.grabOffset,
        0,
        total,
      )
      const baseLane = document.querySelector<HTMLElement>('.clip-lane')
      const baseBounds = baseLane?.getBoundingClientRect()
      let targetTrackId = current.trackId
      if (
        baseBounds &&
        event.clientY >= baseBounds.top &&
        event.clientY <= baseBounds.bottom
      ) {
        targetTrackId = null
      } else {
        const tracks = [...document.querySelectorAll<HTMLElement>('[data-overlay-track-id]')]
        const hit = tracks.find((element) => {
          const bounds = element.getBoundingClientRect()
          return event.clientY >= bounds.top && event.clientY <= bounds.bottom
        })
        if (hit?.dataset.overlayTrackId) targetTrackId = hit.dataset.overlayTrackId
      }
      const targetSegments =
        targetTrackId === null
          ? segments
          : getTimeline(
              (store.getState().project.overlayTracks ?? []).find(
                (item) => item.id === targetTrackId,
              )?.clips ?? [],
            )
      const settings = store.getState().timelineSettings
      const projectNow = store.getState().project
      const sourceNow = findClipLocation(projectNow, current.clipId)
      const sourceStart = sourceNow?.segment.start ?? -1
      const sourceEnd = sourceNow?.segment.end ?? -1
      const outsideSource = (time: number) => time <= sourceStart - 0.0001 || time >= sourceEnd + 0.0001
      const autoPoints: { time: number; label: string }[] = []
      if (settings.autoSnap) {
        for (const segment of getTimeline(projectNow.clips)) {
          if (segment.clip.id === current.clipId) continue
          autoPoints.push({ time: segment.start, label: '片段边缘' }, { time: segment.end, label: '片段边缘' })
        }
        for (const track of projectNow.overlayTracks ?? []) {
          for (const segment of getTimeline(track.clips)) {
            if (segment.clip.id === current.clipId) continue
            autoPoints.push({ time: segment.start, label: '片段边缘' }, { time: segment.end, label: '片段边缘' })
          }
        }
        for (const marker of projectNow.markers) {
          if (outsideSource(marker.time)) autoPoints.push({ time: marker.time, label: '标记' })
        }
        if (outsideSource(0)) autoPoints.push({ time: 0, label: '时间轴起点' })
        const head = store.getState().playhead
        if (outsideSource(head)) autoPoints.push({ time: head, label: '播放头' })
      }
      const evaluateSnap = (points: { time: number; label: string }[], threshold: number) => {
        let best: { delta: number; label: string } | null = null
        let bestDistance = threshold + 1
        for (const point of points) {
          for (const edge of [rawTime, rawTime + current.duration]) {
            const delta = point.time - edge
            if (Math.abs(delta) < bestDistance) {
              bestDistance = Math.abs(delta)
              best = { delta, label: point.label }
            }
          }
        }
        return bestDistance <= threshold ? best : null
      }
      const others = targetSegments.filter((segment) => segment.clip.id !== current.clipId)
      let targetIndex = 0
      let targetTime = 0
      let snapKind: 'auto' | 'magnet' | null = null
      let snapLabel: string | null = null
      if (settings.mainTrackMagnet && targetTrackId === null) {
        targetIndex = clamp(
          others.filter((segment) => (segment.start + segment.end) / 2 < rawTime - 0.0001).length,
          0,
          others.length,
        )
        targetTime = others
          .slice(0, targetIndex)
          .reduce((sum, segment) => sum + segment.duration, 0)
        snapKind = 'magnet'
        snapLabel = '主轨贴合'
      } else {
        const snap = settings.autoSnap ? evaluateSnap(autoPoints, 12 / pps) : null
        const snappedTime = Math.max(0, rawTime + (snap?.delta ?? 0))
        targetIndex = clamp(
          others.filter(
            (segment) => (segment.start + segment.end) / 2 < snappedTime - 0.0001,
          ).length,
          0,
          others.length,
        )
        const previousEnd = targetIndex > 0 ? others[targetIndex - 1]?.end ?? 0 : 0
        targetTime = Math.max(snappedTime, previousEnd)
        snapKind = snap ? 'auto' : null
        snapLabel = snap?.label ?? null
      }
      const next = {
        ...current,
        active: true,
        targetTrackId,
        targetTime,
        targetIndex,
        snapKind,
        snapLabel,
        clientX: event.clientX,
        clientY: event.clientY,
      }
      clipDragRef.current = next
      setClipDrag(next)
    }
    const finish = () => {
      const current = clipDragRef.current
      if (current?.active) {
        moveClipToTrackAtTime(current.clipId, current.targetTrackId, current.targetTime)
      }
      clipDragRef.current = null
      setClipDrag(null)
    }
    const cancel = () => {
      clipDragRef.current = null
      setClipDrag(null)
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancel)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancel)
    }
  }, [clipDrag?.pointerId, pps, segments, total, moveClipToTrackAtTime, store])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const state = store.getState()
      const oldZoom = state.timelineZoom
      const nextZoom = clamp(
        oldZoom * (event.deltaY > 0 ? 0.86 : 1.16),
        TIMELINE_MIN_ZOOM,
        TIMELINE_MAX_ZOOM,
      )
      if (Math.abs(nextZoom - oldZoom) < 0.1) return
      const rect = element.getBoundingClientRect()
      const cursorX = event.clientX - rect.left
      const anchorTime = (element.scrollLeft + cursorX - pad) / oldZoom
      state.setTimelineZoom(nextZoom)
      setPopover(null)
      requestAnimationFrame(() => {
        element.scrollLeft = Math.max(0, pad + anchorTime * nextZoom - cursorX)
      })
    }
    element.addEventListener('wheel', handleWheel, { passive: false })
    return () => element.removeEventListener('wheel', handleWheel)
  }, [store])

  const changeZoom = (next: number) => {
    const element = scrollRef.current
    const anchorTime = playhead
    setTimelineZoom(next)
    if (!element) return
    requestAnimationFrame(() => {
      element.scrollLeft = Math.max(
        0,
        pad + anchorTime * next - element.clientWidth * 0.5,
      )
    })
  }

  const closePopover = () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current)
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    setPopover(null)
  }

  const openPopover = (marker: Marker, anchor: DOMRect, pinned: boolean) => {
    setPopover({ id: marker.id, anchor, pinned })
  }

  const markerEnter = (event: ReactPointerEvent<HTMLButtonElement>, marker: Marker) => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    if (popover?.pinned) return
    const anchor = event.currentTarget.getBoundingClientRect()
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current)
    hoverTimer.current = window.setTimeout(() => {
      setPopover((previous) =>
        previous?.pinned ? previous : { id: marker.id, anchor, pinned: false },
      )
    }, POPOVER_OPEN_DELAY)
  }

  const markerLeave = () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current)
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => {
      setPopover((previous) => (previous && !previous.pinned ? null : previous))
    }, POPOVER_CLOSE_DELAY)
  }

  const markerClick = (
    event: ReactPointerEvent<HTMLButtonElement> | ReactMouseEvent<HTMLButtonElement>,
    marker: Marker,
  ) => {
    event.stopPropagation()
    event.preventDefault()
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current)
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    setPlaying(false)
    setPlayhead(marker.time)
    openPopover(marker, event.currentTarget.getBoundingClientRect(), true)
  }

  const startEdgeDrag = (
    event: ReactPointerEvent<HTMLElement>,
    segment: (typeof segments)[number],
    edge: 'left' | 'right',
    track?: OverlayTrack,
  ) => {
    event.preventDefault()
    event.stopPropagation()
    const { clip } = segment
    const location = findClipLocation(project, clip.id)
    if (
      location &&
      (location.track ? isOverlayLocked(location.track) : isMainLocked(project))
    ) {
      return
    }
    selectClip(clip.id)
    setPlaying(false)
    setPlayhead(edge === 'left' ? segment.start : segment.end)
    setScrub(null)
    setPopover(null)
    const duration = segment.duration
    const freeze = clip.type === 'freeze'
    const minDuration = freeze ? FREEZE_MIN_DURATION : MIN_CLIP_DURATION
    const maxDuration = freeze ? FREEZE_MAX_DURATION : Number.POSITIVE_INFINITY
    let minDelta = 0
    let maxDelta = 0

    if (edge === 'left') {
      const gap = Math.max(0, clip.gapBefore ?? 0)
      const maxRestore = Math.min(
        gap,
        Math.max(0, clip.sourceStart),
        Math.max(0, maxDuration - duration),
      )
      minDelta = -maxRestore
      maxDelta = Math.max(0, duration - minDuration)
    } else {
      const sourceDuration =
      assetForClip(clip)?.duration ?? source?.duration ?? clip.sourceEnd
    const next = track
      ? track.clips[segment.index + 1]
      : project.clips[segment.index + 1]
      const nextGap = Math.max(0, next?.gapBefore ?? 0)
      const sourceGrow = freeze
        ? Math.max(0, FREEZE_MAX_DURATION - duration)
        : Math.max(0, sourceDuration - clip.sourceEnd)
      maxDelta = next ? Math.min(sourceGrow, nextGap) : sourceGrow
      minDelta = -Math.max(0, duration - minDuration)
    }

    const drag: EdgeDrag = {
      clipId: clip.id,
      edge,
      pointerId: event.pointerId,
      startX: event.clientX,
      delta: 0,
      minDelta,
      maxDelta,
      snapTime: null,
    }
    edgeDragRef.current = drag
    setEdgeDrag(drag)
  }

  const handleContentPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target as Element
    if (target.closest('.clip-trim-handle, .playhead-handle, .marker-flag, button, input, textarea')) return
    const clipElement = target.closest<HTMLElement>('[data-clip-id]')
    if (clipElement?.dataset.clipId) {
      const clipId = clipElement.dataset.clipId
      const location = findClipLocation(project, clipId)
      if (
        location &&
        (location.track ? isOverlayLocked(location.track) : isMainLocked(project))
      ) {
        return
      }
      const trackId =
        clipElement.dataset.trackId && clipElement.dataset.trackId !== 'base'
          ? clipElement.dataset.trackId
          : null
      // 三种点击的分工（时间轴内容区）：
      //   1) 单击片段      → 只选中，播放头不动（方便“先选后操作”，如裁剪/属性调整）
      //   2) 双击片段      → 跳到该处（seekFromClientX），保留“快速定位到片段内某点”的老习惯
      //   3) 点尺子 / 空白 → 跳播放头并进入拖动 scrub
      // Ctrl/⌘ 点击 = 切换选中，Shift 点击 = 区间选中（都只改选择，不跳播放头）。
      if (event.metaKey || event.ctrlKey) {
        toggleSelectClip(clipId)
      } else if (event.shiftKey) {
        rangeSelectClip(clipId)
      } else {
        selectClip(clipId)
      }
      setPlaying(false)
      setScrub(null)
      setPopover(null)
      const contentRect = contentRef.current?.getBoundingClientRect()
      const pointerTime = contentRect
        ? clamp((event.clientX - contentRect.left - pad) / pps, 0, total)
        : 0
      const sourceLocation = findClipLocation(project, clipId)
      const grabOffset = sourceLocation
        ? clamp(pointerTime - sourceLocation.segment.start, 0, sourceLocation.segment.duration)
        : 0
      const drag: ClipDrag = {
        clipId,
        trackId,
        targetTrackId: trackId,
        targetTime: sourceLocation?.segment.start ?? 0,
        grabOffset,
        duration: sourceLocation?.segment.duration ?? 1,
        isFreeze: sourceLocation?.clip.type === 'freeze',
        snapKind: null,
        snapLabel: null,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        targetIndex: 0,
        active: false,
        clientX: event.clientX,
        clientY: event.clientY,
      }
      clipDragRef.current = drag
      setClipDrag(drag)
      event.preventDefault()
      return
    }
    setPlaying(false)
    setPopover(null)
    setScrub({ pointerId: event.pointerId })
    seekFromClientX(event.clientX)
    // 同时记下框选起点：移动超过 4px 就转为框选（此时取消 scrub，避免播放头跟着乱跳）。
    const contentEl = contentRef.current
    const bounds = contentEl?.getBoundingClientRect()
    const localX = bounds ? event.clientX - bounds.left : event.clientX
    const localY = bounds ? event.clientY - bounds.top : event.clientY
    setBoxSelect({
      pointerId: event.pointerId,
      startX: localX,
      startY: localY,
      x: localX,
      y: localY,
      active: false,
      additive: event.shiftKey,
    })
    event.preventDefault()
  }

  /**
   * 空白处框选：按时间区间与所有轨道的片段求交集，调用 core 的 idsInRect + store 的 selectIds。
   * Shift 追加到现有选区；不按 Shift 则替换。
   */
  useEffect(() => {
    if (!boxSelect) return
    /** 相对内容区的 x（不含 pad）→ 时间轴秒数。startX/x 都是相对坐标。 */
    const localToTime = (localX: number): number => clamp((localX - pad) / pps, 0, total)
    const move = (event: PointerEvent) => {
      if (event.pointerId !== boxSelect.pointerId) return
      const bounds = contentRef.current?.getBoundingClientRect()
      const localX = bounds ? event.clientX - bounds.left : event.clientX
      const localY = bounds ? event.clientY - bounds.top : event.clientY
      const active =
        boxSelect.active ||
        Math.abs(localX - boxSelect.startX) > 4 ||
        Math.abs(localY - boxSelect.startY) > 4
      setBoxSelect((current) =>
        current && current.pointerId === event.pointerId
          ? { ...current, x: localX, y: localY, active }
          : current,
      )
      if (active) setScrub(null)
    }
    const up = (event: PointerEvent) => {
      if (event.pointerId !== boxSelect.pointerId) return
      const bounds = contentRef.current?.getBoundingClientRect()
      const localX = bounds ? event.clientX - bounds.left : event.clientX
      const moved =
        Math.abs(localX - boxSelect.startX) > 4 ||
        Math.abs((bounds ? event.clientY - bounds.top : event.clientY) - boxSelect.startY) > 4
      setBoxSelect(null)
      if (!moved) return // 只是单击空白：交给 scrub 定位播放头
      const start = localToTime(boxSelect.startX)
      const end = localToTime(localX)
      const spans: SelectableSpan[] = []
      for (const track of project.overlayTracks ?? []) {
        for (const segment of getTimeline(track.clips)) {
          spans.push({ id: segment.clip.id, trackId: track.id, start: segment.start, end: segment.end })
        }
      }
      for (const segment of getTimeline(project.clips)) {
        spans.push({ id: segment.clip.id, trackId: 'base', start: segment.start, end: segment.end })
      }
      const hit = idsInRect(spans, { start, end })
      if (boxSelect.additive) {
        const merged = new Set([...selectedIds, ...hit])
        selectIds([...merged])
      } else {
        selectIds(hit)
      }
      setScrub(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [boxSelect, pps, total, project.clips, project.overlayTracks, selectedIds, selectIds])

  /** 双击片段：跳到鼠标所指位置（单击已不再移动播放头）。 */
  const handleContentDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as Element
    if (target.closest('.clip-trim-handle, .playhead-handle, .marker-flag, button, input, textarea')) {
      return
    }
    if (!target.closest('[data-clip-id]')) return
    seekFromClientX(event.clientX)
  }

  /**
   * 键盘可达：片段是 role="option" 的可聚焦元素，Enter / Space 触发选中。
   * 必须 stopPropagation，否则会冒泡到编辑器根节点触发 Space 的播放/暂停。
   */
  const handleClipKeyDown = useCallback(
    (clipId: string) => (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
      event.preventDefault()
      event.stopPropagation()
      selectClip(clipId)
    },
    [selectClip],
  )

  const tickIndexStart = Math.max(
    0,
    Math.floor((scrollLeft - pad - tickStepPx) / tickStepPx),
  )
  const tickIndexEnd = Math.ceil(
    (scrollLeft + viewportWidth - pad + tickStepPx) / tickStepPx,
  )
  const ticks: { time: number; x: number }[] = []
  for (let index = tickIndexStart; index <= tickIndexEnd; index += 1) {
    const time = index * majorStep
    if (time > visibleDuration + majorStep * 0.5) break
    ticks.push({ time, x: pad + time * pps })
  }

  const markerPopoverMarker = popover
    ? project.markers.find((marker) => marker.id === popover.id) ?? null
    : null

  const openMarker = markerPopoverMarker
  const gapBands = segments
    .map((segment, index) => {
      const previousEnd = index === 0 ? 0 : segments[index - 1].end
      const gap = segment.start - previousEnd
      return gap > CLIP_EDGE_EPSILON ? { start: previousEnd, duration: gap } : null
    })
    .filter((gap): gap is { start: number; duration: number } => gap !== null)

  const dropX = pad + (clipDrag?.targetTime ?? 0) * pps
  const dropHintLeft = clipDrag ? Math.min(window.innerWidth - 148, clipDrag.clientX + 14) : 0
  const dropHintTop = clipDrag ? Math.max(10, clipDrag.clientY - 38) : 0
  const dropTrackName =
    clipDrag?.targetTrackId === null
      ? '主轨'
      : overlayTracks.find((track) => track.id === clipDrag?.targetTrackId)?.name ?? '轨道'
  const overlayDisplayTracks = [...overlayTracks].reverse()
  const dragSourceLocation = clipDrag?.active
    ? findClipLocation(project, clipDrag.clipId)
    : null
  const dragGhostThumbnail = thumbnailFor(dragSourceLocation?.clip)
  const dragGhostDuration = clipDrag?.active
    ? clipDrag.duration
    : dragSourceLocation?.segment.duration ?? 0
  const dragGhostWidth = Math.max(5, dragGhostDuration * pps - 2)
  const dragGhostIsFreeze = clipDrag?.active
    ? clipDrag.isFreeze
    : dragSourceLocation?.clip.type === 'freeze'

  const resetTimelineHeight = (event: ReactPointerEvent<HTMLDivElement>) => {
    const root = event.currentTarget.closest<HTMLElement>('.framecut-root')
    root?.style.removeProperty('--fc-timeline-height')
  }

  const startTimelineResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const shell = event.currentTarget.parentElement
    const root = event.currentTarget.closest<HTMLElement>('.framecut-root')
    if (!shell || !root) return
    const startY = event.clientY
    const startHeight = shell.getBoundingClientRect().height
    const maxHeight = Math.max(180, root.clientHeight - 260)
    const handleMove = (moveEvent: PointerEvent) => {
      const next = clamp(startHeight + (startY - moveEvent.clientY), 160, maxHeight)
      root.style.setProperty('--fc-timeline-height', `${Math.round(next)}px`)
    }
    const finish = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  const handleAssetDragOver = (event: ReactDragEvent<HTMLElement>) => {
    const types = Array.from(event.dataTransfer.types)
    if (!types.includes(ASSET_DRAG_TYPE)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleAssetDrop = (event: ReactDragEvent<HTMLElement>) => {
    const assetId = event.dataTransfer.getData(ASSET_DRAG_TYPE)
    if (!assetId) return
    event.preventDefault()
    event.stopPropagation()
    const content = contentRef.current
    if (!content) return
    const rect = content.getBoundingClientRect()
    const time = clamp((event.clientX - rect.left - pad) / pps, 0, getProjectEnd(project))
    let targetTrackId: string | null = null
    const baseLane = document.querySelector<HTMLElement>('.clip-lane')
    const baseBounds = baseLane?.getBoundingClientRect()
    if (!baseBounds || event.clientY < baseBounds.top || event.clientY > baseBounds.bottom) {
      const hit = [...document.querySelectorAll<HTMLElement>('[data-overlay-track-id]')].find(
        (element) => {
          const bounds = element.getBoundingClientRect()
          return event.clientY >= bounds.top && event.clientY <= bounds.bottom
        },
      )
      targetTrackId = hit?.dataset.overlayTrackId ?? null
    }
    addAssetToTimeline(assetId, targetTrackId, time)
  }

  // ---------------------------------------------------------------- 片段右键菜单
  const closeClipMenu = useCallback(() => setClipMenu(null), [])

  const openClipMenu = (
    event: ReactMouseEvent<HTMLElement>,
    kind: ClipMenuKind,
    clipId: string,
  ) => {
    event.preventDefault()
    event.stopPropagation()
    setPopover(null)
    // 先让菜单的目标成为唯一选中项，菜单项才作用在「右键的那个片段」上。
    if (selectedClipId !== clipId || selectedIds.length !== 1) selectClip(clipId)
    setClipMenu({ kind, clipId, x: event.clientX, y: event.clientY })
  }

  /** 文本片段没有独立编辑器：选中后把焦点交给右栏的文本输入框。 */
  const focusTextEditor = () => {
    let attempts = 0
    const attempt = () => {
      const panel = document.querySelector('.properties-panel')
      const target =
        panel?.querySelector<HTMLTextAreaElement>('.text-editor-input') ??
        panel?.querySelector<HTMLTextAreaElement>('.caption-row.is-selected .caption-row-text') ??
        panel?.querySelector<HTMLTextAreaElement>('textarea')
      if (target) {
        target.focus()
        const end = target.value.length
        target.setSelectionRange?.(end, end)
        return
      }
      attempts += 1
      if (attempts < 20) requestAnimationFrame(attempt)
    }
    requestAnimationFrame(attempt)
  }

  /** 菜单项只做「组装」：判定用 core 里现成的 availability，动作全部走 store 既有 action。 */
  const buildClipMenuItems = (menu: ClipMenuState): ContextMenuItem[] => {
    const lockedReason = '轨道已锁定'
    const playheadReason = (locked: boolean) => (locked ? lockedReason : '播放头不在片段内')

    if (menu.kind === 'audio') {
      const location = findAudioClipLocation(project, menu.clipId)
      const locked = location ? isAudioLocked(location.track) : false
      const availability = getAudioActionAvailability(project, menu.clipId, playhead)
      const reason = playheadReason(locked)
      return [
        {
          label: '分割',
          shortcut: 'Ctrl+B',
          disabled: locked || !availability.canSplit,
          reason,
          onSelect: splitAtPlayhead,
        },
        {
          label: '左裁',
          shortcut: 'Q',
          disabled: locked || !availability.canTrimLeft,
          reason,
          onSelect: trimLeftAtPlayhead,
        },
        {
          label: '右裁',
          shortcut: 'W',
          disabled: locked || !availability.canTrimRight,
          reason,
          onSelect: trimRightAtPlayhead,
        },
        {
          label: '删除',
          shortcut: 'Delete',
          danger: true,
          separator: true,
          disabled: locked,
          reason: lockedReason,
          onSelect: deleteSelectedClip,
        },
      ]
    }

    if (menu.kind === 'text') {
      const location = findTextClipLocation(project, menu.clipId)
      const locked = location ? isTextLocked(location.track) : false
      const availability = getTextActionAvailability(project, menu.clipId, playhead)
      return [
        {
          label: '编辑文字',
          disabled: locked,
          reason: lockedReason,
          onSelect: () => {
            selectClip(menu.clipId)
            focusTextEditor()
          },
        },
        {
          label: '分割',
          shortcut: 'Ctrl+B',
          disabled: locked || !availability.canSplit,
          reason: playheadReason(locked),
          onSelect: splitAtPlayhead,
        },
        {
          label: '删除',
          shortcut: 'Delete',
          danger: true,
          separator: true,
          disabled: locked,
          reason: lockedReason,
          onSelect: deleteSelectedClip,
        },
      ]
    }

    // 视频片段（主轨 + 叠加轨）
    const location = findClipLocation(project, menu.clipId)
    const clip = location?.clip ?? null
    const isOverlay = Boolean(location?.track)
    const locked = location
      ? location.track
        ? isOverlayLocked(location.track)
        : isMainLocked(project)
      : false
    const isFreeze = clip?.type === 'freeze'
    const availability = getActionAvailability(project, menu.clipId, playhead)
    const reason = playheadReason(locked)
    const freezeReason = locked
      ? lockedReason
      : isOverlay
        ? '定格只支持主轨片段'
        : '播放头超出时间轴范围'
    return [
      {
        label: '分割',
        shortcut: 'Ctrl+B',
        disabled: locked || !availability.canSplit,
        reason,
        onSelect: splitAtPlayhead,
      },
      {
        label: '左裁',
        shortcut: 'Q',
        disabled: locked || !availability.canTrimLeft,
        reason,
        onSelect: trimLeftAtPlayhead,
      },
      {
        label: '右裁',
        shortcut: 'W',
        disabled: locked || !availability.canTrimRight,
        reason,
        onSelect: trimRightAtPlayhead,
      },
      {
        label: '复制',
        shortcut: 'Ctrl+C',
        separator: true,
        onSelect: copySelection,
      },
      {
        label: '剪切',
        shortcut: 'Ctrl+X',
        disabled: locked,
        reason: lockedReason,
        onSelect: cutSelection,
      },
      {
        label: '分离音频',
        separator: true,
        disabled: locked || isFreeze,
        reason: locked ? lockedReason : '定格片段没有声音',
        onSelect: () => detachAudio(menu.clipId),
      },
      {
        label: '定格',
        disabled: locked || !availability.canFreeze,
        reason: freezeReason,
        onSelect: insertFreeze,
      },
      {
        label: '删除',
        shortcut: 'Delete',
        danger: true,
        separator: true,
        disabled: locked,
        reason: lockedReason,
        onSelect: deleteSelectedClip,
      },
      {
        label: '属性',
        disabled: locked,
        reason: lockedReason,
        onSelect: () => selectClip(menu.clipId),
      },
    ]
  }

  return (
    <section
      className="timeline-shell"
      aria-label="时间轴"
      onDragOver={handleAssetDragOver}
      onDrop={handleAssetDrop}
    >
      <div
        className="timeline-resize-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="拖动调整时间轴高度，双击恢复默认"
        title="上下拖动调整时间轴高度；双击恢复默认"
        onPointerDown={startTimelineResize}
        onDoubleClick={resetTimelineHeight}
      />
      <div className="timeline-header">
        <div className="timeline-heading">
          <span className="timeline-kicker">时间轴</span>
          <span className="timeline-summary">
            {project.clips.length} 片段
            {overlayTracks.length > 0 && <> · {overlayTracks.length} 叠加轨</>}
            <span className="timeline-summary-dot" />
            {formatClock(total)}
            {project.markers.length > 0 && (
              <>
                <span className="timeline-summary-dot" />
                {project.markers.length} 标记
              </>
            )}
          </span>
          <button
            type="button"
            className="button mini overlay-add"
            title="封面：截取当前帧 / 上传图片 / 选择导出方式"
            onClick={openCoverPanel}
          >
            <Icon name="fit" size={12} />
            封面
          </button>
          <button
            type="button"
            className="button mini overlay-add"
            title="在播放头添加文本片段"
            onClick={addTextAtPlayhead}
          >
            <Icon name="text" size={12} />
            文本
          </button>
          <button
            type="button"
            className="button mini overlay-add"
            title="新增一条音频轨；从素材库添加音频"
            onClick={addAudioTrack}
          >
            <Icon name="music" size={12} />
            音频轨
          </button>
          <button
            type="button"
            className="button mini overlay-add"
            disabled={overlayTracks.length >= MAX_OVERLAY_TRACKS}
            title={
              overlayTracks.length >= MAX_OVERLAY_TRACKS
                ? '最多 8 条视频轨（主轨 + 7 条叠加轨）'
                : '把当前主轨片段复制为可调整的画中画叠加轨'
            }
            onClick={addOverlayTrack}
          >
            <Icon name="plus" size={12} />
            叠加轨
          </button>
        </div>
        <div className="timeline-switches" role="group" aria-label="时间轴开关">
          {([
            ['mainTrackMagnet', '主轨磁吸'],
            ['autoSnap', '自动吸附'],
            ['linkage', '联动'],
            ['previewAxis', '预览轴'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`timeline-switch${timelineSettings[key] ? ' is-on' : ''}`}
              aria-pressed={timelineSettings[key]}
              title={
                key === 'mainTrackMagnet'
                  ? '打开后主轨片段始终贴合，按拖动顺序重排且没有空隙'
                  : key === 'autoSnap'
                    ? '吸附到片段边缘、标记、播放头和时间轴起点，拖动与裁剪边缘均生效'
                    : key === 'linkage'
                      ? '移动片段时目标轨后续片段随位移平移'
                      : '显示鼠标悬停时间轴预览线'
              }
              onClick={() => toggleTimelineSetting(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="timeline-zoom">
          <Icon name="zoom" size={14} />
          <span className="zoom-caption">时间轴缩放</span>
          <button
            type="button"
            className="zoom-button"
            aria-label="缩小时间轴"
            title="缩小时间轴"
            disabled={pps <= TIMELINE_MIN_ZOOM}
            onClick={() => changeZoom(Math.max(TIMELINE_MIN_ZOOM, pps / 1.25))}
          >
            <Icon name="minus" size={13} />
          </button>
          <input
            className="zoom-range"
            type="range"
            min={TIMELINE_MIN_ZOOM}
            max={TIMELINE_MAX_ZOOM}
            step={1}
            value={pps}
            aria-label="时间轴缩放"
            onChange={(event) => changeZoom(Number(event.target.value))}
          />
          <button
            type="button"
            className="zoom-button"
            aria-label="放大时间轴"
            title="放大时间轴"
            disabled={pps >= TIMELINE_MAX_ZOOM}
            onClick={() => changeZoom(Math.min(TIMELINE_MAX_ZOOM, pps * 1.25))}
          >
            <Icon name="plus" size={13} />
          </button>
          <span className="zoom-tip">Ctrl + 滚轮</span>
          <button
            type="button"
            className="zoom-button"
            aria-label="适应窗口"
            title="时间轴适应窗口 · Shift + Z"
            onClick={() => zoomToFit()}
          >
            <Icon name="fit" size={13} />
          </button>
        </div>
      </div>

      <div className="timeline-body">
        <div className="track-gutter" ref={gutterRef} aria-label="轨道控制">
          <TrackGutter />
        </div>
        <div
          className="timeline-scroll"
          ref={scrollRef}
          onScroll={(event) => {
            setScrollLeft(event.currentTarget.scrollLeft)
            if (gutterRef.current) {
              gutterRef.current.scrollTop = event.currentTarget.scrollTop
            }
            if (popover) setPopover(null)
          }}
        >
        <div
          className="timeline-content"
          ref={contentRef}
          style={{ width: contentWidth }}
          role="listbox"
          aria-multiselectable="true"
          aria-label="时间轴片段"
          onPointerDown={handleContentPointerDown}
          onDoubleClick={handleContentDoubleClick}
          onContextMenu={(event) => {
            // 时间轴上统一用应用内菜单：空白处右键只关闭已有菜单，不弹浏览器原生菜单。
            event.preventDefault()
            setClipMenu(null)
          }}
          onPointerMove={(event) => {
            if (!timelineSettings.previewAxis) return
            const rect = event.currentTarget.getBoundingClientRect()
            setHoverTime(clamp((event.clientX - rect.left - pad) / pps, 0, total))
          }}
          onPointerLeave={() => setHoverTime(null)}
        >
          <div
            className="timeline-ruler"
            style={{
              backgroundImage:
                'linear-gradient(to right, rgba(31, 30, 27, 0.075) 1px, transparent 1px)',
              backgroundSize: `${tickStepPx}px 100%`,
              backgroundPositionX: `${pad}px`,
            }}
          >
            {ticks.map((tick, index) => (
              <span
                key={tick.time}
                className={`ruler-tick${index === 0 ? ' is-first' : ''}`}
                style={{ left: tick.x }}
              >
                <span className="ruler-label">{formatRulerTime(tick.time, majorStep)}</span>
              </span>
            ))}
          </div>

          <div className="marker-lane">
            {project.markers.map((marker) => {
              const x = pad + marker.time * pps
              return (
                <button
                  key={marker.id}
                  type="button"
                  className={`marker-flag${openMarker?.id === marker.id ? ' is-open' : ''}`}
                  style={{ left: x, color: marker.color }}
                  aria-label={`标记 ${formatClock(marker.time)}${marker.note ? `，${marker.note}` : ''}`}
                  title={`${marker.note || '标记'} · ${formatClock(marker.time)}（右键编辑）`}
                  onPointerEnter={(event) => markerEnter(event, marker)}
                  onPointerLeave={markerLeave}
                  onClick={(event) => markerClick(event, marker)}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    markerClick(event, marker)
                  }}
                >
                  <Icon name="marker" size={15} />
                  {marker.note && <span className="marker-note-dot" />}
                </button>
              )
            })}
          </div>

          <div className="overlay-tracks">
            {overlayDisplayTracks.map((track) => {
              const trackSegments = getTimeline(track.clips)
              return (
                <div className={`overlay-track${
                  clipDrag?.active && clipDrag.targetTrackId === track.id ? ' is-drop-target' : ''
                }${track.hidden ? ' is-hidden' : ''}`}
                key={track.id}
                data-overlay-track-id={track.id}
              >
                  <div className="overlay-track-head">
                    <span className="overlay-track-name">
                      <Icon name="film" size={12} />
                      {track.name}
                    </span>
                    <button
                      type="button"
                      className={`track-control${track.hidden ? ' is-off' : ''}`}
                      aria-label={track.hidden ? `显示${track.name}` : `隐藏${track.name}`}
                      title={track.hidden ? '显示叠加轨' : '隐藏叠加轨（导出同样生效）'}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => toggleOverlayTrackVisibility(track.id)}
                    >
                      <Icon name={track.hidden ? 'eyeOff' : 'eye'} size={12} />
                    </button>
                    <button
                      type="button"
                      className="overlay-track-remove"
                      aria-label={`删除${track.name}`}
                      title="删除叠加轨（可撤销）"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => removeOverlayTrack(track.id)}
                    >
                      <Icon name="close" size={12} />
                    </button>
                  </div>
                  <div
                    className="overlay-clip-lane"
                    style={{
                      backgroundImage:
                        'linear-gradient(to right, rgba(31, 30, 27, 0.045) 1px, transparent 1px)',
                      backgroundSize: `${tickStepPx}px 100%`,
                      backgroundPositionX: `${pad}px`,
                    }}
                  >
                    {trackSegments.map((segment) => {
                      const { clip } = segment
                      const width = Math.max(4, segment.duration * pps - 2)
                      const asset = assetForClip(clip)
                      const thumbnail = thumbnailFor(clip)
                      const isSelected = selectedIdSet.has(clip.id)
                      const isFreeze = clip.type === 'freeze'
                      const isDragging = clipDrag?.active && clipDrag.clipId === clip.id
                      return (
                        <div
                          key={clip.id}
                          className={`clip-bar is-overlay ${isFreeze ? 'is-freeze' : 'is-video'}${
                            isSelected ? ' is-selected' : ''
                          }${isDragging ? ' is-dragging is-drag-source' : ''}${
                            assetUrls.has(clip.sourceUrl) ? '' : ' is-missing'
                          }`}
                          data-clip-id={clip.id}
                          data-track-id={track.id}
                          onPointerDown={() => setKeySelection(null)}
                          style={{ left: pad + segment.start * pps + 1, width }}
                          role="option"
                          aria-selected={isSelected}
                          tabIndex={0}
                          onKeyDown={handleClipKeyDown(clip.id)}
                          onContextMenu={(event) => openClipMenu(event, 'video', clip.id)}
                          aria-label={`叠加片段 ${segment.index + 1}，${segment.duration.toFixed(1)} 秒`}
                        >
                          {!assetUrls.has(clip.sourceUrl) && (
                            <span className="clip-missing" title="素材已从缓存移除，需重新导入">
                              <Icon name="unlink" size={12} />
                              <span className="clip-missing-label">素材已移除</span>
                            </span>
                          )}
                          {!isFreeze && asset && (
                            <ClipFilmstrip clip={clip} asset={asset} width={width} />
                          )}
                          {!isFreeze && !asset && thumbnail && (
                            <span
                              className="clip-thumb"
                              style={{ backgroundImage: `url("${thumbnail}")` }}
                            />
                          )}
                          {isFreeze && (
                            <span className="freeze-texture">
                              <Icon name="freeze" size={12} />
                            </span>
                          )}
                          <ClipKeyframeBand
                            clip={clip}
                            clipStart={segment.start}
                            duration={segment.duration}
                            pps={pps}
                            selected={keySelection?.clipId === clip.id ? keySelection.refs : []}
                            snapCandidates={keyframeSnapCandidates(clip.id)}
                            autoSnap={timelineSettings.autoSnap}
                            onSelect={(refs, additive) => selectKeyframes(clip.id, refs, additive)}
                            onCommitMove={(refs, deltaT) => commitKeyframeMove(clip.id, refs, deltaT)}
                            onRequestEasing={(refs, x, y) =>
                              setEasingPopover({ x, y, clipId: clip.id, refs })
                            }
                            onRequestMenu={(refs, x, y) =>
                              setKeyMenu({ x, y, clipId: clip.id, refs })
                            }
                          />
                          <span className="clip-copy">
                            <span className="clip-kind">叠加</span>
                            {clipSpeedValue(clip) !== 1 && (
                              <span
                                className={`clip-speed-badge${
                                  clipSpeedValue(clip) > 1 ? ' is-fast' : ' is-slow'
                                }`}
                                title={`变速 ${clipSpeedValue(clip).toFixed(2)}x`}
                              >
                                {clipSpeedValue(clip).toFixed(1)}x
                              </span>
                            )}
                            {width > 90 && (
                              <span className="clip-duration">{segment.duration.toFixed(1)}s</span>
                            )}
                          </span>
                          <span
                            className="clip-trim-handle is-left"
                            role="separator"
                            aria-label="拖动修改叠加入点"
                            title={isFreeze ? '调整入点 / 定格起点' : '拖动修改入点，可拉回被裁素材'}
                            onPointerDown={(event) =>
                              startEdgeDrag(event, segment, 'left', track)
                            }
                          ><span /></span>
                          <span
                            className="clip-trim-handle is-right"
                            role="separator"
                            aria-label="拖动修改叠加出点"
                            title={isFreeze ? '调整出点 / 定格时长' : '拖动修改出点，可拉回被裁素材'}
                            onPointerDown={(event) =>
                              startEdgeDrag(event, segment, 'right', track)
                            }
                          ><span /></span>
                        </div>
                      )
                    })}
                    {track.clips.length === 0 && (
                      <span className="overlay-track-empty">空叠加轨</span>
                    )}
                    {clipDrag?.active &&
                      clipDrag.targetTrackId === track.id && (
                        <div
                          className={`clip-bar is-drag-ghost ${
                            dragGhostIsFreeze ? 'is-freeze' : 'is-video'
                          }`}
                          style={{ left: pad + clipDrag.targetTime * pps + 1, width: dragGhostWidth }}
                          aria-hidden="true"
                        >
                          {!dragGhostIsFreeze && dragGhostThumbnail && (
                            <span
                              className="clip-thumb"
                              style={{ backgroundImage: `url("${dragGhostThumbnail}")` }}
                            />
                          )}
                          <span className="clip-copy">
                            <span className="clip-kind">移动中</span>
                            {dragGhostWidth > 94 && (
                              <span className="clip-duration">
                                {dragGhostDuration.toFixed(1)}s
                              </span>
                            )}
                          </span>
                        </div>
                      )}
                  </div>
                </div>
              )
            })}
          </div>

          {overlayTracks.length > 0 && (
            <div className="base-track-head">
              <span className="overlay-track-name">
                <Icon name="film" size={12} />
                主轨
              </span>
            </div>
          )}

          <div
            className={`clip-lane${
              clipDrag?.active && clipDrag.targetTrackId === null ? ' is-drop-target' : ''
            }`}
            style={{
              backgroundImage:
                'linear-gradient(to right, rgba(31, 30, 27, 0.045) 1px, transparent 1px)',
              backgroundSize: `${tickStepPx}px 100%`,
              backgroundPositionX: `${pad}px`,
            }}
          >
            {gapBands.map((gap) => {
              const width = Math.max(2, gap.duration * pps)
              return (
                <span
                  key={`gap-${gap.start.toFixed(3)}`}
                  className="timeline-gap"
                  style={{ left: pad + gap.start * pps, width }}
                  aria-hidden="true"
                >
                  {width > 46 && <span className="timeline-gap-label">空隙</span>}
                </span>
              )
            })}
            {hasCoverBlock && (
              <button
                type="button"
                className="timeline-cover-block"
                style={{ left: BASE_PAD, width: COVER_BLOCK_WIDTH }}
                title="封面：点击设置（截取当前帧 / 上传图片 / 导出模式）"
                aria-label="封面"
                onPointerEnter={() => setCoverPreview(true)}
                onPointerLeave={() => setCoverPreview(false)}
                onFocus={() => setCoverPreview(true)}
                onBlur={() => setCoverPreview(false)}
                onClick={() => openCoverPanel()}
              >
                <img
                  className="timeline-cover-thumb"
                  src={project.cover?.dataUrl}
                  alt=""
                  draggable={false}
                />
                <span className="timeline-cover-badge">封面</span>
              </button>
            )}
            {segments.map((segment) => {
              const { clip } = segment
              const asset = assetForClip(clip)
              const thumbnail = thumbnailFor(clip)
              const preview = edgeDrag?.clipId === clip.id ? edgeDrag : null
              const delta = preview?.delta ?? 0
              const renderStart = segment.start + (preview?.edge === 'left' ? delta : 0)
              const renderDuration =
                segment.duration +
                (preview ? (preview.edge === 'left' ? -delta : delta) : 0)
              const width = Math.max(4, renderDuration * pps - 2)
              const isSelected = selectedIdSet.has(clip.id)
              const isFreeze = clip.type === 'freeze'
              const isDragging = clipDrag?.active && clipDrag.clipId === clip.id
              return (
                <div
                  key={clip.id}
                  className={`clip-bar ${isFreeze ? 'is-freeze' : 'is-video'}${
                    isSelected ? ' is-selected' : ''
                  }${isDragging ? ' is-dragging is-drag-source' : ''}${
                    assetUrls.has(clip.sourceUrl) ? '' : ' is-missing'
                  }`}
                  data-clip-id={clip.id}
                  data-track-id="base"
                  onPointerDown={() => setKeySelection(null)}
                  style={{ left: pad + renderStart * pps + 1, width }}
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={0}
                  onKeyDown={handleClipKeyDown(clip.id)}
                  onContextMenu={(event) => openClipMenu(event, 'video', clip.id)}
                  aria-label={`${isFreeze ? '定格' : '视频'}片段 ${
                    segment.index + 1
                  }，${renderDuration.toFixed(1)} 秒`}
                >
                  {!assetUrls.has(clip.sourceUrl) && (
                    <span className="clip-missing" title="素材已从缓存移除，需重新导入">
                      <Icon name="unlink" size={12} />
                      <span className="clip-missing-label">素材已移除</span>
                    </span>
                  )}
                  {!isFreeze && asset && (
                    <ClipFilmstrip clip={clip} asset={asset} width={width} />
                  )}
                  {!isFreeze && !asset && thumbnail && (
                    <span
                      className="clip-thumb"
                      style={{ backgroundImage: `url("${thumbnail}")` }}
                    />
                  )}
                  {isFreeze && (
                    <span className="freeze-texture">
                      <Icon name="freeze" size={13} />
                    </span>
                  )}
                  <ClipKeyframeBand
                    clip={clip}
                    clipStart={segment.start}
                    duration={segment.duration}
                    pps={pps}
                    selected={keySelection?.clipId === clip.id ? keySelection.refs : []}
                    snapCandidates={keyframeSnapCandidates(clip.id)}
                    autoSnap={timelineSettings.autoSnap}
                    onSelect={(refs, additive) => selectKeyframes(clip.id, refs, additive)}
                    onCommitMove={(refs, deltaT) => commitKeyframeMove(clip.id, refs, deltaT)}
                    onRequestEasing={(refs, x, y) => setEasingPopover({ x, y, clipId: clip.id, refs })}
                    onRequestMenu={(refs, x, y) => setKeyMenu({ x, y, clipId: clip.id, refs })}
                  />
                  <span className="clip-copy">
                    <span className="clip-index">
                      {String(segment.index + 1).padStart(2, '0')}
                    </span>
                    <span className="clip-kind">{isFreeze ? '定格' : '视频'}</span>
                    {clipSpeedValue(clip) !== 1 && (
                      <span
                        className={`clip-speed-badge${
                          clipSpeedValue(clip) > 1 ? ' is-fast' : ' is-slow'
                        }`}
                        title={`变速 ${clipSpeedValue(clip).toFixed(2)}x`}
                      >
                        {clipSpeedValue(clip).toFixed(1)}x
                      </span>
                    )}
                    {width > 110 && (
                      <span className="clip-duration">{renderDuration.toFixed(1)}s</span>
                    )}
                  </span>
                  <span
                    className="clip-trim-handle is-left"
                    role="separator"
                    aria-label="拖动修改片段入点"
                    title={isFreeze ? '调整入点 / 定格起点（0.5–10 秒）' : '拖动修改入点，可拉回被裁素材'}
                    onPointerDown={(event) => startEdgeDrag(event, segment, 'left')}
                  ><span /></span>
                  <span
                    className="clip-trim-handle is-right"
                    role="separator"
                    aria-label="拖动修改片段出点"
                    title={isFreeze ? '调整出点 / 定格时长（0.5–10 秒）' : '拖动修改出点，可拉回被裁素材'}
                    onPointerDown={(event) => startEdgeDrag(event, segment, 'right')}
                  ><span /></span>
                </div>
              )
            })}

            {/* 主轨相邻片段交界处的转场标记：可点击进入属性面板的转场设置。 */}
            {segments.map((segment, index) => {
              const next = segments[index + 1]
              if (!next) return null
              const nextClip = next.clip
              const gap = Math.max(0, nextClip.gapBefore ?? 0)
              if (!hasTransitionPair(segment.clip, nextClip, gap)) return null
              const active = Boolean(segment.clip.transitionOut)
              const x = pad + (active ? next.start + (next.duration - 0) * 0 : next.start) * pps
              return (
                <button
                  key={`transition-${segment.clip.id}`}
                  type="button"
                  className={`transition-marker${active ? ' is-active' : ''}`}
                  style={{ left: x - 9 }}
                  aria-label={
                    active
                      ? `转场：${transitionLabel(normalizeTransitionType(segment.clip.transitionOut?.type))}，点击编辑`
                      : '添加转场'
                  }
                  title={
                    active
                      ? `转场 ${segment.clip.transitionOut?.duration.toFixed(1)}s（点击编辑）`
                      : '点击添加转场'
                  }
                  onClick={(event) => {
                    event.stopPropagation()
                    selectClip(segment.clip.id)
                  }}
                >
                  <Icon name="split" size={12} />
                </button>
              )
            })}

            {clipDrag?.active && clipDrag.targetTrackId === null && (
              <div
                className={`clip-bar is-drag-ghost ${
                  dragGhostIsFreeze ? 'is-freeze' : 'is-video'
                }`}
                style={{ left: pad + clipDrag.targetTime * pps + 1, width: dragGhostWidth }}
                aria-hidden="true"
              >
                {!dragGhostIsFreeze && dragGhostThumbnail && (
                  <span
                    className="clip-thumb"
                    style={{ backgroundImage: `url("${dragGhostThumbnail}")` }}
                  />
                )}
                <span className="clip-copy">
                  <span className="clip-kind">移动中</span>
                  {dragGhostWidth > 94 && (
                    <span className="clip-duration">{dragGhostDuration.toFixed(1)}s</span>
                  )}
                </span>
              </div>
            )}

            {clipDrag?.active && (
              <span
                className={`clip-drop-line is-global${
                  clipDrag.snapKind ? ` is-snap-${clipDrag.snapKind}` : ''
                }`}
                style={{ left: dropX }}
                aria-hidden="true"
              />
            )}

            {project.clips.length === 0 && overlayTracks.length === 0 && (
              <div className="timeline-empty">
                <span className="timeline-empty-icon">
                  <Icon name="film" size={18} />
                </span>
                <span>时间轴还是空的</span>
                <button
                  type="button"
                  className="button mini"
                  onClick={onPickFile}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  导入视频
                </button>
              </div>
            )}
          </div>

          <AudioTracks
            pps={pps}
            onClipContextMenu={(event, clipId) => openClipMenu(event, 'audio', clipId)}
            keySelection={keySelection}
            onSelectKeyframes={selectKeyframes}
            onCommitKeyframeMove={commitKeyframeMove}
            onRequestKeyframeEasing={(clipId, refs, x, y) =>
              setEasingPopover({ x, y, clipId, refs })
            }
            onRequestKeyframeMenu={(clipId, refs, x, y) =>
              setKeyMenu({ x, y, clipId, refs })
            }
            keyframeSnapCandidates={keyframeSnapCandidates}
            autoSnap={timelineSettings.autoSnap}
          />

          <TextTracks
            onClipContextMenu={(event, clipId) => openClipMenu(event, 'text', clipId)}
          />

          {edgeDrag?.snapTime !== null && edgeDrag?.snapTime !== undefined && (
            <span
              className="clip-drop-line is-global is-snap-auto"
              style={{ left: pad + edgeDrag.snapTime * pps }}
              aria-hidden="true"
            />
          )}
          <div className="playhead" style={{ left: pad + playhead * pps }}>
            <span
              className={`playhead-handle${playheadDrag ? ' is-dragging' : ''}`}
              role="slider"
              aria-label="播放头"
              aria-valuemin={0}
              aria-valuemax={Math.round(total * 10) / 10}
              aria-valuenow={Math.round(playhead * 10) / 10}
              aria-valuetext={`${playhead.toFixed(1)} 秒`}
              tabIndex={0}
              onPointerDown={handlePlayheadPointerDown}
            />
            <span className="playhead-line" />
          </div>
          {timelineSettings.previewAxis && hoverTime !== null && (
            <div className="timeline-preview-axis" style={{ left: pad + hoverTime * pps }}>
              <span>{formatClock(hoverTime)}</span>
            </div>
          )}
          {boxSelect?.active && (
            <div
              className="timeline-box-select"
              style={{
                left: Math.min(boxSelect.startX, boxSelect.x),
                top: Math.min(boxSelect.startY, boxSelect.y),
                width: Math.abs(boxSelect.x - boxSelect.startX),
                height: Math.abs(boxSelect.y - boxSelect.startY),
              }}
              aria-hidden="true"
            />
          )}
        </div>
      </div>
      </div>

      {clipDrag?.active && (
        <div
          className="clip-drop-hint"
          style={{ left: dropHintLeft, top: dropHintTop }}
          role="status"
        >
          松开：{dropTrackName} · {clipDrag?.targetTime.toFixed(1)}s
          {clipDrag?.snapLabel ? ` · 吸附 ${clipDrag.snapLabel}` : ''}
        </div>
      )}

      {popover && openMarker && (
        <MarkerPopover
          marker={openMarker}
          anchor={popover.anchor}
          onClose={closePopover}
          onPointerEnter={() => {
            if (closeTimer.current) window.clearTimeout(closeTimer.current)
          }}
          onPointerLeave={markerLeave}
        />
      )}

      {easingPopover && (
        <EasingPopover
          x={easingPopover.x}
          y={easingPopover.y}
          current={commonEasing(easingPopover)}
          count={easingPopover.refs.length}
          onPick={(ease: Easing) => setKeyframeEasing(easingPopover.refs, ease)}
          onClose={() => setEasingPopover(null)}
        />
      )}

      {keyMenu && (
        <ContextMenu
          x={keyMenu.x}
          y={keyMenu.y}
          ariaLabel="关键帧操作"
          items={[
            {
              label: '缓动…',
              onSelect: () => setEasingPopover({ ...keyMenu }),
            },
            {
              label: '删除关键帧',
              danger: true,
              onSelect: () => {
                deleteKeyframes(keyMenu.clipId, keyMenu.refs)
                setKeySelection(null)
              },
            },
          ]}
          onClose={() => setKeyMenu(null)}
        />
      )}

      {clipMenu && (
        <ContextMenu
          x={clipMenu.x}
          y={clipMenu.y}
          items={buildClipMenuItems(clipMenu)}
          onClose={closeClipMenu}
          ariaLabel={`${clipMenu.kind === 'audio' ? '音频' : clipMenu.kind === 'text' ? '文本' : '视频'}片段操作`}
        />
      )}
    </section>
  )
}