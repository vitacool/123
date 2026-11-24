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
import { isAudioLocked, isTextLocked } from './tracks'
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
  applyAttributePatch,
  moveOverlayTrackInProject,
  moveTrackInProject,
  removeClipsForAsset,
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
import type { TrackOrderKind } from './operations'
import type { RemoveAssetClipsOptions } from './operations'
import type { ColorAdjustments } from './color'
import type { AudioAttrs, SpeedAttrs, VisualAttrs } from './attributeClipboard'
import type { AnimatableProperty, ClipTransition, Easing, ProjectCover } from './types'
import {
  clearPropertyKeyframesInProject,
  moveKeyframesInProject,
  removeKeyframeInProject,
  setKeyframeEasingInProject,
  setKeyframeInProject,
  removeKeyframesInProject,
} from './keyframes'
import type { KeyframeRef } from './keyframeEdit'
import { normalizeTransitionType, transitionLabel } from './transition'
import { relinkCaptions } from './captionLink'
import { remapProjectUrls } from './draft'
import { normalizeBackground, withClipBackground } from './background'
import type { CanvasBackground } from './types'
import { clipFadeIn, clipFadeOut, clipVolume } from './clipAudio'
import { findAudioClipLocation, replacedAudioSourcePatch, reverseAudioClipPatch } from './audio'
import { canChangeClipSpeed, clipSpeedValue, hasSpeedVariation } from './speed'
import { speedAttrsPatch } from './attributeClipboard'
import { contiguousRunHeads } from './selection'
import { findClipLocation, getTimeline } from './timeline'
import { isMainLocked, isOverlayLocked } from './tracks'
import { replaceClipSourceInProject, type ReplaceClipSourceInput } from './reverse'
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

/**
 * 「倒放」：把片段指向新的倒放素材（并镜像关键帧），同时断开挂在它身上的
 * 智能字幕链接。1 次命令 = 1 步撤销：撤销即恢复原素材引用与字幕链接。
 */
