import { CLIP_EDGE_EPSILON, FREEZE_DEFAULT_DURATION, FREEZE_MAX_DURATION, FREEZE_MIN_DURATION, MIN_CLIP_DURATION } from './constants'
import { aspectValue, createDefaultExportQuality } from './aspect'
import { createId } from './ids'
import { IMAGE_DEFAULT_DURATION, IMAGE_MAX_DURATION, IMAGE_MIN_DURATION } from './image'
import { DEFAULT_TRACK_STATE, isMainLocked, isOverlayLocked } from './tracks'
import {
  clipFreezeFrame,
  clipSourceSpan,
  clipSpanSourceAt,
  clipTimelineDuration,
} from './clipTime'
import { findClipLocation, findSegmentById, getProjectDuration, getTimeline, clamp } from './timeline'
import {
  clampTransitionDuration,
  clipTransitionOut,
  maxTransitionDuration,
  normalizeTransitionType,
  TRANSITION_EPSILON,
  TRANSITION_MIN_DURATION,
} from './transition'
import { normalizeColor, isSameColor, type ColorAdjustments } from './color'
import type {
  AspectRatioPreset,
  Clip,
  CropRect,
  ExportQuality,
  Marker,
  MediaKind,
  OverlayTrack,
  Project,
  SourceInfo,
  TextClip,
  TrackState,
  TransitionType,
} from './types'

export const FULL_CROP: CropRect = { x: 0, y: 0, w: 1, h: 1 }

export function createEmptyProject(): Project {
  return {
    aspectRatio: 'original',
    clips: [],
    overlayTracks: [],
    audioTracks: [],
    textTracks: [],
    mainTrack: { ...DEFAULT_TRACK_STATE },
    markers: [],
    exportQuality: createDefaultExportQuality(),
  }
}

export function createClip(
  sourceUrl: string,
  sourceStart: number,
  sourceEnd: number,
  overrides: Partial<Omit<Clip, 'id' | 'sourceUrl' | 'sourceStart' | 'sourceEnd'>> = {},
  id?: string,
): Clip {
  return {
    id: id ?? createId('clip'),
    sourceUrl,
    sourceStart,
    sourceEnd,
    type: 'video',
    rotation: 0,
    flipH: false,
    flipV: false,
    crop: { ...FULL_CROP },
    scale: 1,
    position: { x: 0, y: 0 },
    gapBefore: 0,
    ...overrides,
  }
}

/**
 * 首个素材入轨时的初始工程。
 * 图片素材要建成静帧片段（type: 'image'），否则视频元素无法解码这张图。
 */
export function createInitialProject(
  source: Pick<SourceInfo, 'url' | 'duration'>,
  clipId: string,
  kind: MediaKind = 'video',
): Project {
  const duration = Math.max(0.1, source.duration)
  const clip =
    kind === 'image'
      ? createClip(source.url, 0, IMAGE_DEFAULT_DURATION, { type: 'image', volume: 0 }, clipId)
      : createClip(source.url, 0, duration, {}, clipId)
  return {
    aspectRatio: 'original',
    clips: [clip],
    overlayTracks: [],
    audioTracks: [],
    textTracks: [],
    mainTrack: { ...DEFAULT_TRACK_STATE },
    markers: [],
    exportQuality: createDefaultExportQuality(),
  }
}

export function normalizeAngle(value: number): number {
  if (!Number.isFinite(value)) return 0
  let angle = value % 360
  if (angle > 180) angle -= 360
  if (angle < -180) angle += 360
  return angle
}

export function clampCrop(crop: CropRect): CropRect {
  const min = 0.01
  const x = clamp(crop.x, 0, 1 - min)
  const y = clamp(crop.y, 0, 1 - min)
  const w = clamp(crop.w, min, 1 - x)
  const h = clamp(crop.h, min, 1 - y)
  return { x, y, w, h }
}

export function splitProjectAt(
  project: Project,
  clipId: string,
  time: number,
  rightId: string,
): Project | null {
  const segment = findSegmentById(project.clips, clipId)
  if (!segment) return null
  if (
    time <= segment.start + CLIP_EDGE_EPSILON ||
    time >= segment.end - CLIP_EDGE_EPSILON
  ) {
    return null
  }
  const offset = time - segment.start
  if (offset < MIN_CLIP_DURATION || segment.duration - offset < MIN_CLIP_DURATION) return null

  const splitSourceTime = clipSpanSourceAt(segment.clip, offset)
  const left: Clip = { ...segment.clip, sourceEnd: splitSourceTime }
  const right: Clip = {
    ...segment.clip,
    id: rightId,
    sourceStart: splitSourceTime,
    sourceEnd: clipSourceSpan(segment.clip).end,
    gapBefore: 0,
  }
  if (segment.clip.type === 'freeze') {
    const frame = clipFreezeFrame(segment.clip)
    left.freezeFrameTime = frame
    right.freezeFrameTime = frame
  }

  const clips = [...project.clips]
  clips.splice(segment.index, 1, left, right)
  return { ...project, clips }
}

