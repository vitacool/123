import { clipLocalAt, clipTimelineDuration, type TimeMappable } from './clipTime'
import { getOverlayTracks, getTimeline } from './timeline'
import { isAudioTrackActive, isMainAudioActive } from './tracks'
import type { AsrWord } from './asr'
import type { Project } from './types'

export type WordTrackKind = 'main' | 'overlay' | 'audio'

/** A timeline-positioned word, tagged with the source asset and clip it came from. */
export interface TimelineWord extends AsrWord {
  source: {
    sourceUrl: string
    clipId: string
    trackKind: WordTrackKind
  }
  /** This word's position in source time (used to build caption links). */
  sourceStart?: number
  sourceEnd?: number
}

/** Source asset id (or sourceUrl as a legacy fallback) → word list in source time. */
export type WordsBySource = Record<string, AsrWord[]>

export interface MapWordsOptions {
  includeMainAudio?: boolean
  includeOverlay?: boolean
  includeAudio?: boolean
}

function pushMapped(
  result: TimelineWord[],
  words: AsrWord[] | undefined,
  clip: TimeMappable,
  timelineStart: number,
  timelineEnd: number,
  sourceUrl: string,
  clipId: string,
  trackKind: WordTrackKind,
): void {
  if (!words || words.length === 0) return
  const { sourceStart, sourceEnd } = clip
  for (const word of words) {
    // 半开区间：中点落在 [sourceStart, sourceEnd) 内才保留。
    const center = (word.start + word.end) / 2
    if (center < sourceStart || center >= sourceEnd) continue
    // 源时间 → 时间轴局部时间统一走 clipTime（已按 speed 换算），再夹在该片段范围内。
    const start = Math.max(timelineStart, timelineStart + clipLocalAt(clip, word.start))
    const end = Math.min(timelineEnd, timelineStart + clipLocalAt(clip, word.end))
    if (end <= start) continue
    result.push({
      ...word,
      start,
      end,
      sourceStart: word.start,
      sourceEnd: word.end,
      source: { sourceUrl, clipId, trackKind },
    })
  }
}

/**
 * Maps cached, source-timed `AsrWord[]` onto timeline positions. Filtering
 * mirrors the recognition stage (main-track audio active, overlay, audio tracks
 * active). `WordsBySource` may be keyed by stable asset id; pass `urlToAssetId`
 * to resolve clip sourceUrl → asset id.
 */
export function mapWordsToTimeline(
  project: Project,
  wordsBySource: WordsBySource,
  options: MapWordsOptions = {},
  urlToAssetId?: Map<string, string>,
): TimelineWord[] {
  const includeMain = options.includeMainAudio ?? true
  const includeOverlay = options.includeOverlay ?? false
  const includeAudio = options.includeAudio ?? true
  const keyFor = (sourceUrl: string): string =>
    urlToAssetId?.get(sourceUrl) ?? sourceUrl

  const result: TimelineWord[] = []

  if (includeMain && isMainAudioActive(project)) {
    for (const segment of getTimeline(project.clips)) {
      const clip = segment.clip
      if (clip.type === 'freeze') continue
      pushMapped(
        result,
        wordsBySource[keyFor(clip.sourceUrl)],
        clip,
        segment.start,
        segment.end,
        clip.sourceUrl,
        clip.id,
        'main',
      )
    }
  }

  if (includeOverlay) {
    for (const track of getOverlayTracks(project)) {
      for (const segment of getTimeline(track.clips)) {
        const clip = segment.clip
        if (clip.type === 'freeze') continue
        pushMapped(
          result,
          wordsBySource[keyFor(clip.sourceUrl)],
          clip,
          segment.start,
          segment.end,
          clip.sourceUrl,
          clip.id,
          'overlay',
        )
      }
    }
  }

  if (includeAudio) {
    for (const track of project.audioTracks ?? []) {
      if (!isAudioTrackActive(project, track)) continue
      for (const clip of track.clips) {
        pushMapped(
          result,
          wordsBySource[keyFor(clip.sourceUrl)],
          clip,
          clip.start,
          clip.start + clipTimelineDuration(clip),
          clip.sourceUrl,
          clip.id,
          'audio',
        )
      }
    }
  }

  return result.sort((left, right) => left.start - right.start || left.end - right.end)
}