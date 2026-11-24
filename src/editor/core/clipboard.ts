import { clipTimelineDuration } from './clipTime'
import { getOverlayTracks, getTimeline } from './timeline'
import type { AudioClip, Clip, Project, TextClip } from './types'

/** 可复制的片段种类。 */
export type ClipKind = 'main' | 'overlay' | 'audio' | 'text'

export interface ClipboardVideoItem {
  kind: 'main' | 'overlay'
  /** 原轨道 id（主轨为 null）。 */
  trackId: string | null
  /** 相对粘贴锚点的时间偏移（秒）。 */
  offset: number
  clip: Clip
}

export interface ClipboardAudioItem {
  kind: 'audio'
  trackId: string
  offset: number
  clip: AudioClip
}

export interface ClipboardTextItem {
  kind: 'text'
  trackId: string
  offset: number
  clip: TextClip
}

export type ClipboardItem = ClipboardVideoItem | ClipboardAudioItem | ClipboardTextItem

export interface ClipboardPayload {
  items: ClipboardItem[]
  /** 复制时选中的片段数（含不支持的项时为 0）。 */
  count: number
}

const EMPTY_PAYLOAD: ClipboardPayload = { items: [], count: 0 }
/** 空剪贴板（切换项目时重置用）。 */
export const EMPTY_CLIPBOARD: ClipboardPayload = EMPTY_PAYLOAD

/** 按 id 集合收集可复制的片段，offset 以组内最早者为 0。 */
export function buildClipboardPayload(project: Project, ids: readonly string[]): ClipboardPayload {
  const idSet = new Set(ids)
  const items: ClipboardItem[] = []
  const starts: number[] = []

  for (const segment of getTimeline(project.clips)) {
    if (!idSet.has(segment.clip.id)) continue
    items.push({ kind: 'main', trackId: null, offset: 0, clip: segment.clip })
    starts.push(segment.start)
  }
  for (const track of getOverlayTracks(project)) {
    for (const segment of getTimeline(track.clips)) {
      if (!idSet.has(segment.clip.id)) continue
      items.push({ kind: 'overlay', trackId: track.id, offset: 0, clip: segment.clip })
      starts.push(segment.start)
    }
  }
  for (const track of project.audioTracks ?? []) {
    for (const clip of track.clips) {
      if (!idSet.has(clip.id)) continue
      items.push({ kind: 'audio', trackId: track.id, offset: 0, clip })
      starts.push(clip.start)
    }
  }
  for (const track of project.textTracks ?? []) {
    for (const clip of track.clips) {
      if (!idSet.has(clip.id)) continue
      items.push({ kind: 'text', trackId: track.id, offset: 0, clip })
      starts.push(clip.start)
    }
  }
  if (items.length === 0) return EMPTY_PAYLOAD

  const base = Math.min(...starts)
  items.forEach((item, index) => {
    item.offset = starts[index] - base
  })
  return { items, count: items.length }
}

export interface PastePlanAudio {
  kind: 'audio'
  trackId: string | null
  clip: AudioClip
}

export interface PastePlanText {
  kind: 'text'
  trackId: string | null
  clip: TextClip
}

export interface PastePlanVideo {
  kind: 'main' | 'overlay'
  trackId: string | null
  /** 插入到目标轨序列中的下标。 */
  index: number
  /** 相对粘贴锚点的偏移，用于新建轨道时确定相对顺序。 */
  offset: number
  clip: Clip
}

export interface PastePlan {
  /** 顺序轨（主轨/叠加轨）插入的片段，按 index 升序应用。 */
  video: PastePlanVideo[]
  audio: PastePlanAudio[]
  text: PastePlanText[]
}

interface OccupiedRange {
  start: number
  end: number
}

function audioRanges(track: { clips: AudioClip[] }): OccupiedRange[] {
  return track.clips.map((clip) => ({
    start: clip.start,
    end: clip.start + Math.max(0, clip.sourceEnd - clip.sourceStart),
  }))
}

function textRanges(track: { clips: TextClip[] }): OccupiedRange[] {
  return track.clips.map((clip) => ({ start: clip.start, end: clip.end }))
}

/** 从期望位置开始，找第一个不与已占用区间重叠的位置（半开区间）。 */
export function findFreeSlot(
  desiredStart: number,
  duration: number,
  occupied: readonly OccupiedRange[],
  maxAttempts = 64,
): number {
  const length = Math.max(0, duration)
  let start = Math.max(0, desiredStart)
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const hit = occupied.find(
      (range) => Math.max(range.start, start) < Math.min(range.end, start + length),
    )
    if (!hit) return start
    start = hit.end + 0.05
  }
  return start
}