export function trimProjectLeft(project: Project, clipId: string, time: number): Project | null {
  const segment = findSegmentById(project.clips, clipId)
  if (!segment) return null
  if (
    time <= segment.start + CLIP_EDGE_EPSILON ||
    time >= segment.end - CLIP_EDGE_EPSILON
  ) {
    return null
  }
  const delta = time - segment.start
  if (segment.duration - delta < MIN_CLIP_DURATION) return null
  if (clipSpanSourceAt(segment.clip, delta) >= clipSourceSpan(segment.clip).end - MIN_CLIP_DURATION) return null

  // Keep the right edge in place and leave a recoverable gap on the left.
  const updated: Clip = {
    ...segment.clip,
    sourceStart: clipSpanSourceAt(segment.clip, delta),
    gapBefore: (segment.clip.gapBefore ?? 0) + delta,
  }
  const clips = project.clips.map((clip) => (clip.id === clipId ? updated : clip))
  return { ...project, clips }
}

export function trimProjectRight(project: Project, clipId: string, time: number): Project | null {
  const segment = findSegmentById(project.clips, clipId)
  if (!segment) return null
  if (
    time <= segment.start + CLIP_EDGE_EPSILON ||
    time >= segment.end - CLIP_EDGE_EPSILON
  ) {
    return null
  }
  const delta = segment.end - time
  if (segment.duration - delta < MIN_CLIP_DURATION) return null

  // Move the out point left. If another clip follows, grow its leading gap so
  // the rest of the timeline stays put and the trimmed source remains visible
  // behind a draggable right edge.
  const clips = project.clips.map((clip, index) => {
    if (clip.id === clipId) {
      return { ...clip, sourceEnd: clipSpanSourceAt(clip, clipTimelineDuration(clip) - delta) }
    }
    if (index === segment.index + 1) {
      return { ...clip, gapBefore: (clip.gapBefore ?? 0) + delta }
    }
    return clip
  })
  return { ...project, clips }
}

/**
 * Drag a clip edge. Positive delta extends the visible source to the right /
 * restores earlier source on the left; negative delta trims it.
 */
export function resizeClipEdge(
  project: Project,
  clipId: string,
  edge: 'left' | 'right',
  delta: number,
  sourceDuration: number,
): Project | null {
  const segment = findSegmentById(project.clips, clipId)
  if (!segment || !Number.isFinite(delta) || Math.abs(delta) < 0.0001) return null
  const clip = segment.clip
  const duration = segment.duration
  const freeze = clip.type === 'freeze'
  const image = clip.type === 'image'
  const minDuration = freeze ? FREEZE_MIN_DURATION : image ? IMAGE_MIN_DURATION : MIN_CLIP_DURATION
  const maxDuration = freeze
    ? FREEZE_MAX_DURATION
    : image
      ? IMAGE_MAX_DURATION
      : Number.POSITIVE_INFINITY

  if (edge === 'left') {
    const gap = Math.max(0, clip.gapBefore ?? 0)
    // 静帧（图片）没有“更早的源素材”概念，左边缘只受空隙与最大时长限制。
    const maxRestore = Math.min(
      gap,
      image ? Number.POSITIVE_INFINITY : Math.max(0, clipSpanSourceAt(clip, 0)),
      Math.max(0, maxDuration - duration),
    )
    const maxTrim = Math.max(0, duration - minDuration)
    const actual = clamp(delta, -maxRestore, maxTrim)
    if (Math.abs(actual) < 0.0001) return null
    const updated: Clip = {
      ...clip,
      sourceStart: clipSpanSourceAt(clip, actual),
      gapBefore: gap + actual,
    }
    const clips = project.clips.map((item) => (item.id === clipId ? updated : item))
    return { ...project, clips }
  }

  const next = project.clips[segment.index + 1] ?? null
  const nextGap = Math.max(0, next?.gapBefore ?? 0)
  const sourceGrow = freeze
    ? Math.max(0, FREEZE_MAX_DURATION - duration)
    : clip.type === 'image'
      ? Math.max(0, IMAGE_MAX_DURATION - duration)
      : Math.max(0, sourceDuration - clipSourceSpan(clip).end)
  const maxGrow = next ? Math.min(sourceGrow, nextGap) : sourceGrow
  const maxShrink = Math.max(0, duration - minDuration)
  const actual = clamp(delta, -maxShrink, maxGrow)
  if (Math.abs(actual) < 0.0001) return null

  const clips = project.clips.map((item, index) => {
    if (item.id === clipId) {
      return { ...item, sourceEnd: clipSpanSourceAt(item, clipTimelineDuration(item) + actual) }
    }
    if (next && index === segment.index + 1) {
      return { ...item, gapBefore: Math.max(0, nextGap - actual) }
    }
    return item
  })
  return { ...project, clips }
}

export function removeClipFromProject(project: Project, clipId: string): Project | null {
  if (!project.clips.some((clip) => clip.id === clipId)) return null
  return {
    ...project,
    clips: project.clips.filter((clip) => clip.id !== clipId),
  }
}

/** Reorder clips without changing their own source ranges or leading gaps. */
export function reorderClipInProject(
  project: Project,
  clipId: string,
  targetIndex: number,
): Project | null {
  const sourceIndex = project.clips.findIndex((clip) => clip.id === clipId)
  if (sourceIndex < 0) return null
  const clips = [...project.clips]
  const [clip] = clips.splice(sourceIndex, 1)
  const index = clamp(Math.round(targetIndex), 0, clips.length)
  clips.splice(index, 0, clip)
  if (clips.every((item, current) => item.id === project.clips[current]?.id)) return null
  return { ...project, clips }
}

export interface FreezeInsertion {
  project: Project
  freeze: Clip
}

