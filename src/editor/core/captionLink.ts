import { clipLocalAt, type TimeMappable } from './clipTime'
import { getTimeline } from './timeline'
import type { Project, TextClip } from './types'

interface Span {
  clipId: string
  /** Stable asset id when resolvable, otherwise the sourceUrl (test/legacy). */
  assetKey: string
  sourceStart: number
  sourceEnd: number
  /** 片段在时间轴上的起点 */
  timelineStart: number
  clip: TimeMappable
}

function collectSpans(project: Project, urlToAssetId?: Map<string, string>): Span[] {
  const spans: Span[] = []
  const push = (
    clipId: string,
    clip: TimeMappable,
    sourceUrl: string,
    timelineStart: number,
  ): void => {
    spans.push({
      clipId,
      assetKey: urlToAssetId?.get(sourceUrl) ?? sourceUrl,
      sourceStart: clip.sourceStart,
      sourceEnd: clip.sourceEnd,
      timelineStart,
      clip,
    })
  }
  for (const segment of getTimeline(project.clips)) {
    if (segment.clip.type === 'freeze') continue
    push(segment.clip.id, segment.clip, segment.clip.sourceUrl, segment.start)
  }
  for (const track of project.overlayTracks ?? []) {
    for (const segment of getTimeline(track.clips)) {
      if (segment.clip.type === 'freeze') continue
      push(segment.clip.id, segment.clip, segment.clip.sourceUrl, segment.start)
    }
  }
  for (const track of project.audioTracks ?? []) {
    for (const clip of track.clips) {
      push(clip.id, clip, clip.sourceUrl, clip.start)
    }
  }
  return spans
}

function linkKey(link: NonNullable<TextClip['link']>): string {
  return link.assetId ?? link.sourceUrl ?? ''
}

function contains(span: Span, sourceStart: number): boolean {
  return sourceStart >= span.sourceStart && sourceStart < span.sourceEnd
}

function relinkClip(
  clip: TextClip,
  spans: Span[],
): TextClip | null {
  const link = clip.link
  if (!link) return clip
  const key = linkKey(link)

  // 1. 归属判断：先按 clipId；找不到再按“源区间包含 sourceStart”。
  let owner = spans.find((span) => span.clipId === link.clipId && span.assetKey === key)
  if (owner && contains(owner, link.sourceStart)) {
    // clipId 命中且仍包含 sourceStart。
  } else {
    owner = spans.find((span) => span.assetKey === key && contains(span, link.sourceStart))
    if (!owner) {
      owner = spans.find((span) => span.assetKey === key && span.clipId === link.clipId)
    }
  }
  if (!owner) {
    // 兼容：来源片段被删除（无任何同 asset 片段），删除该字幕。
    return null
  }

  const mode = { sourceStart: link.sourceStart, sourceEnd: link.sourceEnd }

  // 只按“原始区间 ∩ 当前片段区间”计算显示时间，不永久收窄 link。
  const interStart = Math.max(mode.sourceStart, owner.sourceStart)
  const interEnd = Math.min(mode.sourceEnd, owner.sourceEnd)
  const hidden = interEnd <= interStart

  const start = owner.timelineStart + clipLocalAt(owner.clip, hidden ? mode.sourceStart : interStart) + link.padStart
  const end =
    owner.timelineStart +
    clipLocalAt(owner.clip, hidden ? Math.max(mode.sourceEnd, interStart) : interEnd) +
    link.padEnd

  const nextLink = {
    ...link,
    clipId: owner.clipId,
    linkHidden: hidden,
  }
  if (
    nextLink.clipId === link.clipId &&
    nextLink.linkHidden === link.linkHidden &&
    Math.abs(start - clip.start) < 0.0001 &&
    Math.abs(end - clip.end) < 0.0001
  ) {
    return clip
  }
  return { ...clip, start, end, link: nextLink }
}

/**
 * Recomputes linked captions from the current clip layout. Stable `assetId` is
 * used for matching (survives blob-URL remaps); moved clips translate, trims
 * clip/ hide (linkHidden) captions without narrowing the link, splits reassign
 * by sourceStart, deleted clips remove their captions. Captions the user moved
 * manually already cleared `link`.
 */
export function relinkCaptions(
  project: Project,
  urlToAssetId?: Map<string, string>,
): Project {
  const textTracks = project.textTracks ?? []
  let changed = false
  const spansCache = (() => {
    let cached: Span[] | null = null
    return (): Span[] => (cached ??= collectSpans(project, urlToAssetId))
  })()
  const nextTracks = textTracks.map((track) => {
    if (track.kind !== 'caption') return track
    const tracks: TextClip[] = []
    let trackChanged = false
    for (const clip of track.clips) {
      if (!clip.link) {
        tracks.push(clip)
        continue
      }
      const relinked = relinkClip(clip, spansCache())
      if (relinked === null) {
        trackChanged = true
      } else {
        tracks.push(relinked)
        if (relinked !== clip) trackChanged = true
      }
    }
    if (trackChanged) {
      changed = true
      return { ...track, clips: tracks.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id)) }
    }
    return track
  })
  if (!changed) return project
  return { ...project, textTracks: nextTracks }
}

/**
 * 重新识别/重新对齐时，把旧字幕（用户可能手改过文字）与新建字幕匹配：
 * 按 link.clipId + 源区间重叠度匹配；匹配到的手改字幕保留旧文字（只更新时间/位置），
 * 其余采用新字幕。
 */
export function mergeRelinkedCaptions(
  oldClips: readonly TextClip[],
  newClips: readonly TextClip[],
): TextClip[] {
  return newClips.map((newClip) => {
    if (!newClip.link) return newClip
    let best: TextClip | null = null
    let bestOverlap = 0
    for (const old of oldClips) {
      if (!old.edited || !old.link) continue
      if (old.link.clipId !== newClip.link.clipId) continue
      const overlap =
        Math.min(old.link.sourceEnd, newClip.link.sourceEnd) -
        Math.max(old.link.sourceStart, newClip.link.sourceStart)
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        best = old
      }
    }
    if (!best) return newClip
    return {
      ...newClip,
      text: best.text,
      edited: true,
      styleOverride: best.styleOverride,
      words: undefined,
    }
  })
}