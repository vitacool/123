import {
  addAudioClipToProject,
  addAudioTrackToProject,
  moveAudioClipInProject,
  removeAudioClipFromProject,
  removeAudioTrackFromProject,
  resizeAudioClipInProject,
  splitAudioClipInProject,
  trimAudioClipAt,
  updateAudioClipInProject,
  updateAudioTrackInProject,
} from './audio'
import {
  addClipToTrackAtTime,
  addMarkerToProject,
  addEmptyOverlayTrack,
  addOverlayTrackFromClip,
  deleteMarkerFromProject,
  insertFreezeAt,
  removeClipFromProject,
  removeClipFromOverlayTrack,
  removeOverlayTrackFromProject,
  moveOverlayClipToTrack,
  moveClipToTrackAtTime,
  reorderClipInProject,
  reorderOverlayClipInProject,
  resizeClipEdge,
  resizeFreezeClip,
  resizeOverlayClipEdge,
  setAspectRatioInProject,
  setExportQualityInProject,
  applyTransitionToAllJunctions,
  applyColorToAllClips,
  splitOverlayClipAt,
  splitProjectAt,
  trimOverlayClipAt,
  trimProjectLeft,
  trimProjectRight,
  updateClipInProject,
  updateMainTrackInProject,
  updateMarkerInProject,
  updateOverlayTrackInProject,
} from './operations'
import {
  addCaptionTrackWithClips,
  addTextClipToProject,
  addTextTrackToProject,
  mergeTextCaptionWithPrevious,
  moveTextClipInProject,
  removeTextClipFromProject,
  removeTextTrackFromProject,
  replaceTextInTrack,
  resizeTextClipInProject,
  setCaptionTrackClips,
  splitTextCaptionInProject,
  splitTextClipInProject,
  trimTextClipAt,
  updateCaptionClipStyleInProject,
  updateCaptionStyleInProject,
  updateTextClipInProject,
  updateTextTrackInProject,
} from './text'
import type {
  AspectRatioPreset,
  AudioClip,
  AudioTrack,
  CaptionStyle,
  Clip,
  ExportQuality,
  Marker,
  OverlayTrack,
  Project,
  TextClip,
  TextTrack,
  TrackState,
} from './types'
import type { TransitionAllOptions } from './operations'
import type { ColorAdjustments } from './color'
import { normalizeTransitionType, transitionLabel } from './transition'
import { relinkCaptions } from './captionLink'
import { normalizeBackground, withClipBackground } from './background'
import type { CanvasBackground } from './types'
import { clipFadeIn, clipFadeOut, clipVolume } from './clipAudio'
import { contiguousRunHeads } from './selection'
import { findClipLocation, getTimeline } from './timeline'
import { isMainLocked, isOverlayLocked } from './tracks'
import type { IdFactory, PastePlan } from './clipboard'
import { applyPastePlan } from './clipboard'

/**
 * Every project mutation is represented by a command. Only the store's
 * `execute()` entry point runs commands, which keeps undo/redo deterministic.
 */
export interface EditorCommand {
  readonly label: string
  readonly selectionAfter?: string | null
  execute(project: Project): Project
}

export function createUpdateClipCommand(
  clipId: string,
  update: Partial<Clip> | ((clip: Clip) => Partial<Clip>),
  label: string,
): EditorCommand {
  return {
    label,
    execute(project) {
      const clip = project.clips.find((item) => item.id === clipId)
      if (!clip) return project
      const patch = typeof update === 'function' ? update(clip) : update
      return updateClipInProject(project, clipId, patch) ?? project
    },
  }
}

/** 更新片段（主轨或叠加轨，按 id 自动定位），用于片段音频等通用属性。 */
export function createUpdateAnyClipCommand(
  clipId: string,
  patch: Partial<Clip>,
  label: string,
): EditorCommand {
  return {
    label,
    execute(project) {
      const inMain = project.clips.some((item) => item.id === clipId)
      if (inMain) return updateClipInProject(project, clipId, patch) ?? project
      for (const track of project.overlayTracks ?? []) {
        if (!track.clips.some((item) => item.id === clipId)) continue
        return {
          ...project,
          overlayTracks: project.overlayTracks!.map((entry) =>
            entry.id === track.id
              ? {
                  ...entry,
                  clips: entry.clips.map((item) =>
                    item.id === clipId ? { ...item, ...patch } : item,
                  ),
                }
              : entry,
          ),
        }
      }
      return project
    },
  }
}