/**
 * Inserts a freeze clip at `time`. If the playhead is inside a clip, that clip
 * is split at the same point and the freeze is placed between both halves.
 */
export function insertFreezeAt(
  project: Project,
  time: number,
  freezeId: string,
  duration = FREEZE_DEFAULT_DURATION,
  rightSplitId?: string,
): FreezeInsertion | null {
  if (project.clips.length === 0) return null
  const total = getProjectDuration(project.clips)
  const t = clamp(time, 0, total)
  const timeline = getTimeline(project.clips)
  const hold = clamp(duration, FREEZE_MIN_DURATION, FREEZE_MAX_DURATION)

  let clips = [...project.clips]
  let insertionIndex = clips.length
  let template: Clip | null = null
  let sourceFrame = 0
  let freezeGap = 0

  const inside = timeline.find(
    (segment) => t > segment.start + CLIP_EDGE_EPSILON && t < segment.end - CLIP_EDGE_EPSILON,
  )

  if (inside) {
    const splitSource = clipSpanSourceAt(inside.clip, t - inside.start)
    const left: Clip = { ...inside.clip, sourceEnd: splitSource }
    const right: Clip = {
      ...inside.clip,
      id: rightSplitId ?? createId('clip'),
      sourceStart: splitSource,
      sourceEnd: inside.clip.sourceEnd,
      gapBefore: 0,
    }
    if (inside.clip.type === 'freeze') {
      const frame = clipFreezeFrame(inside.clip)
      left.freezeFrameTime = frame
      right.freezeFrameTime = frame
    }
    clips.splice(inside.index, 1, left, right)
    insertionIndex = inside.index + 1
    template = inside.clip
    sourceFrame =
      inside.clip.type === 'freeze'
        ? clipFreezeFrame(inside.clip)
        : splitSource
  } else {
    insertionIndex = timeline.findIndex((segment) => t <= segment.start + CLIP_EDGE_EPSILON)
    if (insertionIndex < 0) insertionIndex = clips.length
    const next = timeline[insertionIndex]
    const previous = timeline[insertionIndex - 1]
    template = next?.clip ?? previous?.clip ?? null
    const gapStart = previous?.end ?? 0
    freezeGap = Math.max(0, t - gapStart)

    if (next) {
      const nextGap = Math.max(0, next.clip.gapBefore ?? 0)
      const remainder = Math.max(0, nextGap - freezeGap - hold)
      const nextIndex = clips.findIndex((clip) => clip.id === next.clip.id)
      if (nextIndex >= 0) {
        clips[nextIndex] = { ...clips[nextIndex], gapBefore: remainder }
      }
      sourceFrame =
        next.clip.type === 'freeze'
          ? clipFreezeFrame(next.clip)
          : next.clip.sourceStart
    } else if (previous) {
      sourceFrame =
        previous.clip.type === 'freeze'
          ? clipFreezeFrame(previous.clip)
          : previous.clip.sourceEnd
    }
  }

  if (!template) return null

  const freeze: Clip = {
    id: freezeId,
    sourceUrl: template.sourceUrl,
    sourceStart: sourceFrame,
    sourceEnd: sourceFrame + hold,
    type: 'freeze',
    rotation: template.rotation,
    flipH: template.flipH,
    flipV: template.flipV,
    crop: { ...template.crop },
    scale: template.scale,
    position: { ...template.position },
    gapBefore: freezeGap,
    freezeFrameTime: sourceFrame,
  }
  clips.splice(insertionIndex, 0, freeze)
  return { project: { ...project, clips }, freeze }
}

export function resizeFreezeClip(project: Project, clipId: string, duration: number): Project | null {
  const segment = findSegmentById(project.clips, clipId)
  const clip = segment?.clip
  if (!segment || !clip || clip.type !== 'freeze') return null
  const hold = clamp(duration, FREEZE_MIN_DURATION, FREEZE_MAX_DURATION)
  const oldHold = segment.duration
  const diff = hold - oldHold
  if (Math.abs(diff) < 0.0001) return null

  const nextIndex = segment.index + 1
  const nextGap = Math.max(0, project.clips[nextIndex]?.gapBefore ?? 0)
  const clips = project.clips.map((item, index) => {
    if (item.id === clipId) {
      return { ...item, sourceEnd: clipSpanSourceAt(item, hold) }
    }
    if (index === nextIndex) {
      return { ...item, gapBefore: Math.max(0, nextGap - diff) }
    }
    return item
  })
  return { ...project, clips }
}