export function createReverseClipCommand(
  input: ReplaceClipSourceInput & { label?: string },
): EditorCommand {
  return {
    label: input.label ?? '倒放片段',
    execute(project) {
      return replaceClipSourceInProject(project, input)
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
/**
 * 设置/移除一个接缝的转场；设置时若下一片段前有空隙，**同一步**把 gapBefore 归零。
 * 这样「空隙 + 转场」不再需要用户先手动闭合再添加（一次撤销可回到空隙状态）。
 */
export function createSetTransitionCommand(
  clipId: string,
  nextClipId: string | null,
  transition: ClipTransition | undefined,
  label?: string,
): EditorCommand {
  return {
    label: label ?? (transition ? '设置转场' : '移除转场'),
    selectionAfter: clipId,
    execute(project) {
      let changed = false
      const clips = project.clips.map((clip) => {
        if (clip.id === clipId) {
          if (transition === undefined) {
            if (!clip.transitionOut) return clip
            changed = true
            return { ...clip, transitionOut: undefined }
          }
          const previous = clip.transitionOut
          if (
            previous &&
            previous.type === transition.type &&
            Math.abs(previous.duration - transition.duration) < 1e-9
          ) {
            return clip
          }
          changed = true
          return { ...clip, transitionOut: { ...transition } }
        }
        if (
          nextClipId &&
          clip.id === nextClipId &&
          Math.max(0, clip.gapBefore ?? 0) > 0
        ) {
          changed = true
          return { ...clip, gapBefore: 0 }
        }
        return clip
      })
      return changed ? { ...project, clips } : project
    },
  }
}

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

/** 多选整体平移关键帧（1 步撤销）；夹取后无变化或产生重复时返回原 project。 */
export function createMoveKeyframesCommand(
  clipId: string,
  selected: readonly KeyframeRef[],
  delta: number,
): EditorCommand {
  return {
    label: '移动关键帧',
    execute(project) {
      return moveKeyframesInProject(project, clipId, selected, delta) ?? project
    },
  }
}

/** 批量删除关键帧（1 步撤销）。 */
export function createRemoveKeyframesCommand(
  clipId: string,
  refs: readonly KeyframeRef[],
): EditorCommand {
  return {
    label: '删除关键帧',
    execute(project) {
      return removeKeyframesInProject(project, clipId, refs) ?? project
    },
  }
}

/** 批量设置选中关键帧的缓动（1 步撤销）。 */
export function createSetKeyframeEasingCommand(
  clipId: string,
  selected: readonly KeyframeRef[],
  ease: Easing,
): EditorCommand {
  return {
    label: '设置缓动',
    execute(project) {
      return setKeyframeEasingInProject(project, clipId, selected, ease) ?? project
    },
  }
}

/** 清空某个属性的全部关键帧（1 步撤销）。 */
export function createClearPropertyKeyframesCommand(
  clipId: string,
  prop: AnimatableProperty,
): EditorCommand {
  return {
    label: '清空该属性的关键帧',
    execute(project) {
      return clearPropertyKeyframesInProject(project, clipId, prop) ?? project
    },
  }
}

/** 添加 / 更新一个关键帧（1 步撤销）；片段不存在时返回原 project。 */
export function createSetKeyframeCommand(
  clipId: string,
  prop: AnimatableProperty,
  t: number,
  value: number,
  ease: Easing = 'linear',
): EditorCommand {
  return {
    label: '设置关键帧',
    execute(project) {
      return setKeyframeInProject(project, clipId, prop, t, value, ease) ?? project
    },
  }
}

/** 删除一个关键帧（1 步撤销）。 */
export function createRemoveKeyframeCommand(
  clipId: string,
  prop: AnimatableProperty,
  t: number,
): EditorCommand {
  return {
    label: '删除关键帧',
    execute(project) {
      return removeKeyframeInProject(project, clipId, prop, t) ?? project
    },
  }
}

/** 设置封面（1 次命令 = 1 步撤销）。 */
export function createSetCoverCommand(cover: ProjectCover): EditorCommand {
  return {
    label: '设置封面',
    execute(project) {
      return { ...project, cover }
    },
  }
}

/** 移除封面（1 次命令 = 1 步撤销）；没有封面时返回原 project。 */
export function createClearCoverCommand(): EditorCommand {
  return {
    label: '移除封面',
    execute(project) {
      if (!project.cover) return project
      const { cover: _cover, ...rest } = project
      return rest
    },
  }
}

/**
 * 删除素材时一并删除所有引用它的片段（1 次命令 = 1 步撤销）。
 * 没有片段引用时返回原 project。
 */
export function createRemoveAssetClipsCommand(
  options: RemoveAssetClipsOptions,
): EditorCommand {
  return {
    label: '删除素材及关联片段',
    execute(project) {
      return removeClipsForAsset(project, options)
    },
  }
}

/**
 * 调整叠加轨层级（1 次命令 = 1 步撤销）。
 * 'up' 表示数组里往上层走（index+1，视觉上更高一层）；已在边界时返回原 project。
 */
export function createMoveOverlayTrackCommand(
  trackId: string,
  direction: 'up' | 'down',
): EditorCommand {
  return {
    label: direction === 'up' ? '叠加轨上移一层' : '叠加轨下移一层',
    execute(project) {
      return moveOverlayTrackInProject(project, trackId, direction)
    },
  }
}

/**
 * 粘贴画面属性：把剪贴板里的视觉属性覆盖到一组片段（1 次命令 = 1 步撤销）。
 * 只覆盖 attrs 中出现的字段；无目标可写时返回原 project。
 */
export function createPasteVisualAttributesCommand(
  ids: readonly string[],
  attrs: VisualAttrs,
): EditorCommand {
  return {
    label: '粘贴画面属性',
    execute(project) {
      return applyAttributePatch(project, ids, attrs as Partial<Clip>).project
    },
  }
}

/** 粘贴音频属性：音量 / 淡入 / 淡出（1 次命令 = 1 步撤销）。 */
export function createPasteAudioAttributesCommand(
  ids: readonly string[],
  attrs: AudioAttrs,
): EditorCommand {
  return {
    label: '粘贴音频属性',
    execute(project) {
      return applyAttributePatch(project, ids, attrs as Partial<Clip>).project
    },
  }
}

/**
 * 粘贴变速属性：倍率 / 分段 / 曲线（1 次命令 = 1 步撤销）。
 *
 * 定格 / 图片片段是静帧：变速会改变它们的停留时长（sourceStart..sourceEnd 即时长），
 * 因此这里按片段类型过滤；一条可写的目标都没有时返回原 project。
 */
export function createPasteSpeedAttributesCommand(
  ids: readonly string[],
  attrs: SpeedAttrs,
): EditorCommand {
  return {
    label: '粘贴变速属性',
    execute(project) {
      const patch = speedAttrsPatch(attrs)
      const targets = ids.filter((id) => {
        const location = findClipLocation(project, id)
        return Boolean(location && canChangeClipSpeed(location.clip))
      })
      if (targets.length === 0) return project
      return applyAttributePatch(project, targets, patch).project
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

/**
 * 重新链接缺失素材：把工程里所有引用 `oldUrl` 的地方（主轨 / 叠加 / 音频 /
 * 字幕 link / 画布背景）改到 `newUrl`，片段入出点、关键帧、音量都原样保留。
 *
 * `assetId` 用于同步字幕 link 上的稳定素材标识；不传则只改 URL。
 */
export function createRelinkAssetCommand(
  oldUrl: string,
  newUrl: string,
  assetId?: string,
): EditorCommand {
  return {
    label: '重新链接素材',
    execute(project) {
      if (!oldUrl || !newUrl || oldUrl === newUrl) return project
      const remapped = remapProjectUrls(project, new Map([[oldUrl, newUrl]]))
      if (!assetId) return remapped
      let changed = false
      const textTracks = (remapped.textTracks ?? []).map((track) => {
        let trackChanged = false
        const clips = track.clips.map((clip) => {
          if (!clip.link || clip.link.sourceUrl !== newUrl) return clip
          if (clip.link.assetId === assetId) return clip
          trackChanged = true
          return { ...clip, link: { ...clip.link, assetId } }
        })
        if (!trackChanged) return track
        changed = true
        return { ...track, clips }
      })
      return changed ? { ...remapped, textTracks } : remapped
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

/**
 * 新建一条叠加轨并把片段放进去——**一个命令**，一次撤销同时撤掉轨道和片段。
 * 轨道追加到数组末尾（渲染顺序上在最上层，符合「新轨道放最上层」）。
 */
/**
 * 调整轨道顺序（按**界面下标**）。一次拖动/一次点按 = 一个命令 = 一步撤销。
 * 只改顺序：不改变片段时间与内容，也不重命名轨道。
 */
export function createMoveTrackCommand(
  kind: TrackOrderKind,
  trackId: string,
  targetDisplayIndex: number,
): EditorCommand {
  const label =
    kind === 'overlay' ? '调整叠加轨顺序' : kind === 'audio' ? '调整音频轨顺序' : '调整文字轨顺序'
  return {
    label,
    execute(project) {
      return moveTrackInProject(project, kind, trackId, targetDisplayIndex)
    },
  }
}

export function createAddClipToNewOverlayTrackCommand(
  trackId: string,
  trackName: string,
  clip: Clip,
  start: number,
): EditorCommand {
  return {
    label: '添加到新建叠加轨',
    selectionAfter: clip.id,
    execute(project) {
      const tracks = project.overlayTracks ?? []
      // 先建一条空轨道（追加到末尾 = 渲染顺序最上层），再用现有的插入逻辑放片段，
      // 不改变 addClipToTrackAtTime 的内部行为。
      const withTrack = {
        ...project,
        overlayTracks: [
          ...tracks,
          {
            id: trackId,
            name: trackName,
            muted: true,
            hidden: false,
            enabled: true,
            locked: false,
            solo: false,
            clips: [],
          },
        ],
      }
      return addClipToTrackAtTime(withTrack, clip, trackId, Math.max(0, start)) ?? project
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

/** 把音频片段换成倒放素材：源区间镜像、淡化对调、音量关键帧镜像，其余参数保留。 */
export function createReverseAudioClipCommand(
  trackId: string,
  clipId: string,
  sourceUrl: string,
  sourceDuration: number,
): EditorCommand {
  return {
    label: '音频倒放',
    selectionAfter: clipId,
    execute(project) {
      const location = findAudioClipLocation(project, clipId)
      if (!location || location.track.id !== trackId) return project
      const patch = reverseAudioClipPatch(location.clip, sourceUrl, sourceDuration)
      return updateAudioClipInProject(project, trackId, clipId, patch) ?? project
    },
  }
}

/** 替换音频片段的素材：保留 start/音量/淡化/倍率，只把源区间夹到新素材时长内。 */
export function createReplaceAudioSourceCommand(
  trackId: string,
  clipId: string,
  sourceUrl: string,
  sourceDuration: number,
): EditorCommand {
  return {
    label: '替换音频素材',
    selectionAfter: clipId,
    execute(project) {
      const location = findAudioClipLocation(project, clipId)
      if (!location || location.track.id !== trackId) return project
      const patch = replacedAudioSourcePatch(location.clip, sourceUrl, sourceDuration)
      return updateAudioClipInProject(project, trackId, clipId, patch) ?? project
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
      /**
       * **锁定轨道的片段不能被批量删除**。
       *
       * 单选 Delete 走的是 `deleteSelectedClip`（那里判了锁），但 Ctrl+X / 框选后删除
       * 走的是这条批量命令，以前完全不看 locked —— 锁了轨还能把片段删掉，
       * 用户会觉得「锁定没用」。这里按轨道过滤，全部被过滤时返回原对象（不进历史）。
       */
      const targets = new Set<string>()
      if (!isMainLocked(project)) {
        for (const clip of project.clips) if (ids.includes(clip.id)) targets.add(clip.id)
      }
      for (const track of project.overlayTracks ?? []) {
        if (isOverlayLocked(track)) continue
        for (const clip of track.clips) if (ids.includes(clip.id)) targets.add(clip.id)
      }
      for (const track of project.audioTracks ?? []) {
        if (isAudioLocked(track)) continue
        for (const clip of track.clips) if (ids.includes(clip.id)) targets.add(clip.id)
      }
      for (const track of project.textTracks ?? []) {
        if (isTextLocked(track)) continue
        for (const clip of track.clips) if (ids.includes(clip.id)) targets.add(clip.id)
      }
      if (targets.size === 0) return project
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
      // AudioClip 没有变速字段：变速片段的源跨度 ≠ 时间轴时长，直接照抄会让
      // 分离出的音频比画面长/短、内容速度也不对。store 入口会先提示并拦截，
      // 这里再兜一层，避免以后新增入口绕过。
      if (clipSpeedValue(clip) !== 1 || hasSpeedVariation(clip)) return project

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
        ...(clip.fadeInCurve ? { fadeInCurve: clip.fadeInCurve } : {}),
        ...(clip.fadeOutCurve ? { fadeOutCurve: clip.fadeOutCurve } : {}),
      }
      // 音量关键帧要迁到音频片段：只写 volume=0 的话，有 anim.volume 的片段
      // 在预览/导出里仍按关键帧发声（原声残留 + 双份声音），且新音频丢失自动化。
      const volumeKeyframes = clip.anim?.volume
      if (volumeKeyframes && volumeKeyframes.length > 0) {
        audioClip.anim = {
          volume: volumeKeyframes.map((keyframe) => ({ ...keyframe })),
        }
      }

      // 1) 原片段静音（淡入淡出与音量关键帧清零，避免分离后重复应用）。
      const silencedAnim = clip.anim ? { ...clip.anim } : undefined
      if (silencedAnim) delete silencedAnim.volume
      const silenced: Clip = {
        ...clip,
        volume: 0,
        fadeIn: 0,
        fadeOut: 0,
        ...(clip.anim
          ? {
              anim:
                silencedAnim && Object.keys(silencedAnim).length > 0
                  ? silencedAnim
                  : undefined,
            }
          : {}),
      }
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
  trackName = '导入字幕',
): EditorCommand {
  return {
    label: `导入字幕（${clips.length} 条）`,
    selectionAfter: clips[0]?.id ?? null,
    execute(project) {
      // 必须建成 caption 轨：属性面板的字幕列表（含「导出 SRT」）只对
      // `kind === 'caption'` 的轨道可见。以前用 addTextClipToProject 会建出
      // 一条普通文本轨，导入后既看不到列表，也无法导出 SRT。
      return addCaptionTrackWithClips(project, trackId, clips, trackName)
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