/**
 * 规划粘贴：顺序轨（主轨/叠加轨）插入到序列中；绝对时间轨（音频/文本）落在
 * 播放头 + 偏移处，冲突则依次后移。目标轨不存在/被锁定时由调用方传入 null，
 * 表示需要新建轨道。
 */
export function planPaste(
  project: Project,
  payload: ClipboardPayload,
  playhead: number,
  options: {
    lockedTrackIds?: ReadonlySet<string>
    /** 指定目标叠加轨（用户选中的那条）；可用时所有叠加片段都粘到它上面。 */
    targetOverlayTrackId?: string | null
  } = {},
): PastePlan {
  const locked = options.lockedTrackIds ?? new Set<string>()
  const plan: PastePlan = { video: [], audio: [], text: [] }
  const anchor = Math.max(0, playhead)
  const overlayTarget =
    options.targetOverlayTrackId &&
    getOverlayTracks(project).some((track) => track.id === options.targetOverlayTrackId) &&
    !locked.has(options.targetOverlayTrackId)
      ? options.targetOverlayTrackId
      : null

  const videoByTrack = new Map<string, ClipboardVideoItem[]>()
  for (const item of payload.items) {
    if (item.kind === 'main' || item.kind === 'overlay') {
      const key =
        item.kind === 'main' ? '__main__' : overlayTarget ?? item.trackId ?? ''
      const list = videoByTrack.get(key)
      if (list) list.push(item)
      else videoByTrack.set(key, [item])
    }
  }

  for (const [key, items] of videoByTrack) {
    const isMain = key === '__main__'
    const trackId = isMain ? null : key
    const trackExists = isMain
      ? true
      : getOverlayTracks(project).some((track) => track.id === trackId)
    const usableTrack = trackExists && !(trackId ? locked.has(trackId) : false)
    const targetClipList = isMain
      ? project.clips
      : getOverlayTracks(project).find((track) => track.id === trackId)?.clips ?? []
    const sorted = [...items].sort((left, right) => left.offset - right.offset)
    // 序列轨的“播放头所在位置”= 中心点早于播放头的片段数量。
    const index = usableTrack
      ? getTimeline(targetClipList).filter(
          (segment) => (segment.start + segment.end) / 2 < anchor - 0.0001,
        ).length
      : 0
    sorted.forEach((item, offsetIndex) => {
      plan.video.push({
        kind: item.kind,
        trackId: usableTrack ? trackId : null,
        index: index + offsetIndex,
        offset: item.offset,
        clip: item.clip,
      })
    })
  }

  for (const item of payload.items) {
    if (item.kind !== 'audio') continue
    const track = (project.audioTracks ?? []).find((entry) => entry.id === item.trackId)
    const usable = track && !locked.has(track.id)
    const start = usable
      ? findFreeSlot(anchor + item.offset, clipTimelineDuration(item.clip), audioRanges(track))
      : Math.max(0, anchor + item.offset)
    plan.audio.push({
      kind: 'audio',
      trackId: usable ? track.id : null,
      clip: { ...item.clip, start },
    })
  }

  for (const item of payload.items) {
    if (item.kind !== 'text') continue
    const track = (project.textTracks ?? []).find((entry) => entry.id === item.trackId)
    const usable = track && !locked.has(track.id)
    const start = usable
      ? findFreeSlot(anchor + item.offset, item.clip.end - item.clip.start, textRanges(track))
      : Math.max(0, anchor + item.offset)
    plan.text.push({
      kind: 'text',
      trackId: usable ? track.id : null,
      clip: {
        ...item.clip,
        start,
        end: start + (item.clip.end - item.clip.start),
      },
    })
  }

  return plan
}

/** 生成新 id 的工厂（便于测试注入固定值）。 */
export type IdFactory = (prefix: 'clip' | 'audio' | 'text' | 'overlay' | 'audioTrack' | 'textTrack') => string

/**
 * 把粘贴计划应用到工程上，返回新工程与新选中的 id 列表。
 * 目标轨为 null 时新建轨道（叠加轨/音频轨/文本轨）。
 */