/** Insert a new clip from a library asset into any track at an explicit time. */
export function addClipToTrackAtTime(
  project: Project,
  clip: Clip,
  targetTrackId: string | null,
  targetStart: number,
): Project | null {
  const tracks = project.overlayTracks ?? []
  if (targetTrackId !== null && !tracks.some((track) => track.id === targetTrackId)) return null
  const targetClips =
    targetTrackId === null
      ? project.clips
      : tracks.find((track) => track.id === targetTrackId)?.clips ?? []
  const originalStarts = new Map<string, number>()
  for (const segment of getTimeline(targetClips)) {
    originalStarts.set(segment.clip.id, segment.start)
  }
  const start = Math.max(0, Number.isFinite(targetStart) ? targetStart : 0)
  const timeline = getTimeline(targetClips)
  const index = timeline.filter(
    (segment) => (segment.start + segment.end) / 2 < start - 0.0001,
  ).length
  const before = targetClips.slice(0, index)
  const previousEnd = before.length > 0 ? getProjectDuration(before) : 0
  const gap = Math.max(0, start - previousEnd)
  const inserted: Clip = { ...clip, gapBefore: gap }
  const next = [...targetClips]
  next.splice(index, 0, inserted)
  let cursor = previousEnd + gap + clipTimelineDuration(inserted)
  for (let current = index + 1; current < next.length; current += 1) {
    const desired = Math.max(cursor, originalStarts.get(next[current].id) ?? cursor)
    next[current] = {
      ...next[current],
      gapBefore: Math.max(0, desired - cursor),
    }
    cursor = desired + clipTimelineDuration(next[current])
  }
  if (targetTrackId === null) {
    return { ...project, clips: next }
  }
  return {
    ...project,
    overlayTracks: tracks.map((track) =>
      track.id === targetTrackId ? { ...track, clips: next } : track,
    ),
  }
}

/** Move a clip to an arbitrary time on the primary or an overlay track. */
export function moveClipToTrackAtTime(
  project: Project,
  clipId: string,
  targetTrackId: string | null,
  targetStart: number,
  linkFollowing = false,
  mainTrackMagnet = false,
): Project | null {
  const location = findClipLocation(project, clipId)
  if (!location) return null
  const sourceTrackId = location.track?.id ?? null
  const originalTracks = project.overlayTracks ?? []
  if (targetTrackId !== null && !originalTracks.some((track) => track.id === targetTrackId)) {
    return null
  }

  const originalStarts = new Map<string, number>()
  for (const segment of getTimeline(project.clips)) {
    originalStarts.set(segment.clip.id, segment.start)
  }
  for (const track of originalTracks) {
    for (const segment of getTimeline(track.clips)) {
      originalStarts.set(segment.clip.id, segment.start)
    }
  }
  const reflow = (list: Clip[], from = 0): Clip[] => {
    const prefixEnd = from > 0 ? getProjectDuration(list.slice(0, from)) : 0
    let cursor = prefixEnd
    return list.map((clip, index) => {
      if (index < from) return clip
      const desired = Math.max(cursor, originalStarts.get(clip.id) ?? cursor)
      const updated = { ...clip, gapBefore: Math.max(0, desired - cursor) }
      cursor = desired + clipTimelineDuration(clip)
      return updated
    })
  }

  let clips =
    sourceTrackId === null
      ? reflow(project.clips.filter((clip) => clip.id !== clipId))
      : project.clips
  let tracks =
    sourceTrackId === null
      ? [...originalTracks]
      : originalTracks.map((track) =>
          track.id === sourceTrackId
            ? { ...track, clips: reflow(track.clips.filter((clip) => clip.id !== clipId)) }
            : track,
        )

  const targetClips =
    targetTrackId === null
      ? [...clips]
      : [...(tracks.find((track) => track.id === targetTrackId)?.clips ?? [])]
  if (targetTrackId !== null && !tracks.some((track) => track.id === targetTrackId)) return null

  const start = Math.max(0, Number.isFinite(targetStart) ? targetStart : 0)
  const timeline = getTimeline(targetClips)
  const index = timeline.filter(
    (segment) => (segment.start + segment.end) / 2 < start - 0.0001,
  ).length
  const before = targetClips.slice(0, index)
  const previousEnd = before.length > 0 ? getProjectDuration(before) : 0
  const gap = Math.max(0, start - previousEnd)
  const moved: Clip = { ...location.clip, gapBefore: gap }
  const next = [...targetClips]
  next.splice(index, 0, moved)
  const movedStart = previousEnd + gap
  const movedEnd = movedStart + clipTimelineDuration(moved)
  const moveDelta = movedStart - location.segment.start
  let cursor = movedEnd
  for (let current = index + 1; current < next.length; current += 1) {
    const originalStart = originalStarts.get(next[current].id) ?? cursor
    const desired = Math.max(
      cursor,
      originalStart + (linkFollowing ? moveDelta : 0),
    )
    next[current] = {
      ...next[current],
      gapBefore: Math.max(0, desired - cursor),
    }
    cursor = desired + clipTimelineDuration(next[current])
  }

  if (targetTrackId === null) {
    clips = next
  } else {
    tracks = tracks.map((track) =>
      track.id === targetTrackId ? { ...track, clips: next } : track,
    )
  }
  if (mainTrackMagnet && (sourceTrackId === null || targetTrackId === null)) {
    clips = clips.map((clip) => ({ ...clip, gapBefore: 0 }))
  }
  return { ...project, clips, overlayTracks: tracks }
}

export function updateClipInProject(
  project: Project,
  clipId: string,
  update: Partial<Clip>,
): Project | null {
  let found = false
  const clips = project.clips.map((clip) => {
    if (clip.id !== clipId) return clip
    found = true
    return { ...clip, ...update }
  })
  const overlayTracks = (project.overlayTracks ?? []).map((track) => {
    if (!track.clips.some((clip) => clip.id === clipId)) return track
    found = true
    return {
      ...track,
      clips: track.clips.map((clip) => (clip.id === clipId ? { ...clip, ...update } : clip)),
    }
  })
  if (!found) return null
  return { ...project, clips, overlayTracks }
}

