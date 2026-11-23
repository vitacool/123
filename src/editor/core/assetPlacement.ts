import { assetKindOf, type AssetKind } from './assets'
import { clipTimelineDuration } from './clipTime'
import { MAX_OVERLAY_TRACKS } from './constants'
import { IMAGE_DEFAULT_DURATION } from './image'
import { getTimeline } from './timeline'
import { isAudioLocked, isMainLocked, isOverlayLocked } from './tracks'
import type { AudioTrack, MediaAsset, OverlayTrack, Project } from './types'

/**
 * 从素材库添加素材时的**落点决策**（纯函数，便于单测）。
 *
 * 规则（与产品约定一致）：
 * A. 音频：进音频轨（没有就新建；放的进去就复用第一条没锁定且不重叠的）。
 * B. 视频/图片：主轨空 → 主轨；同一素材（url 相同）→ 接在主轨末尾；
 *    否则新建叠加轨（达到上限时找一条能放的，都放不下就提示并取消）。
 * C. 拖到具体轨道：以用户选择为准；落到别的类型的轨道上按自动规则并提示。
 */

export type AssetPlacementIntent =
  | { kind: 'auto'; time: number }
  | {
      kind: 'track'
      trackKind: 'main' | 'overlay' | 'audio'
      trackId: string
      time: number
    }

export interface AssetPlacement {
  /** 目标：主轨 / 已有或新建的叠加轨 / 已有或新建的音频轨 / 被拒绝。 */
  target: 'main' | 'overlay' | 'audio' | 'blocked'
  /** 已有轨道 id；需要新建时为 null。 */
  trackId: string | null
  /** 需要新建时的轨道名（已保证不与现有轨道重名）。 */
  newTrackName?: string
  /** 片段的起始时间（秒）。 */
  start: number
  /** 给用户的提示文案。 */
  message: string
}

const clampTime = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0)

/** 素材在时间轴上占用的时长（图片是固定默认时长）。 */
export function assetPlacementDuration(asset: MediaAsset): number {
  const kind = assetKindOf(asset)
  if (kind === 'image') return IMAGE_DEFAULT_DURATION
  return Math.max(0.1, asset.duration ?? 0)
}

/** 生成不与现有轨道重名的名字（例如「音频轨 3」）。 */
export function uniqueTrackName(
  existing: readonly { name: string }[],
  prefix: string,
  count: number,
): string {
  const used = new Set(existing.map((track) => track.name))
  let index = count + 1
  while (used.has(`${prefix} ${index}`)) index += 1
  return `${prefix} ${index}`
}

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }): boolean =>
  a.start < b.end - 1e-6 && b.start < a.end - 1e-6

function audioTrackFree(track: AudioTrack, start: number, duration: number): boolean {
  if (isAudioLocked(track)) return false
  const want = { start, end: start + duration }
  return !track.clips.some((clip) => {
    // 叠加轨里片段的固定起点是 start（Clip 类型上未声明，历史原因）。
    const clipStart = (clip as { start?: number }).start ?? 0
    return overlaps(want, { start: clipStart, end: clipStart + clipTimelineDuration(clip) })
  })
}

function overlayTrackFree(track: OverlayTrack, start: number, duration: number): boolean {
  if (isOverlayLocked(track)) return false
  const want = { start, end: start + duration }
  return !track.clips.some((clip) => {
    // 叠加轨片段的固定起点是 start（Clip 类型上未声明，历史原因）。
    const clipStart = (clip as { start?: number }).start ?? 0
    return overlaps(want, { start: clipStart, end: clipStart + clipTimelineDuration(clip) })
  })
}

/** 主轨结束时间（最后一个片段的出点）。 */
export function mainTrackEnd(project: Project): number {
  const timeline = getTimeline(project.clips)
  const last = timeline[timeline.length - 1]
  return last ? last.end : 0
}

/** 主轨是否已经有片段。 */
function mainTrackEmpty(project: Project): boolean {
  return project.clips.length === 0
}

/** 主轨里是否有片段用了这个素材（只按 url 判断）。 */
function mainUsesAsset(project: Project, asset: MediaAsset): boolean {
  return project.clips.some((clip) => clip.sourceUrl === asset.url)
}

// ---------------------------------------------------------------------------
// 音频
// ---------------------------------------------------------------------------

function placeAudio(project: Project, asset: MediaAsset, time: number): AssetPlacement {
  const start = clampTime(time)
  const duration = assetPlacementDuration(asset)
  const tracks = project.audioTracks ?? []
  const free = tracks.find((track) => audioTrackFree(track, start, duration))
  if (free) {
    return {
      target: 'audio',
      trackId: free.id,
      start,
      message: `已添加到「${free.name}」`,
    }
  }
  const name = uniqueTrackName(tracks, '音频轨', tracks.length)
  return {
    target: 'audio',
    trackId: null,
    newTrackName: name,
    start,
    message: `已添加到新建的${name}`,
  }
}