/**
 * 把同一种转场应用到主轨所有可生效的交界（1 次命令 = 1 步撤销）。
 * 没有任何交界可应用时命令返回原 project，因此不会写入历史。
 */
export function createSetTransitionAllCommand(
  options: TransitionAllOptions,
): EditorCommand {
  return {
    label: `转场 ${transitionLabel(normalizeTransitionType(options.type))} 应用到所有交界`,
    execute(project) {
      return applyTransitionToAllJunctions(project, options).project
    },
  }
}

/**
 * 把同一组调色参数应用到所有画面片段（1 次命令 = 1 步撤销）。
 * 全都没有变化时返回原 project，不写历史。
 */
export function createSetColorAllCommand(color: ColorAdjustments): EditorCommand {
  return {
    label: '调色应用到全部片段',
    execute(project) {
      return applyColorToAllClips(project, color).project
    },
  }
}

export function createSplitCommand(
  clipId: string,
  time: number,
  rightId: string,
): EditorCommand {
  return {
    label: '分割片段',
    selectionAfter: rightId,
    execute(project) {
      return splitProjectAt(project, clipId, time, rightId) ?? project
    },
  }
}

export function createTrimLeftCommand(clipId: string, time: number): EditorCommand {
  return {
    label: '向左裁剪',
    execute(project) {
      return trimProjectLeft(project, clipId, time) ?? project
    },
  }
}

export function createTrimRightCommand(clipId: string, time: number): EditorCommand {
  return {
    label: '向右裁剪',
    execute(project) {
      return trimProjectRight(project, clipId, time) ?? project
    },
  }
}

export function createInsertFreezeCommand(
  time: number,
  freezeId: string,
  duration: number,
  rightSplitId?: string,
): EditorCommand {
  return {
    label: '插入定格',
    selectionAfter: freezeId,
    execute(project) {
      return (
        insertFreezeAt(project, time, freezeId, duration, rightSplitId)?.project ?? project
      )
    },
  }
}

export function createResizeFreezeCommand(clipId: string, duration: number): EditorCommand {
  return {
    label: '调整定格时长',
    execute(project) {
      return resizeFreezeClip(project, clipId, duration) ?? project
    },
  }
}

export function createResizeClipEdgeCommand(
  clipId: string,
  edge: 'left' | 'right',
  delta: number,
  sourceDuration: number,
): EditorCommand {
  return {
    label: edge === 'left' ? '拖动入点' : '拖动出点',
    execute(project) {
      return resizeClipEdge(project, clipId, edge, delta, sourceDuration) ?? project
    },
  }
}

export function createDeleteClipCommand(
  clipId: string,
  selectionAfter: string | null,
): EditorCommand {
  return {
    label: '删除片段',
    selectionAfter,
    execute(project) {
      return removeClipFromProject(project, clipId) ?? project
    },
  }
}

export function createReorderClipCommand(clipId: string, targetIndex: number): EditorCommand {
  return {
    label: '调整片段顺序',
    selectionAfter: clipId,
    execute(project) {
      return reorderClipInProject(project, clipId, targetIndex) ?? project
    },
  }
}

export function createAddEmptyOverlayTrackCommand(
  trackId: string,
  selectionAfter: string | null,
): EditorCommand {
  return {
    label: '新增叠加轨',
    selectionAfter,
    execute(project) {
      return addEmptyOverlayTrack(project, trackId)?.project ?? project
    },
  }
}

export function createAddOverlayTrackCommand(
  baseClipId: string,
  trackId: string,
  overlayClipId: string,
): EditorCommand {
  return {
    label: '新增叠加轨',
    selectionAfter: overlayClipId,
    execute(project) {
      return addOverlayTrackFromClip(project, baseClipId, trackId, overlayClipId)?.project ?? project
    },
  }
}

export function createUpdateMainTrackCommand(
  update: Partial<TrackState>,
  label: string,
): EditorCommand {
  return {
    label,
    execute(project) {
      return updateMainTrackInProject(project, update)
    },
  }
}

export function createUpdateOverlayTrackCommand(
  trackId: string,
  update: Partial<Pick<OverlayTrack, 'name' | 'muted' | 'hidden' | 'enabled' | 'locked' | 'solo'>>,
  label: string,
): EditorCommand {
  return {
    label,
    execute(project) {
      return updateOverlayTrackInProject(project, trackId, update) ?? project
    },
  }
}

