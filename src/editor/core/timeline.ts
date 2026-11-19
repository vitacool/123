import { CLIP_EDGE_EPSILON } from './constants'
import { audioProjectEnd } from './audio'
import { clipTimelineDuration } from './clipTime'
import { resolveTransitionDuration } from './transition'
import { textProjectEnd } from './text'
import { isMainLocked, isOverlayLocked } from './tracks'
import type {
  ActionAvailability,
  Clip,
  Marker,
  OverlayTrack,
  Project,
  TimelineSegment,
} from './types'

export interface ClipLocation {
  clip: Clip
  segment: TimelineSegment
  /** null means the primary track; otherwise an overlay track. */
  track: OverlayTrack | null
  trackIndex: number
}

export function getOverlayTracks(project: Project): OverlayTrack[] {
  return project.overlayTracks ?? []
}

export function getProjectEnd(project: Project): number {
  let end = getProjectDuration(project.clips)
  for (const track of getOverlayTracks(project)) {
    end = Math.max(end, getProjectDuration(track.clips))
  }
  return Math.max(end, audioProjectEnd(project), textProjectEnd(project))
}

export function findClipLocation(project: Project, id: string | null): ClipLocation | null {
  if (!id) return null
  const base = findSegmentById(project.clips, id)
  if (base) return { clip: base.clip, segment: base, track: null, trackIndex: -1 }
  const tracks = getOverlayTracks(project)
  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index]
    const segment = findSegmentById(track.clips, id)
    if (segment) return { clip: segment.clip, segment, track, trackIndex: index }
  }
  return null
}

export function getTimeline(clips: Clip[]): TimelineSegment[] {
  let cursor = 0
  return clips.map((clip, index) => {
    const gapBefore = Math.max(0, clip.gapBefore ?? 0)
    // 与上一片段之间有转场时，本片段起点前移（两段重叠），总时长随之缩短。
    const previous = index > 0 ? clips[index - 1] : null
    const overlap = previous ? resolveTransitionDuration(previous, clip, gapBefore) : 0
    const start = Math.max(0, cursor + gapBefore - overlap)
    const duration = Math.max(0, clipTimelineDuration(clip))
    const end = start + duration
    cursor = end
    return { clip, index, start, end, duration }
  })
}

export function getProjectDuration(clips: Clip[]): number {
  const timeline = getTimeline(clips)
  return timeline.length > 0 ? timeline[timeline.length - 1].end : 0
}

export function getTimelineTotal(project: Project): number {
  return getProjectEnd(project)
}

/** Returns the segment containing the time. Exact boundaries belong to the next clip. */
export function findSegmentAt(clips: Clip[], time: number): TimelineSegment | null {
  const total = getProjectDuration(clips)
  if (clips.length === 0 || time < -CLIP_EDGE_EPSILON || time > total + CLIP_EDGE_EPSILON) {
    return null
  }
  if (time >= total - CLIP_EDGE_EPSILON) {
    return getTimeline(clips)[clips.length - 1] ?? null
  }
  return (
    getTimeline(clips).find(
      (segment) =>
        time >= segment.start - CLIP_EDGE_EPSILON && time < segment.end - CLIP_EDGE_EPSILON,
    ) ?? null
  )
}

export function findSegmentById(clips: Clip[], id: string | null): TimelineSegment | null {
  if (!id) return null
  return getTimeline(clips).find((segment) => segment.clip.id === id) ?? null
}

/**
 * 返回某时刻所有覆盖它的片段（转场重叠区会同时命中两段）。
 * 顺序按时间轴先后，最后一个元素是“正在进入”的片段。
 */
export function segmentsAt(clips: Clip[], time: number): TimelineSegment[] {
  return getTimeline(clips).filter(
    (segment) =>
      time >= segment.start - CLIP_EDGE_EPSILON && time < segment.end - CLIP_EDGE_EPSILON,
  )
}

export function getActionAvailability(
  project: Project,
  selectedClipId: string | null,
  playhead: number,
): ActionAvailability {
  const location = findClipLocation(project, selectedClipId)
  const segment = location?.segment ?? null
  const locked = location
    ? location.track
      ? isOverlayLocked(location.track)
      : isMainLocked(project)
    : false
  const total = getProjectEnd(project)
  const baseClip = location === null || location.track === null
  const inInterior =
    segment !== null &&
    playhead > segment.start + CLIP_EDGE_EPSILON &&
    playhead < segment.end - CLIP_EDGE_EPSILON

  return {
    canSplit: inInterior && !locked,
    canTrimLeft: inInterior && !locked,
    canTrimRight: inInterior && !locked,
    canFreeze:
      baseClip &&
      total > CLIP_EDGE_EPSILON &&
      playhead >= -CLIP_EDGE_EPSILON &&
      playhead <= total + CLIP_EDGE_EPSILON &&
      !locked,
    hasSelection: location !== null && !locked,
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Snap a playhead time to the closest marker when it is within `threshold` seconds. */
export function snapToMarker(time: number, markers: Marker[], threshold: number): number {
  if (markers.length === 0 || threshold <= 0) return time
  let best = time
  let bestDistance = threshold
  for (const marker of markers) {
    const distance = Math.abs(marker.time - time)
    if (distance <= bestDistance) {
      bestDistance = distance
      best = marker.time
    }
  }
  return best
}

export function getClipLocalTime(segment: TimelineSegment, projectTime: number): number {
  return clamp(projectTime - segment.start, 0, segment.duration)
}