/** Duplicate a primary-track clip into a new picture-in-picture overlay lane. */
export function addOverlayTrackFromClip(
  project: Project,
  baseClipId: string,
  trackId: string,
  overlayClipId: string,
): { project: Project; track: OverlayTrack; clip: Clip } | null {
  const segment = findSegmentById(project.clips, baseClipId)
  if (!segment) return null
  const base = segment.clip
  const overlayClip: Clip = {
    ...base,
    id: overlayClipId,
    gapBefore: segment.start,
    scale: clamp(base.scale * 0.42, 0.18, 0.45),
    position: {
      x: clamp(base.position.x + 0.27, -2, 2),
      y: clamp(base.position.y - 0.27, -2, 2),
    },
  }
  const track: OverlayTrack = {
    id: trackId,
    name: `叠加轨 ${(project.overlayTracks?.length ?? 0) + 1}`,
    muted: true,
    hidden: false,
    enabled: true,
    locked: false,
    solo: false,
    clips: [overlayClip],
  }
  return {
    project: {
      ...project,
      overlayTracks: [...(project.overlayTracks ?? []), track],
    },
    track,
    clip: overlayClip,
  }
}

export function addEmptyOverlayTrack(
  project: Project,
  trackId: string,
): { project: Project; track: OverlayTrack } | null {
  const tracks = project.overlayTracks ?? []
  const track: OverlayTrack = {
    id: trackId,
    name: `叠加轨 ${tracks.length + 1}`,
    muted: true,
    hidden: false,
    enabled: true,
    locked: false,
    solo: false,
    clips: [],
  }
  return { project: { ...project, overlayTracks: [...tracks, track] }, track }
}

export function updateMainTrackInProject(
  project: Project,
  update: Partial<TrackState>,
): Project {
  return {
    ...project,
    mainTrack: { ...DEFAULT_TRACK_STATE, ...project.mainTrack, ...update },
  }
}

export function updateOverlayTrackInProject(
  project: Project,
  trackId: string,
  update: Partial<Pick<OverlayTrack, 'name' | 'muted' | 'hidden' | 'enabled' | 'locked' | 'solo'>>,
): Project | null {
  const tracks = project.overlayTracks ?? []
  if (!tracks.some((track) => track.id === trackId)) return null
  return {
    ...project,
    overlayTracks: tracks.map((track) =>
      track.id === trackId ? { ...track, ...update } : track,
    ),
  }
}

export function splitOverlayClipAt(
  project: Project,
  trackId: string,
  clipId: string,
  time: number,
  rightId: string,
): Project | null {
  const track = (project.overlayTracks ?? []).find((item) => item.id === trackId)
  if (!track) return null
  const segment = findSegmentById(track.clips, clipId)
  if (!segment) return null
  if (
    time <= segment.start + CLIP_EDGE_EPSILON ||
    time >= segment.end - CLIP_EDGE_EPSILON
  ) {
    return null
  }
  const offset = time - segment.start
  if (offset < MIN_CLIP_DURATION || segment.duration - offset < MIN_CLIP_DURATION) {
    return null
  }
  const splitSource = clipSpanSourceAt(segment.clip, offset)
  const left: Clip = { ...segment.clip, sourceEnd: splitSource }
  const right: Clip = {
    ...segment.clip,
    id: rightId,
    sourceStart: splitSource,
    sourceEnd: segment.clip.sourceEnd,
    gapBefore: 0,
  }
  if (segment.clip.type === 'freeze') {
    const frame = clipFreezeFrame(segment.clip)
    left.freezeFrameTime = frame
    right.freezeFrameTime = frame
  }
  const clips = [...track.clips]
  clips.splice(segment.index, 1, left, right)
  return {
    ...project,
    overlayTracks: (project.overlayTracks ?? []).map((item) =>
      item.id === trackId ? { ...item, clips } : item,
    ),
  }
}

export function trimOverlayClipAt(
  project: Project,
  trackId: string,
  clipId: string,
  time: number,
  edge: 'left' | 'right',
): Project | null {
  const track = (project.overlayTracks ?? []).find((item) => item.id === trackId)
  if (!track) return null
  const segment = findSegmentById(track.clips, clipId)
  if (!segment) return null
  if (
    time <= segment.start + CLIP_EDGE_EPSILON ||
    time >= segment.end - CLIP_EDGE_EPSILON
  ) {
    return null
  }
  if (edge === 'left') {
    const delta = time - segment.start
    if (segment.duration - delta < MIN_CLIP_DURATION) return null
    if (clipSpanSourceAt(segment.clip, delta) >= clipSourceSpan(segment.clip).end - MIN_CLIP_DURATION) {
      return null
    }
    const clips = track.clips.map((clip) =>
      clip.id === clipId
        ? {
            ...clip,
            sourceStart: clipSpanSourceAt(clip, delta),
            gapBefore: (clip.gapBefore ?? 0) + delta,
          }
        : clip,
    )
    return {
      ...project,
      overlayTracks: (project.overlayTracks ?? []).map((item) =>
        item.id === trackId ? { ...item, clips } : item,
      ),
    }
  }

  const delta = segment.end - time
  if (segment.duration - delta < MIN_CLIP_DURATION) return null
  const clips = track.clips.map((clip, index) => {
    if (clip.id === clipId) {
      return { ...clip, sourceEnd: clipSpanSourceAt(clip, clipTimelineDuration(clip) - delta) }
    }
    if (index === segment.index + 1) {
      return { ...clip, gapBefore: (clip.gapBefore ?? 0) + delta }
    }
    return clip
  })
  return {
    ...project,
    overlayTracks: (project.overlayTracks ?? []).map((item) =>
      item.id === trackId ? { ...item, clips } : item,
    ),
  }
}