export function createRemoveOverlayTrackCommand(
  trackId: string,
  selectionAfter: string | null,
): EditorCommand {
  return {
    label: '删除叠加轨',
    selectionAfter,
    execute(project) {
      return removeOverlayTrackFromProject(project, trackId) ?? project
    },
  }
}

export function createDeleteOverlayClipCommand(
  trackId: string,
  clipId: string,
  selectionAfter: string | null,
): EditorCommand {
  return {
    label: '删除叠加片段',
    selectionAfter,
    execute(project) {
      return removeClipFromOverlayTrack(project, trackId, clipId) ?? project
    },
  }
}

export function createReorderOverlayClipCommand(
  trackId: string,
  clipId: string,
  targetIndex: number,
): EditorCommand {
  return {
    label: '调整叠加片段顺序',
    selectionAfter: clipId,
    execute(project) {
      return reorderOverlayClipInProject(project, trackId, clipId, targetIndex) ?? project
    },
  }
}

export function createMoveOverlayClipCommand(
  sourceTrackId: string,
  clipId: string,
  targetTrackId: string,
  targetIndex: number,
  targetStart: number,
): EditorCommand {
  return {
    label: '移动叠加片段到轨道',
    selectionAfter: clipId,
    execute(project) {
      return (
        moveOverlayClipToTrack(
          project,
          sourceTrackId,
          clipId,
          targetTrackId,
          targetIndex,
          targetStart,
        ) ?? project
      )
    },
  }
}

export function createMoveClipToTrackAtTimeCommand(
  clipId: string,
  targetTrackId: string | null,
  targetStart: number,
  linkFollowing = false,
  mainTrackMagnet = false,
): EditorCommand {
  return {
    label: '拖动片段',
    selectionAfter: clipId,
    execute(project) {
      return (
        moveClipToTrackAtTime(
          project,
          clipId,
          targetTrackId,
          targetStart,
          linkFollowing,
          mainTrackMagnet,
        ) ?? project
      )
    },
  }
}

export function createAddClipCommand(
  clip: Clip,
  targetTrackId: string | null,
  targetStart: number,
): EditorCommand {
  return {
    label: '添加素材片段',
    selectionAfter: clip.id,
    execute(project) {
      return addClipToTrackAtTime(project, clip, targetTrackId, targetStart) ?? project
    },
  }
}

export function createAddAudioTrackCommand(
  trackId: string,
  selectionAfter: string | null,
): EditorCommand {
  return {
    label: '新增音频轨',
    selectionAfter,
    execute(project) {
      return addAudioTrackToProject(project, trackId).project
    },
  }
}

export function createRemoveAudioTrackCommand(
  trackId: string,
  selectionAfter: string | null,
): EditorCommand {
  return {
    label: '删除音频轨',
    selectionAfter,
    execute(project) {
      return removeAudioTrackFromProject(project, trackId) ?? project
    },
  }
}

export function createUpdateAudioTrackCommand(
  trackId: string,
  update: Partial<Pick<AudioTrack, 'name' | 'muted' | 'hidden' | 'volume' | 'enabled' | 'locked' | 'solo'>>,
  label: string,
): EditorCommand {
  return {
    label,
    execute(project) {
      return updateAudioTrackInProject(project, trackId, update) ?? project
    },
  }
}

export function createAddAudioClipCommand(
  trackId: string,
  clip: AudioClip,
  trackName?: string,
): EditorCommand {
  return {
    label: '添加音频片段',
    selectionAfter: clip.id,
    execute(project) {
      return addAudioClipToProject(project, trackId, clip, trackName) ?? project
    },
  }
}

export function createUpdateAudioClipCommand(
  trackId: string,
  clipId: string,
  update: Partial<Omit<AudioClip, 'id'>>,
  label = '调整音频片段',
): EditorCommand {
  return {
    label,
    selectionAfter: clipId,
    execute(project) {
      return updateAudioClipInProject(project, trackId, clipId, update) ?? project
    },
  }
}

export function createRemoveAudioClipCommand(
  trackId: string,
  clipId: string,
  selectionAfter: string | null,
): EditorCommand {
  return {
    label: '删除音频片段',
    selectionAfter,
    execute(project) {
      return removeAudioClipFromProject(project, trackId, clipId) ?? project
    },
  }
}

