import { clipTimelineDuration } from './clipTime'
import { getTimeline } from './timeline'
import type { Project } from './types'

/** 时间轴左/右留白（与 Timeline 组件的 PAD 保持一致）。 */
export const TIMELINE_PAD = 12
/** 时间轴内容末尾额外预留的空白像素（与 Timeline 组件一致）。 */
export const TIMELINE_TAIL = 36

const EPSILON = 1e-6

export type EditPointDirection = 'prev' | 'next'

export interface EditPointOptions {
  /** 是否把标记也算作剪辑点，默认 true。 */
  includeMarkers?: boolean
  /** 是否包含 0 与工程结尾，默认 true。 */
  includeBounds?: boolean
}

function pushUnique(target: number[], value: number, total: number): void {
  if (!Number.isFinite(value)) return
  const clamped = Math.max(0, Math.min(total, value))
  if (!target.some((item) => Math.abs(item - clamped) < EPSILON)) target.push(clamped)
}

/**
 * 收集所有剪辑点（秒）：主轨 / 叠加轨 / 音频轨的片段边界，文本轨的字幕起止，
 * 以及标记时间；默认同时包含 0 与工程结尾。结果升序且去重。
 */
export function collectEditPoints(project: Project, options: EditPointOptions = {}): number[] {
  const includeMarkers = options.includeMarkers ?? true
  const includeBounds = options.includeBounds ?? true

  let total = 0
  const boundaries: number[] = []

  for (const segment of getTimeline(project.clips)) {
    boundaries.push(segment.start, segment.end)
    total = Math.max(total, segment.end)
  }
  for (const track of project.overlayTracks ?? []) {
    for (const segment of getTimeline(track.clips)) {
      boundaries.push(segment.start, segment.end)
      total = Math.max(total, segment.end)
    }
  }
  for (const track of project.audioTracks ?? []) {
    for (const clip of track.clips) {
      boundaries.push(clip.start, clip.start + clipTimelineDuration(clip))
      total = Math.max(total, clip.start + clipTimelineDuration(clip))
    }
  }
  for (const track of project.textTracks ?? []) {
    for (const clip of track.clips) {
      boundaries.push(clip.start, clip.end)
      total = Math.max(total, clip.end)
    }
  }
  if (includeMarkers) {
    for (const marker of project.markers) {
      boundaries.push(marker.time)
      total = Math.max(total, marker.time)
    }
  }

  const points: number[] = []
  if (includeBounds) pushUnique(points, 0, total)
  for (const value of boundaries) pushUnique(points, value, total)
  if (includeBounds) pushUnique(points, total, total)
  return points.sort((left, right) => left - right)
}

/** 上/下一个剪辑点；已到端点时返回 null（避免原地弹回）。 */
export function nextEditPoint(
  points: readonly number[],
  time: number,
  direction: EditPointDirection,
): number | null {
  if (points.length === 0) return null
  if (direction === 'prev') {
    let best: number | null = null
    for (const point of points) {
      if (point < time - EPSILON && (best === null || point > best)) best = point
    }
    return best
  }
  let best: number | null = null
  for (const point of points) {
    if (point > time + EPSILON && (best === null || point < best)) best = point
  }
  return best
}

/** 逐帧步进（按项目 fps），结果夹在 [0, total]。 */
export function stepByFrames(time: number, frames: number, fps: number, total: number): number {
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 30
  const next = time + frames / rate
  return Math.max(0, Math.min(Math.max(0, total), next))
}

/** 按秒步进，结果夹在 [0, total]。 */
export function stepBySeconds(time: number, seconds: number, total: number): number {
  const next = time + seconds
  return Math.max(0, Math.min(Math.max(0, total), next))
}

/**
 * 时间轴「适应窗口」的缩放值（px/秒）：让 total 秒的内容恰好铺满可视宽度，
 * 结果夹在 [minZoom, maxZoom]。total 为 0 时返回 maxZoom（最紧凑的无内容视图）。
 */
export function fitZoom(
  total: number,
  viewportWidth: number,
  minZoom: number,
  maxZoom: number,
  pad: number = TIMELINE_PAD,
  tail: number = TIMELINE_TAIL,
): number {
  const usable = Math.max(1, viewportWidth - pad * 2 - tail)
  if (!Number.isFinite(total) || total <= EPSILON) return maxZoom
  const zoom = usable / total
  return Math.max(minZoom, Math.min(maxZoom, zoom))
}