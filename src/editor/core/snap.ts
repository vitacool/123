import { clipTimelineDuration } from './clipTime'
import { getTimeline } from './timeline'
import type { Project } from './types'

export interface SnapPoint {
  time: number
  label: string
}

export interface SnapResult extends SnapPoint {
  distance: number
}

/** 在阈值内找最近吸附点；同距离时保持先出现的点（稳定）。 */
export function snapTime(
  value: number,
  points: readonly SnapPoint[],
  threshold: number,
): SnapResult | null {
  if (!Number.isFinite(value) || threshold <= 0) return null
  let best: SnapResult | null = null
  for (const point of points) {
    if (!Number.isFinite(point.time)) continue
    const distance = Math.abs(point.time - value)
    if (distance > threshold) continue
    if (!best || distance < best.distance) {
      best = { time: point.time, label: point.label, distance }
    }
  }
  return best
}

/**
 * 吸附点集合：时间轴 0、播放头、标记，以及主轨/叠加/音频/字幕片段的边缘。
 * 音频片段拖动复用这套点，避免「视频能吸、音频不能」的两套手感。
 */
export function collectSnapPoints(project: Project, playhead: number): SnapPoint[] {
  const points: SnapPoint[] = [{ time: 0, label: '起点' }]
  if (Number.isFinite(playhead)) {
    points.push({ time: Math.max(0, playhead), label: '播放头' })
  }
  for (const marker of project.markers ?? []) {
    points.push({ time: marker.time, label: '标记' })
  }
  const pushEdges = (start: number, end: number, label: string): void => {
    points.push({ time: start, label })
    points.push({ time: end, label })
  }
  for (const segment of getTimeline(project.clips)) {
    pushEdges(segment.start, segment.end, '片段边缘')
  }
  for (const track of project.overlayTracks ?? []) {
    for (const segment of getTimeline(track.clips)) {
      pushEdges(segment.start, segment.end, '片段边缘')
    }
  }
  for (const track of project.audioTracks ?? []) {
    for (const clip of track.clips) {
      pushEdges(clip.start, clip.start + clipTimelineDuration(clip), '音频边缘')
    }
  }
  for (const track of project.textTracks ?? []) {
    for (const clip of track.clips) {
      pushEdges(clip.start, clip.end, '字幕边缘')
    }
  }
  return points.filter((point) => Number.isFinite(point.time) && point.time >= 0)
}