export function createMoveAudioClipCommand(
  trackId: string,
  clipId: string,
  start: number,
): EditorCommand {
  return {
    label: '移动音频片段',
    selectionAfter: clipId,
    execute(project) {
      return moveAudioClipInProject(project, trackId, clipId, start) ?? project
    },
  }
}

export function createResizeAudioClipCommand(
  trackId: string,
  clipId: string,
  edge: 'left' | 'right',
  delta: number,
  sourceDuration: number,
): EditorCommand {
  return {
    label: edge === 'left' ? '拖动音频入点' : '拖动音频出点',
    selectionAfter: clipId,
    execute(project) {
      return (
        resizeAudioClipInProject(project, trackId, clipId, edge, delta, sourceDuration) ??
        project
      )
    },
  }
}

export function createSplitOverlayClipCommand(
  trackId: string,
  clipId: string,
  time: number,
  rightId: string,
): EditorCommand {
  return {
    label: '分割叠加片段',
    selectionAfter: rightId,
    execute(project) {
      return splitOverlayClipAt(project, trackId, clipId, time, rightId) ?? project
    },
  }
}

export function createTrimOverlayClipCommand(
  trackId: string,
  clipId: string,
  time: number,
  edge: 'left' | 'right',
): EditorCommand {
  return {
    label: edge === 'left' ? '向左裁剪叠加片段' : '向右裁剪叠加片段',
    selectionAfter: clipId,
    execute(project) {
      return trimOverlayClipAt(project, trackId, clipId, time, edge) ?? project
    },
  }
}

export function createResizeOverlayClipEdgeCommand(
  trackId: string,
  clipId: string,
  edge: 'left' | 'right',
  delta: number,
  sourceDuration: number,
): EditorCommand {
  return {
    label: edge === 'left' ? '拖动叠加入点' : '拖动叠加出点',
    selectionAfter: clipId,
    execute(project) {
      return (
        resizeOverlayClipEdge(project, trackId, clipId, edge, delta, sourceDuration) ??
        project
      )
    },
  }
}

export function createSplitAudioClipCommand(
  trackId: string,
  clipId: string,
  time: number,
  rightId: string,
): EditorCommand {
  return {
    label: '分割音频片段',
    selectionAfter: rightId,
    execute(project) {
      return splitAudioClipInProject(project, trackId, clipId, time, rightId) ?? project
    },
  }
}

export function createTrimAudioClipCommand(
  trackId: string,
  clipId: string,
  time: number,
  edge: 'left' | 'right',
): EditorCommand {
  return {
    label: edge === 'left' ? '向左裁剪音频' : '向右裁剪音频',
    selectionAfter: clipId,
    execute(project) {
      return trimAudioClipAt(project, trackId, clipId, time, edge) ?? project
    },
  }
}

export function createAddTextTrackCommand(trackId: string): EditorCommand {
  return {
    label: '新增文本轨',
    selectionAfter: null,
    execute(project) {
      return addTextTrackToProject(project, trackId)
    },
  }
}

export function createRemoveTextTrackCommand(
  trackId: string,
  selectionAfter: string | null,
): EditorCommand {
  return {
    label: '删除文本轨',
    selectionAfter,
    execute(project) {
      return removeTextTrackFromProject(project, trackId) ?? project
    },
  }
}

export function createUpdateTextTrackCommand(
  trackId: string,
  update: Partial<Pick<TextTrack, 'name' | 'muted' | 'hidden' | 'enabled' | 'locked' | 'solo'>>,
  label: string,
): EditorCommand {
  return {
    label,
    execute(project) {
      return updateTextTrackInProject(project, trackId, update) ?? project
    },
  }
}

/** Applies a group style to a caption track (and clears per-clip overrides). */
export function createUpdateCaptionTrackStyleCommand(
  trackId: string,
  captionStyle: CaptionStyle,
  label = '应用字幕样式',
): EditorCommand {
  return {
    label,
    execute(project) {
      return updateCaptionStyleInProject(project, trackId, captionStyle) ?? project
    },
  }
}

/** Writes a per-clip style override on one caption clip. */
export function createUpdateCaptionClipStyleCommand(
  trackId: string,
  clipId: string,
  styleOverride: CaptionStyle,
  label = '修改字幕样式',
): EditorCommand {
  return {
    label,
    selectionAfter: clipId,
    execute(project) {
      return (
        updateCaptionClipStyleInProject(project, trackId, clipId, styleOverride) ?? project
      )
    },
  }
}