// ---------------------------------------------------------------------------
// 视频 / 图片
// ---------------------------------------------------------------------------

function placeVisual(
  project: Project,
  asset: MediaAsset,
  time: number,
  allowAppendToMain: boolean,
): AssetPlacement {
  const start = clampTime(time)
  const duration = assetPlacementDuration(asset)

  // 1) 主轨为空 → 主轨
  if (mainTrackEmpty(project)) {
    if (isMainLocked(project)) {
      return { target: 'blocked', trackId: null, start, message: '主轨已锁定，请解锁后重试' }
    }
    return { target: 'main', trackId: null, start, message: '已添加到主轨' }
  }

  // 2) 同一素材 → 接在主轨末尾（主轨锁定时退回叠加轨规则）
  if (allowAppendToMain && mainUsesAsset(project, asset) && !isMainLocked(project)) {
    const appendAt = mainTrackEnd(project)
    return {
      target: 'main',
      trackId: null,
      start: appendAt,
      message: '已接在主轨末尾',
    }
  }

  // 3) 不同素材 → 新建叠加轨（达到上限时找一条能放的）
  const tracks = project.overlayTracks ?? []
  if (tracks.length >= MAX_OVERLAY_TRACKS) {
    // 「从上到下」= 渲染顺序里最上层优先 → 数组末尾先试。
    for (let index = tracks.length - 1; index >= 0; index -= 1) {
      const track = tracks[index]
      if (overlayTrackFree(track, start, duration)) {
        return {
          target: 'overlay',
          trackId: track.id,
          start,
          message: `叠加轨已达上限，已放进有空位的「${track.name}」`,
        }
      }
    }
    return {
      target: 'blocked',
      trackId: null,
      start,
      message: `叠加轨已达上限（${MAX_OVERLAY_TRACKS} 条），请拖到指定轨道或删除空轨道`,
    }
  }

  const name = uniqueTrackName(tracks, '叠加轨', tracks.length)
  const appendHint = allowAppendToMain ? '' : '（主轨已锁定）'
  return {
    target: 'overlay',
    trackId: null,
    newTrackName: name,
    start,
    message: `已添加到新建的${name}${appendHint}`,
  }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 决定素材的落点。不做任何修改，只返回方案；由 store 用命令执行。
 */
export function resolveAssetPlacement(
  project: Project,
  asset: MediaAsset,
  intent: AssetPlacementIntent,
): AssetPlacement {
  const kind: AssetKind = assetKindOf(asset)
  const time = intent.kind === 'auto' ? intent.time : intent.time

  // ---- 拖到具体轨道 ----
  if (intent.kind === 'track') {
    if (kind === 'audio') {
      if (intent.trackKind === 'audio') {
        const track = (project.audioTracks ?? []).find((item) => item.id === intent.trackId)
        if (!track) return placeAudio(project, asset, time)
        if (isAudioLocked(track)) {
          return {
            target: 'blocked',
            trackId: null,
            start: clampTime(time),
            message: `「${track.name}」已锁定，无法放入音频；请解锁后重试`,
          }
        }
        return {
          target: 'audio',
          trackId: track.id,
          start: clampTime(time),
          message: `已添加到「${track.name}」`,
        }
      }
      // 音频拖到视频轨：放进音频轨并说明
      const placed = placeAudio(project, asset, time)
      return { ...placed, message: `音频不能放进视频轨，${placed.message}` }
    }

    // 视频/图片拖到视频轨：以用户选择为准
    if (intent.trackKind === 'main') {
      if (isMainLocked(project)) {
        return {
          target: 'blocked',
          trackId: null,
          start: clampTime(time),
          message: '主轨已锁定，请解锁后重试',
        }
      }
      return { target: 'main', trackId: null, start: clampTime(time), message: '已添加到主轨' }
    }
    if (intent.trackKind === 'overlay') {
      const track = (project.overlayTracks ?? []).find((item) => item.id === intent.trackId)
      if (!track) return placeVisual(project, asset, time, true)
      if (isOverlayLocked(track)) {
        return {
          target: 'blocked',
          trackId: null,
          start: clampTime(time),
          message: `「${track.name}」已锁定，无法放入视频；请解锁后重试`,
        }
      }
      return {
        target: 'overlay',
        trackId: track.id,
        start: clampTime(time),
        message: `已添加到「${track.name}」`,
      }
    }
    // 视频拖到音频轨：按自动规则并提示
    const placed = placeVisual(project, asset, time, true)
    return { ...placed, message: `视频不能放进音频轨，${placed.message}` }
  }

  // ---- 自动 ----
  return kind === 'audio' ? placeAudio(project, asset, time) : placeVisual(project, asset, time, true)
}