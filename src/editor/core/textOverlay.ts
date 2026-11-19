import { isTextTrackVisible } from './tracks'
import type { Project, TextClip } from './types'

/** A continuous span of the timeline with a constant set of visible clips. */
export interface TextOverlayInterval {
  /** Start of the interval in seconds. */
  start: number
  /** End of the interval in seconds (exclusive). */
  end: number
  /** Clips visible throughout [start, end), in draw order (later is on top). */
  clips: TextClip[]
}

export interface BuildTextOverlayTimelineOptions {
  /**
   * Timeline length in seconds. Intervals cover [0, duration]; text past this
   * bound is ignored and gaps are filled with empty intervals.
   */
  duration?: number
}

const EPSILON = 0.0001

function sameClipSet(left: TextClip[], right: TextClip[]): boolean {
  if (left.length !== right.length) return false
  return left.every((clip, index) => clip.id === right[index].id)
}

/**
 * Merges every visible text track into a minimal list of time intervals. Each
 * interval holds exactly the clips visible during that span, in draw order
 * (track order, then clip order), so overlapping text is drawn together on one
 * canvas. Empty spans (no text) become intervals with an empty `clips` list.
 */
export function buildTextOverlayTimeline(
  project: Project,
  options: BuildTextOverlayTimelineOptions = {},
): TextOverlayInterval[] {
  const entries: { start: number; end: number; clip: TextClip }[] = []
  for (const track of project.textTracks ?? []) {
    if (!isTextTrackVisible(track)) continue
    for (const clip of track.clips) {
      if (clip.end <= clip.start) continue
      entries.push({
        start: Math.max(0, clip.start),
        end: Math.max(0, clip.end),
        clip,
      })
    }
  }
  if (entries.length === 0) return []

  const lastEnd = entries.reduce((max, entry) => Math.max(max, entry.end), 0)
  const total = Math.max(0, options.duration ?? lastEnd)

  const boundaries = new Set<number>([0, total])
  for (const entry of entries) {
    boundaries.add(Math.min(entry.start, total))
    boundaries.add(Math.min(entry.end, total))
  }
  const sorted = [...boundaries]
    .filter((value) => value >= 0 && value <= total)
    .sort((left, right) => left - right)

  const raw: TextOverlayInterval[] = []
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const start = sorted[index]
    const end = sorted[index + 1]
    if (end - start <= EPSILON) continue
    const sample = (start + end) / 2
    const clips = entries
      .filter((entry) => entry.start <= sample && sample < entry.end)
      .map((entry) => entry.clip)
    raw.push({ start, end, clips })
  }

  if (raw.every((interval) => interval.clips.length === 0)) return []

  const merged: TextOverlayInterval[] = []
  for (const interval of raw) {
    const previous = merged[merged.length - 1]
    if (
      previous &&
      previous.end >= interval.start - EPSILON &&
      sameClipSet(previous.clips, interval.clips)
    ) {
      previous.end = interval.end
    } else {
      merged.push({ start: interval.start, end: interval.end, clips: [...interval.clips] })
    }
  }
  return merged
}