export function createAddTextClipCommand(
  trackId: string,
  clip: TextClip,
): EditorCommand {
  return {
    label: '添加文本片段',
    selectionAfter: clip.id,
    execute(project) {
      return addTextClipToProject(project, trackId, clip) ?? project
    },
  }
}

export function createUpdateTextClipCommand(
  trackId: string,
  clipId: string,
  update: Partial<Omit<TextClip, 'id'>>,
  label = '修改文本',
): EditorCommand {
  return {
    label,
    selectionAfter: clipId,
    execute(project) {
      return updateTextClipInProject(project, trackId, clipId, update) ?? project
    },
  }
}

export function createRemoveTextClipCommand(
  trackId: string,
  clipId: string,
  selectionAfter: string | null,
): EditorCommand {
  return {
    label: '删除文本片段',
    selectionAfter,
    execute(project) {
      return removeTextClipFromProject(project, trackId, clipId) ?? project
    },
  }
}

export function createMoveTextClipCommand(
  trackId: string,
  clipId: string,
  start: number,
): EditorCommand {
  return {
    label: '移动文本片段',
    selectionAfter: clipId,
    execute(project) {
      return moveTextClipInProject(project, trackId, clipId, start) ?? project
    },
  }
}

export function createResizeTextClipCommand(
  trackId: string,
  clipId: string,
  edge: 'left' | 'right',
  delta: number,
): EditorCommand {
  return {
    label: edge === 'left' ? '拖动文本入点' : '拖动文本出点',
    selectionAfter: clipId,
    execute(project) {
      return resizeTextClipInProject(project, trackId, clipId, edge, delta) ?? project
    },
  }
}

export function createSplitTextClipCommand(
  trackId: string,
  clipId: string,
  time: number,
  rightId: string,
): EditorCommand {
  return {
    label: '分割文本片段',
    selectionAfter: rightId,
    execute(project) {
      return splitTextClipInProject(project, trackId, clipId, time, rightId) ?? project
    },
  }
}

export interface CaptionSplitParts {
  leftText: string
  rightText: string
  leftStart: number
  leftEnd: number
  rightStart: number
  rightEnd: number
  leftWords?: { text: string; start: number; end: number }[]
  rightWords?: { text: string; start: number; end: number }[]
}

/** 从光标处拆分一条智能字幕。 */
export function createSplitCaptionCommand(
  trackId: string,
  clipId: string,
  parts: CaptionSplitParts,
  rightId: string,
): EditorCommand {
  return {
    label: '拆分字幕',
    selectionAfter: rightId,
    execute(project) {
      return splitTextCaptionInProject(project, trackId, clipId, parts, rightId) ?? project
    },
  }
}

/** 把一条字幕合并到上一条。 */
export function createMergeCaptionWithPreviousCommand(
  trackId: string,
  clipId: string,
): EditorCommand {
  return {
    label: '合并字幕',
    execute(project) {
      return mergeTextCaptionWithPrevious(project, trackId, clipId) ?? project
    },
  }
}

/** 在一条字幕轨内全部替换文字。 */
export function createReplaceCaptionTextCommand(
  trackId: string,
  find: string,
  replace: string,
): EditorCommand {
  return {
    label: '全部替换字幕文字',
    execute(project) {
      return replaceTextInTrack(project, trackId, find, replace) ?? project
    },
  }
}

/** 设置工程级画布背景（一个命令）。 */
export function createSetCanvasBackgroundCommand(
  background: CanvasBackground,
  label = '设置画布背景',
): EditorCommand {
  return {
    label,
    execute(project) {
      const normalized = normalizeBackground(background)
      if (normalized.type === 'black') {
        const { canvasBackground: _removed, ...rest } = project
        return rest
      }
      return { ...project, canvasBackground: normalized }
    },
  }
}

/** 给指定片段设置背景覆盖（一个命令，可批量）。 */
export function createSetClipBackgroundCommand(
  ids: readonly string[],
  background: CanvasBackground,
  label = '设置片段背景',
): EditorCommand {
  return {
    label,
    execute(project) {
      if (ids.length === 0) return project
      const targets = new Set(ids)
      const apply = (clip: Clip): Clip =>
        targets.has(clip.id) ? withClipBackground(clip, background) : clip
      return {
        ...project,
        clips: project.clips.map(apply),
        overlayTracks: (project.overlayTracks ?? []).map((track) => ({
          ...track,
          clips: track.clips.map(apply),
        })),
      }
    },
  }
}
export function createRelinkCaptionsCommand(
  urlToAssetId: Map<string, string>,
): EditorCommand {
  return {
    label: '重新对齐字幕',
    execute(project) {
      return relinkCaptions(project, urlToAssetId)
    },
  }
}