export function resizeOverlayClipEdge(
  project: Project,
  trackId: string,
  clipId: string,
  edge: 'left' | 'right',
  delta: number,
  sourceDuration: number,
): Project | null {
  const track = (project.overlayTracks ?? []).find((item) => item.id === trackId)
  if (!track) return null
  const segment = findSegmentById(track.clips, clipId)
  if (!segment || !Number.isFinite(delta) || Math.abs(delta) < 0.0001) return null
  const clip = segment.clip
  const duration = segment.duration
  const freeze = clip.type === 'freeze'
  const minDuration = freeze ? FREEZE_MIN_DURATION : MIN_CLIP_DURATION
  const maxDuration = freeze ? FREEZE_MAX_DURATION : Number.POSITIVE_INFINITY

  if (edge === 'left') {
    const gap = Math.max(0, clip.gapBefore ?? 0)
    const maxRestore = Math.min(
      gap,
      Math.max(0, clip.sourceStart),
      Math.max(0, maxDuration - duration),
    )
    const maxTrim = Math.max(0, duration - minDuration)
    const actual = clamp(delta, -maxRestore, maxTrim)
    if (Math.abs(actual) < 0.0001) return null
    const clips = track.clips.map((item) =>
      item.id === clipId
        ? {
            ...item,
            sourceStart: clipSpanSourceAt(item, actual),
            gapBefore: gap + actual,
          }
        : item,
    )
    return {
      ...project,
      overlayTracks: (project.overlayTracks ?? []).map((item) =>
        item.id === trackId ? { ...item, clips } : item,
      ),
    }
  }

  const next = track.clips[segment.index + 1] ?? null
  const nextGap = Math.max(0, next?.gapBefore ?? 0)
  const sourceGrow = freeze
    ? Math.max(0, FREEZE_MAX_DURATION - duration)
    : clip.type === 'image'
      ? Math.max(0, IMAGE_MAX_DURATION - duration)
      : Math.max(0, sourceDuration - clipSourceSpan(clip).end)
  const maxGrow = next ? Math.min(sourceGrow, nextGap) : sourceGrow
  const maxShrink = Math.max(0, duration - minDuration)
  const actual = clamp(delta, -maxShrink, maxGrow)
  if (Math.abs(actual) < 0.0001) return null
  const clips = track.clips.map((item, index) => {
    if (item.id === clipId) {
      return { ...item, sourceEnd: clipSpanSourceAt(item, clipTimelineDuration(item) + actual) }
    }
    if (next && index === segment.index + 1) {
      return { ...item, gapBefore: Math.max(0, nextGap - actual) }
    }
    return item
  })
  return {
    ...project,
    overlayTracks: (project.overlayTracks ?? []).map((item) =>
      item.id === trackId ? { ...item, clips } : item,
    ),
  }
}

export function removeOverlayTrackFromProject(
  project: Project,
  trackId: string,
): Project | null {
  const tracks = project.overlayTracks ?? []
  if (!tracks.some((track) => track.id === trackId)) return null
  return {
    ...project,
    overlayTracks: tracks.filter((track) => track.id !== trackId),
  }
}

export function removeClipFromOverlayTrack(
  project: Project,
  trackId: string,
  clipId: string,
): Project | null {
  const tracks = project.overlayTracks ?? []
  const track = tracks.find((item) => item.id === trackId)
  if (!track || !track.clips.some((clip) => clip.id === clipId)) return null
  return {
    ...project,
    overlayTracks: tracks.map((item) =>
      item.id === trackId
        ? { ...item, clips: item.clips.filter((clip) => clip.id !== clipId) }
        : item,
    ),
  }
}

export function reorderOverlayClipInProject(
  project: Project,
  trackId: string,
  clipId: string,
  targetIndex: number,
): Project | null {
  const tracks = project.overlayTracks ?? []
  const track = tracks.find((item) => item.id === trackId)
  if (!track) return null
  const sourceIndex = track.clips.findIndex((clip) => clip.id === clipId)
  if (sourceIndex < 0) return null
  const clips = [...track.clips]
  const [clip] = clips.splice(sourceIndex, 1)
  const index = clamp(Math.round(targetIndex), 0, clips.length)
  clips.splice(index, 0, clip)
  if (clips.every((item, current) => item.id === track.clips[current]?.id)) return null
  return {
    ...project,
    overlayTracks: tracks.map((item) => (item.id === trackId ? { ...item, clips } : item)),
  }
}