export function applyPastePlan(
  project: Project,
  plan: PastePlan,
  nextId: IdFactory,
): { project: Project; selectedIds: string[] } {
  let next: Project = project
  const selectedIds: string[] = []

  // 1) 目标轨为 null 的叠加片段：按“原始轨道分组”，每组新建一条叠加轨。
  const neighbourlessOverlay = plan.video.filter(
    (item) => item.kind === 'overlay' && item.trackId === null,
  )
  if (neighbourlessOverlay.length > 0) {
    const groups = new Map<string, PastePlanVideo[]>()
    for (const item of neighbourlessOverlay) {
      const key = `new`
      const list = groups.get(key)
      if (list) list.push(item)
      else groups.set(key, [item])
    }
    for (const [, items] of groups) {
      const trackId = nextId('overlay')
      next = {
        ...next,
        overlayTracks: [
          ...(next.overlayTracks ?? []),
          {
            id: trackId,
            name: `叠加轨 ${(next.overlayTracks ?? []).length + 1}`,
            muted: false,
            hidden: false,
            clips: [],
          },
        ],
      }
      items
        .sort((left, right) => left.offset - right.offset)
        .forEach((item, index) => {
          item.trackId = trackId
          item.index = index
        })
    }
  }

  // 2) 顺序轨插入（从后往前插，避免下标位移）。
  const videoByTrack = new Map<string, PastePlanVideo[]>()
  for (const item of plan.video) {
    const key = item.kind === 'main' ? '__main__' : item.trackId ?? ''
    const list = videoByTrack.get(key)
    if (list) list.push(item)
    else videoByTrack.set(key, [item])
  }
  for (const [key, items] of videoByTrack) {
    const clones = items
      .sort((left, right) => left.index - right.index)
      .map((item, offsetIndex) => ({
        index: item.index,
        clip: {
          ...item.clip,
          id: nextId('clip'),
          // 第一段从粘贴锚点开始（不带前导空隙）；后续段保留原来的相对间距，
          // 否则「复制一段带空隙的组」粘出来会挤成一团。
          gapBefore:
            offsetIndex === 0 ? 0 : Math.max(0, item.clip.gapBefore ?? 0),
        },
      }))
    const insert = (list: Clip[]): Clip[] => {
      const copy = [...list]
      clones.forEach((entry) => {
        copy.splice(Math.max(0, Math.min(copy.length, entry.index)), 0, entry.clip)
      })
      return copy
    }
    if (key === '__main__') {
      next = { ...next, clips: insert(next.clips) }
    } else {
      next = {
        ...next,
        overlayTracks: (next.overlayTracks ?? []).map((track) =>
          track.id === key ? { ...track, clips: insert(track.clips) } : track,
        ),
      }
    }
    for (const entry of clones) selectedIds.push(entry.clip.id)
  }

  // 3) 音频轨
  const audioByTrack = new Map<string, PastePlanAudio[]>()
  for (const item of plan.audio) {
    const key = item.trackId ?? '__new__'
    const list = audioByTrack.get(key)
    if (list) list.push(item)
    else audioByTrack.set(key, [item])
  }
  for (const [key, items] of audioByTrack) {
    let trackId = key
    if (!next.audioTracks?.some((track) => track.id === trackId)) {
      trackId = nextId('audioTrack')
      next = {
        ...next,
        audioTracks: [
          ...(next.audioTracks ?? []),
          { id: trackId, name: `音频轨 ${(next.audioTracks ?? []).length + 1}`, muted: false, hidden: false, volume: 1, clips: [] },
        ],
      }
    }
    const clones = items.map((item) => ({ ...item.clip, id: nextId('audio') }))
    next = {
      ...next,
      audioTracks: (next.audioTracks ?? []).map((track) =>
        track.id === trackId ? { ...track, clips: [...track.clips, ...clones] } : track,
      ),
    }
    for (const clone of clones) selectedIds.push(clone.id)
  }

  // 4) 文本轨
  const textByTrack = new Map<string, PastePlanText[]>()
  for (const item of plan.text) {
    const key = item.trackId ?? '__new__'
    const list = textByTrack.get(key)
    if (list) list.push(item)
    else textByTrack.set(key, [item])
  }
  for (const [key, items] of textByTrack) {
    let trackId = key
    const existing = (next.textTracks ?? []).find((track) => track.id === trackId)
    if (!existing) {
      trackId = nextId('textTrack')
      next = {
        ...next,
        textTracks: [
          ...(next.textTracks ?? []),
          { id: trackId, name: `文本轨 ${(next.textTracks ?? []).length + 1}`, muted: false, hidden: false, clips: [], kind: 'text' },
        ],
      }
    }
    const clones = items.map((item) => ({
      ...item.clip,
      id: nextId('text'),
      link: undefined,
    }))
    next = {
      ...next,
      textTracks: (next.textTracks ?? []).map((track) =>
        track.id === trackId ? { ...track, clips: [...track.clips, ...clones] } : track,
      ),
    }
    for (const clone of clones) selectedIds.push(clone.id)
  }

  return { project: next, selectedIds }
}