/** 批量删除（跨轨道，一个命令）。 */
export function createDeleteManyCommand(ids: readonly string[], label?: string): EditorCommand {
  return {
    label: label ?? `删除 ${ids.length} 个片段`,
    selectionAfter: null,
    execute(project) {
      const targets = new Set(ids)
      return {
        ...project,
        clips: project.clips.filter((clip) => !targets.has(clip.id)),
        overlayTracks: (project.overlayTracks ?? [])
          .map((track) => ({ ...track, clips: track.clips.filter((clip) => !targets.has(clip.id)) }))
          .filter((track) => track.clips.length > 0),
        audioTracks: (project.audioTracks ?? [])
          .map((track) => ({ ...track, clips: track.clips.filter((clip) => !targets.has(clip.id)) }))
          .filter((track) => track.clips.length > 0),
        textTracks: (project.textTracks ?? [])
          .map((track) => ({ ...track, clips: track.clips.filter((clip) => !targets.has(clip.id)) }))
          .filter((track) => track.clips.length > 0),
      }
    },
  }
}

/** 批量移动（一个命令）：顺序轨移动“段头”的间隙，绝对时间轨移动 start。 */
export function createMoveManyCommand(
  ids: readonly string[],
  delta: number,
): EditorCommand {
  return {
    label: `移动 ${ids.length} 个片段`,
    execute(project) {
      if (ids.length === 0 || Math.abs(delta) < 0.0001) return project
      const targets = new Set(ids)

      const shiftSequence = (clips: Clip[]): Clip[] => {
        const ordered = getTimeline(clips).map((segment) => segment.clip.id)
        const heads = new Set(contiguousRunHeads(ordered, [...targets]))
        let next = clips
        for (let index = 0; index < next.length; index += 1) {
          const clip = next[index]
          if (!heads.has(clip.id)) continue
          const currentGap = Math.max(0, clip.gapBefore ?? 0)
          const nextGap = Math.max(0, currentGap + delta)
          const actual = nextGap - currentGap
          if (Math.abs(actual) < 0.0001) continue
          // 段头平移后，段内后续片段保持顺序相接，无需再改。
          next = next.map((item, itemIndex) =>
            itemIndex === index ? { ...item, gapBefore: nextGap } : item,
          )
        }
        return next
      }

      const shiftAbsoluteStart = <T extends { id: string; start: number; sourceStart: number }>(
        clip: T,
      ): T => ({ ...clip, start: Math.max(0, clip.start + delta) })

      return {
        ...project,
        clips: shiftSequence(project.clips),
        overlayTracks: (project.overlayTracks ?? []).map((track) => ({
          ...track,
          clips: shiftSequence(track.clips),
        })),
        audioTracks: (project.audioTracks ?? []).map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            targets.has(clip.id) ? shiftAbsoluteStart(clip) : clip,
          ),
        })),
        textTracks: (project.textTracks ?? []).map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            targets.has(clip.id) ? { ...clip, start: Math.max(0, clip.start + delta), end: Math.max(0.001, clip.end + delta) } : clip,
          ),
        })),
      }
    },
  }
}

/** 粘贴（一个命令，可能新建轨道）。 */
export function createPasteCommand(
  plan: PastePlan,
  nextId: IdFactory,
  selectedIdsOut: string[],
): EditorCommand {
  const count = plan.video.length + plan.audio.length + plan.text.length
  return {
    label: `粘贴 ${count} 个片段`,
    execute(project) {
      const result = applyPastePlan(project, plan, nextId)
      selectedIdsOut.length = 0
      selectedIdsOut.push(...result.selectedIds)
      return result.project
    },
  }
}

export interface DetachAudioOptions {
  clipId: string
  /** 目标音频轨 id；不存在时自动新建。 */
  audioTrackId: string
  /** 新音频片段的 id。 */
  audioClipId: string
  /** 音频轨名称（新建时使用）。 */
  trackName?: string
}

/**
 * 分离音频：把视频片段的声音生成为音频轨上同起止的 AudioClip，
 * 并把原片段 volume 置 0；音量与淡入淡出迁移到音频片段上，一次撤销完全还原。
 */