export function moveOverlayClipToTrack(
  project: Project,
  sourceTrackId: string,
  clipId: string,
  targetTrackId: string,
  targetIndex: number,
  targetStart: number,
): Project | null {
  if (sourceTrackId === targetTrackId) return null
  const tracks = project.overlayTracks ?? []
  const sourceTrack = tracks.find((track) => track.id === sourceTrackId)
  const targetTrack = tracks.find((track) => track.id === targetTrackId)
  if (!sourceTrack || !targetTrack) return null
  const sourceClip = sourceTrack.clips.find((clip) => clip.id === clipId)
  if (!sourceClip) return null
  const duration = clipTimelineDuration(sourceClip)
  if (duration <= 0) return null

  const index = clamp(Math.round(targetIndex), 0, targetTrack.clips.length)
  const before = targetTrack.clips.slice(0, index)
  const previousEnd = before.length > 0 ? getProjectDuration(before) : 0
  const gap = Math.max(0, targetStart - previousEnd)
  const moved: Clip = { ...sourceClip, gapBefore: gap }
  const targetClips = [...targetTrack.clips]
  targetClips.splice(index, 0, moved)
  const movedStart = previousEnd + gap
  const movedEnd = movedStart + duration
  let cursor = movedEnd
  for (let current = index + 1; current < targetClips.length; current += 1) {
    const timeline = getTimeline(targetClips)
    const segment = timeline[current]
    if (!segment) break
    if (segment.start < cursor) {
      targetClips[current] = {
        ...targetClips[current],
        gapBefore: Math.max(0, targetClips[current].gapBefore ?? 0) + (cursor - segment.start),
      }
      cursor = cursor + segment.duration
    } else {
      cursor = segment.end
    }
  }

  return {
    ...project,
    overlayTracks: tracks.map((track) => {
      if (track.id === sourceTrackId) {
        return { ...track, clips: track.clips.filter((clip) => clip.id !== clipId) }
      }
      if (track.id === targetTrackId) {
        return { ...track, clips: targetClips }
      }
      return track
    }),
  }
}

export function addMarkerToProject(
  project: Project,
  marker: Marker,
): Project {
  return {
    ...project,
    markers: [...project.markers, { ...marker }].sort((a, b) => a.time - b.time),
  }
}

export function updateMarkerInProject(project: Project, marker: Marker): Project | null {
  if (!project.markers.some((item) => item.id === marker.id)) return null
  return {
    ...project,
    markers: project.markers
      .map((item) => (item.id === marker.id ? { ...marker } : item))
      .sort((a, b) => a.time - b.time),
  }
}

export function deleteMarkerFromProject(project: Project, markerId: string): Project {
  return { ...project, markers: project.markers.filter((marker) => marker.id !== markerId) }
}

export function setAspectRatioInProject(project: Project, aspectRatio: AspectRatioPreset): Project {
  return { ...project, aspectRatio }
}

export function setExportQualityInProject(project: Project, quality: ExportQuality): Project {
  return { ...project, exportQuality: { ...quality } }
}

/**
 * 移动一条叠加轨的层级。
 *
 * `overlayTracks` 数组是 **bottom-to-top**（见 types.ts 的 Project 注释）：
 * index 0 是最底层，index = length-1 是最上层。因此：
 *   direction === 'up'   → 数组里 index + 1（更高一层）
 *   direction === 'down' → 数组里 index - 1（更低一层）
 * 已在最上层/最下层（或轨道不存在）时返回原 project，因此不产生撤销历史。
 * 主轨不参与重排。
 */
export function moveOverlayTrackInProject(
  project: Project,
  trackId: string,
  direction: 'up' | 'down',
): Project {
  const tracks = project.overlayTracks ?? []
  const index = tracks.findIndex((track) => track.id === trackId)
  if (index < 0) return project
  const targetIndex = direction === 'up' ? index + 1 : index - 1
  if (targetIndex < 0 || targetIndex >= tracks.length) return project
  const next = [...tracks]
  const [moved] = next.splice(index, 1)
  next.splice(targetIndex, 0, moved)
  return { ...project, overlayTracks: next }
}

/** 素材删除时需要一并删掉的片段（主轨 + 叠加轨 + 音频轨 + 字幕 link）。 */
export interface RemoveAssetClipsOptions {
  /** 素材的 url（片段通过 clip.sourceUrl 引用它）。 */
  url: string
  /** 素材 id（字幕片段的 link.assetId 引用它）。 */
  assetId: string
}

/**
 * 删除所有引用某个素材的片段（一次调用 = 1 步撤销）。
 * 没有任何片段引用时返回原 project（不产生历史）。
 */
export function removeClipsForAsset(
  project: Project,
  options: RemoveAssetClipsOptions,
): Project {
  const { url, assetId } = options
  let removed = 0
  const keepClip = (clip: Clip): boolean => {
    if (clip.sourceUrl === url) {
      removed += 1
      return false
    }
    return true
  }
  const keepLinkedText = (clip: TextClip): boolean => {
    if (clip.link?.assetId === assetId || clip.link?.sourceUrl === url) {
      removed += 1
      return false
    }
    return true
  }
  const overlayTracks = (project.overlayTracks ?? []).map((track) => ({
    ...track,
    clips: track.clips.filter(keepClip),
  }))
  const audioTracks = (project.audioTracks ?? []).map((track) => ({
    ...track,
    clips: track.clips.filter((clip) => {
      if (clip.sourceUrl === url) {
        removed += 1
        return false
      }
      return true
    }),
  }))
  const textTracks = (project.textTracks ?? []).map((track) => ({
    ...track,
    clips: track.clips.filter(keepLinkedText),
  }))
  // 主轨必须在这里过滤：上面的 removed 计数只覆盖了叠加/音频/字幕轨。
  const clips = project.clips.filter(keepClip)
  if (removed === 0) return project
  return {
    ...project,
    clips,
    ...(project.overlayTracks ? { overlayTracks } : {}),
    ...(project.audioTracks ? { audioTracks } : {}),
    ...(project.textTracks ? { textTracks } : {}),
  }
}