export function createDetachAudioCommand(options: DetachAudioOptions): EditorCommand {
  return {
    label: '分离音频',
    execute(project) {
      const location = findClipLocation(project, options.clipId)
      if (!location) return project
      const { clip, segment, track } = location
      // 定格片段没有声音。
      if (clip.type === 'freeze') return project
      if (track ? isOverlayLocked(track) : isMainLocked(project)) return project

      const volume = clipVolume(clip)
      const fadeIn = clipFadeIn(clip)
      const fadeOut = clipFadeOut(clip)
      const audioClip: AudioClip = {
        id: options.audioClipId,
        sourceUrl: clip.sourceUrl,
        sourceStart: clip.sourceStart,
        sourceEnd: clip.sourceEnd,
        start: segment.start,
        volume,
        fadeIn,
        fadeOut,
      }

      // 1) 原片段静音（淡入淡出清零，避免分离后重复应用）。
      const silenced: Clip = { ...clip, volume: 0, fadeIn: 0, fadeOut: 0 }
      let next: Project = {
        ...project,
        clips: project.clips.map((item) => (item.id === clip.id ? silenced : item)),
        overlayTracks: (project.overlayTracks ?? []).map((entry) => ({
          ...entry,
          clips: entry.clips.map((item) => (item.id === clip.id ? silenced : item)),
        })),
      }

      // 2) 生成音频片段。
      next =
        addAudioClipToProject(
          next,
          options.audioTrackId,
          audioClip,
          options.trackName ?? `分离音频 ${(next.audioTracks ?? []).length + 1}`,
        ) ?? next
      return next
    },
  }
}

export function createTrimTextClipCommand(
  trackId: string,
  clipId: string,
  time: number,
  edge: 'left' | 'right',
): EditorCommand {
  return {
    label: edge === 'left' ? '向左裁剪文本' : '向右裁剪文本',
    selectionAfter: clipId,
    execute(project) {
      return trimTextClipAt(project, trackId, clipId, time, edge) ?? project
    },
  }
}

export function createImportAutoCaptionsCommand(
  trackId: string,
  clips: TextClip[],
  trackName: string,
): EditorCommand {
  return {
    label: `生成智能字幕（${clips.length} 条）`,
    selectionAfter: clips[0]?.id ?? null,
    execute(project) {
      return addCaptionTrackWithClips(project, trackId, clips, trackName)
    },
  }
}

/**
 * Replaces the clips of ONE caption track (keeping its id/name/style/state),
 * in a single command, so one undo fully restores the prior captions.
 */
export function createReplaceAutoCaptionsCommand(
  trackId: string,
  clips: TextClip[],
): EditorCommand {
  return {
    label: `替换智能字幕（${clips.length} 条）`,
    selectionAfter: clips[0]?.id ?? null,
    execute(project) {
      return setCaptionTrackClips(project, trackId, clips)
    },
  }
}

export function createImportSubtitlesCommand(
  trackId: string,
  clips: TextClip[],
): EditorCommand {
  return {
    label: `导入字幕（${clips.length} 条）`,
    selectionAfter: clips[0]?.id ?? null,
    execute(project) {
      let next = project
      for (const clip of clips) {
        next = addTextClipToProject(next, trackId, clip) ?? next
      }
      return next
    },
  }
}

export function createAddMarkerCommand(marker: Marker): EditorCommand {
  return {
    label: '添加标记',
    execute(project) {
      return addMarkerToProject(project, marker)
    },
  }
}

export function createUpdateMarkerCommand(marker: Marker): EditorCommand {
  return {
    label: '修改标记',
    execute(project) {
      return updateMarkerInProject(project, marker) ?? project
    },
  }
}

export function createDeleteMarkerCommand(markerId: string): EditorCommand {
  return {
    label: '删除标记',
    execute(project) {
      return deleteMarkerFromProject(project, markerId)
    },
  }
}

export function createSetAspectRatioCommand(aspectRatio: AspectRatioPreset): EditorCommand {
  return {
    label: '修改画面比例',
    execute(project) {
      return setAspectRatioInProject(project, aspectRatio)
    },
  }
}

export function createSetExportQualityCommand(quality: ExportQuality): EditorCommand {
  return {
    label: '修改导出画质',
    execute(project) {
      return setExportQualityInProject(project, quality)
    },
  }
}