/** 属性粘贴的结果：project 变化 + 实际写入 / 被跳过的片段数。 */
export interface AttributePatchResult {
  project: Project
  applied: number
  /** 目标片段不存在或位于锁定轨道，被跳过。 */
  skipped: number
}

/**
 * 把一组属性 patch 写到若干片段上（主轨 + 叠加轨均可）。
 *
 * - 只覆盖 patch 里出现的字段，未包含的字段保持原值（靠 `{ ...clip, ...patch }`）。
 * - 多个目标片段在同一次调用内完成，因此是 1 个命令 = 1 步撤销。
 * - 目标片段不存在 / 位于锁定轨道时逐个跳过；全部被跳过（或 patch 为空）时
 *   返回原 project（引用不变，因此不产生撤销历史）。
 */
export function applyAttributePatch(
  project: Project,
  ids: readonly string[],
  patch: Partial<Clip>,
): AttributePatchResult {
  if (ids.length === 0 || Object.keys(patch).length === 0) {
    return { project, applied: 0, skipped: 0 }
  }
  let next = project
  let applied = 0
  let skipped = 0
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    const location = findClipLocation(project, id)
    if (!location) {
      skipped += 1
      continue
    }
    if (location.track ? isOverlayLocked(location.track) : isMainLocked(project)) {
      skipped += 1
      continue
    }
    const updated = updateClipInProject(next, id, patch)
    if (!updated) {
      skipped += 1
      continue
    }
    next = updated
    applied += 1
  }
  return { project: applied > 0 ? next : project, applied, skipped }
}

/** 「应用到全部片段」的调色：主轨 + 叠加轨的所有画面片段。 */
export interface ApplyColorAllResult {
  project: Project
  applied: number
}

/**
 * 把同一组调色参数写到所有画面片段（主轨 + 叠加轨，图片/定格同样适用）。
 * 已经相同的片段保持引用不变；全都没有变化时返回原 project（不产生历史）。
 */
export function applyColorToAllClips(
  project: Project,
  color: ColorAdjustments,
): ApplyColorAllResult {
  const normalized = normalizeColor(color)
  let applied = 0
  let changed = false

  const applyClip = (clip: Clip): Clip => {
    const current = normalizeColor(clip.color)
    if (isSameColor(current, normalized)) return clip
    applied += 1
    changed = true
    return { ...clip, color: normalized }
  }

  const clips = project.clips.map(applyClip)
  const overlayTracks = (project.overlayTracks ?? []).map((track) => {
    const clipsNext = track.clips.map(applyClip)
    return clipsNext.every((clip, index) => clip === track.clips[index])
      ? track
      : { ...track, clips: clipsNext }
  })

  if (!changed) return { project, applied: 0 }
  return {
    project: {
      ...project,
      clips,
      ...(project.overlayTracks ? { overlayTracks } : {}),
    },
    applied,
  }
}

export function getContentAspectRatio(
  aspect: AspectRatioPreset,
  source: Pick<SourceInfo, 'width' | 'height'>,
): number {
  return aspectValue(aspect, source)
}

/** 「应用到所有交界」的入参。 */
export interface TransitionAllOptions {
  type: TransitionType
  duration: number
}

export interface TransitionAllResult {
  project: Project
  /** 成功写入转场的交界数。 */
  applied: number
  /** 被跳过的交界数（空隙 / 定型片段 / 两侧太短 / 末段没有下一段）。 */
  skipped: number
}

/**
 * 把同一种转场写入主轨所有可生效的交界（相邻两段之间）。
 *
 * 规则与单处设置(`setTransition`)保持一致：只作用于主轨、跳过有间隙的交界、
 * 跳过任一侧是定格的交界、每处时长按各自相邻片段重新夹取（上限 2s 且不超过较短片段一半）。
 * 单次遍历；没有任何交界可以应用时返回原 project，从而不产生撤销历史。
 */
export function applyTransitionToAllJunctions(
  project: Project,
  options: TransitionAllOptions,
): TransitionAllResult {
  const type = normalizeTransitionType(options.type)
  const wanted = clampTransitionDuration(options.duration)
  const clips = project.clips
  if (clips.length < 2) return { project, applied: 0, skipped: 0 }

  let applied = 0
  let skipped = 0
  let changed = false

  const nextClips = clips.map((clip, index) => {
    const next = clips[index + 1]
    if (!next) return clip // 末段没有交界，既不计入 applied 也不计入 skipped

    const gap = Math.max(0, next.gapBefore ?? 0)
    const limit = maxTransitionDuration(clip, next)
    const unusable =
      gap > TRANSITION_EPSILON ||
      clip.type === 'freeze' ||
      next.type === 'freeze' ||
      limit < TRANSITION_MIN_DURATION

    if (unusable) {
      skipped += 1
      return clip
    }

    const duration = Math.min(wanted, limit)
    applied += 1
    const existing = clipTransitionOut(clip)
    if (
      existing &&
      existing.type === type &&
      Math.abs(existing.duration - duration) < 1e-6
    ) {
      return clip
    }
    changed = true
    return { ...clip, transitionOut: { type, duration } }
  })

  return {
    project: changed ? { ...project, clips: nextClips } : project,
    applied,
    skipped,
  }
}