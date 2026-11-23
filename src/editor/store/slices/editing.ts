import type { EditorState } from '../editorStore'
import type { ReverseJob } from '../editorStore'
import type { TimelineWord } from '../../core/captionMapping'
import type { StoreGet, StoreInternals, StoreSet } from '../internal'
import { aspectValue } from '../../core/aspect'
import { CROP_PRESETS } from '../../core/constants'
import { createAddAudioTrackCommand, createAddMarkerCommand, createAddEmptyOverlayTrackCommand, createAddTextClipCommand, createAddTextTrackCommand, createImportAutoCaptionsCommand, createImportSubtitlesCommand, createReplaceAutoCaptionsCommand, createDeleteMarkerCommand, createInsertFreezeCommand, createMoveAudioClipCommand, createMoveOverlayClipCommand, createMoveClipToTrackAtTimeCommand, createMoveTextClipCommand, createRemoveAudioClipCommand, createRemoveAudioTrackCommand, createRemoveOverlayTrackCommand, createRemoveTextClipCommand, createRemoveTextTrackCommand, createReorderClipCommand, createReorderOverlayClipCommand, createResizeAudioClipCommand, createResizeClipEdgeCommand, createResizeFreezeCommand, createResizeOverlayClipEdgeCommand, createResizeTextClipCommand, createSetAspectRatioCommand, createSetExportQualityCommand, createSplitAudioClipCommand, createSplitCommand, createSetTransitionAllCommand, createSetColorAllCommand, createMoveOverlayTrackCommand, createSetCoverCommand, createClearCoverCommand, createSetKeyframeCommand, createRemoveKeyframeCommand, createMoveKeyframesCommand, createSetKeyframeEasingCommand, createClearPropertyKeyframesCommand, createRemoveKeyframesCommand, createSplitOverlayClipCommand, createSplitTextClipCommand, createTrimAudioClipCommand, createTrimLeftCommand, createTrimOverlayClipCommand, createTrimRightCommand, createTrimTextClipCommand, createUpdateAudioClipCommand, createUpdateAudioTrackCommand, createUpdateAnyClipCommand, createReverseClipCommand, createUpdateMainTrackCommand, createUpdateMarkerCommand, createUpdateOverlayTrackCommand, createUpdateCaptionClipStyleCommand, createUpdateCaptionTrackStyleCommand, createReplaceCaptionTextCommand, createMergeCaptionWithPreviousCommand, createSplitCaptionCommand, createMoveTrackCommand, createUpdateTextClipCommand, createUpdateTextTrackCommand } from '../../core/commands'
import type { EditorCommand } from '../../core/commands'
import { clampCrop, applyTransitionToAllJunctions, applyColorToAllClips, normalizeAngle, displayToArrayIndex } from '../../core/operations'
import { createId } from '../../core/ids'
import {
  audioClipDuration,
  findAudioClipLocation,
  getAudioActionAvailability,
} from '../../core/audio'
import { captionStyleForTrack, cueToTextClip, findTextClipLocation, getTextActionAvailability } from '../../core/text'
import { splitCaptionText } from '../../core/captions'
import { normalizeBackground } from '../../core/background'
import { clampSpeed, canChangeClipSpeed, clipSpeedValue, normalizeSpeedCurve } from '../../core/speed'
import { clipFreezeFrame, clipTimelineDuration } from '../../core/clipTime'
import {
  clampTransitionDuration,
  maxTransitionDuration,
  normalizeTransitionType,
  transitionLabel,
  TRANSITION_MIN_DURATION,
} from '../../core/transition'
import { isSameColor, normalizeColor } from '../../core/color'
import { captureCoverFrame, readCoverImage } from '../../core/cover'
import { animationContextAt, moveKeyframesInProject } from '../../core/keyframes'
import { animationBaseValue, isPropertyAnimatizable } from '../../core/animationTargets'
import { evalAnimation } from '../../core/animation'
import { deleteMediaBlob, saveMediaBlob } from '../../services/draftStore'
import { readAssetFile } from '../../services/assetReader'
import {
  countLinkedCaptions,
  matchesReverseOrigin,
  mirrorAnimationTimes,
  needsReverseConfirm,
  planReverseRestore,
  reverseActionState,
  reverseAssetOrigin,
  reverseChunks,
} from '../../core/reverse'
import { isReverseAbort, reverseAssetSpan } from '../../services/reverseMedia'
import {
  blendModeLabel,
  clipBlendMode,
  clipOpacity,
  normalizeBlendMode,
} from '../../core/blend'
import { createDetachAudioCommand, createSetCanvasBackgroundCommand, createSetClipBackgroundCommand } from '../../core/commands'
import { mapWordsToTimeline } from '../../core/captionMapping'
import { mergeRelinkedCaptions } from '../../core/captionLink'
import { audioTrackState, isAudioLocked, isMainLocked, isOverlayLocked, isTextLocked, mainTrackState, overlayTrackState, textTrackState, type TrackFlag } from '../../core/tracks'
import {
  fillScaleFor,
  cropRectForAspect,
} from '../../core/geometry'
import { coverTargetSize } from '../../core/cover'
import { buildCaptionsFromWords } from '../../core/captions'
import { cueToCaptionClip } from '../../core/text'
import { selectableOrder } from '../../core/selection'
import { clamp, findClipLocation, findSegmentAt, findSegmentById, getActionAvailability, getProjectEnd } from '../../core/timeline'
import { FREEZE_DEFAULT_DURATION, FREEZE_MAX_DURATION, FREEZE_MIN_DURATION, MARKER_COLORS, MAX_OVERLAY_TRACKS, SCALE_MAX, SCALE_MIN } from '../../core/constants'
import { type AudioClip, type Clip, type Keyframe, type Marker, type MediaAsset, type Project, type ProjectCover, type TextClip } from '../../core/types'

/** 选中且未锁定的片段（编辑动作的共用前置判断）。 */
const selectedClip = (project: Project, id: string | null): Clip | null => {
  const location = findClipLocation(project, id)
  if (!location) return null
  const locked = location.track
    ? isOverlayLocked(location.track)
    : isMainLocked(project)
  return locked ? null : location.clip
}

/** 封面出图尺寸：跟随画布比例，短边 ≤1280（与 core/cover 的规则一致）。 */
const coverCanvasSize = (state: EditorState): { width: number; height: number } => {
  const reference = state.source ?? state.assets[0] ?? null
  const ratio = aspectValue(state.project.aspectRatio, reference)
  const height = 720
  return coverTargetSize(Math.round(height * Math.max(0.1, ratio)), height)
}
/**
 * editing slice：所有"改工程内容"的命令包装（分割 / 裁剪 / 轨道 / 字幕 / 关键帧 /
 * 变换 / 裁剪画面 / 封面写入 / 倒放任务）。
 *
 * 它没有自己的状态：每个动作最终都是一次 `run(command)`，因此只依赖共享内核。
 */
export type EditingSlice = Omit<
  EditorState,
  | 'project'
  | 'lastAction'
  | 'history'
  | 'execute'
  | 'undo'
  | 'redo'
  | 'cropSession'
  | keyof import('./ui').UiSlice
  | keyof import('./playback').PlaybackSlice
  | keyof import('./selection').SelectionSlice
  | keyof import('./assets').AssetsSlice
  | keyof import('./export').ExportSlice
  | keyof import('./persistence').PersistenceSlice
>

export function createEditingSlice(ctx: {
  get: StoreGet
  set: StoreSet
  internals: StoreInternals
}): EditingSlice {
  const { get, set, internals } = ctx
  const run = internals.run
  const buildCaptionClips = (project: Project, words: TimelineWord[]): TextClip[] => {
    const cues = buildCaptionsFromWords(words, { aspectRatio: project.aspectRatio })
    if (cues.length === 0) return []
    const assetIdByUrl = new Map(get().assets.map((asset) => [asset.url, asset.id]))
    return cues.map((cue) => {
      const clip = cueToCaptionClip(cue, createId('text'), project.aspectRatio)
      if (clip.link && !clip.link.assetId) {
        clip.link = {
          ...clip.link,
          assetId: assetIdByUrl.get(clip.link.sourceUrl ?? '') ?? clip.link.sourceUrl,
        }
      }
      return clip
    })
  }
  const applyCover = (cover: ProjectCover): void => {
    const state = get()
    if (run(createSetCoverCommand(cover))) state.notify('封面已更新', 'success')
  }
  return {
    setClipAudio: (clipId, patch, label) => {
      const location = findClipLocation(get().project, clipId)
      if (!location) return
      if (location.track ? isOverlayLocked(location.track) : isMainLocked(get().project)) return
      const command = createUpdateAnyClipCommand(clipId, patch, label)
      run(command)
    },
    detachAudio: (clipId) => {
      const state = get()
      const location = findClipLocation(state.project, clipId)
      if (!location || location.clip.type === 'freeze') {
        state.notify('定格片段没有声音，无法分离音频', 'warning')
        return
      }
      const audioTrackId = createId('audioTrack')
      const audioClipId = createId('audio')
      const detach = createDetachAudioCommand({
        clipId,
        audioTrackId,
        audioClipId,
        trackName: `分离音频 ${(state.project.audioTracks ?? []).length + 1}`,
      })
      if (run(detach)) {
        get().notify('已分离音频到新的音频轨', 'success')
      }
    },
    setClipSpeed: (clipId, speed, keepPitch) => {
      const state = get()
      const location = findClipLocation(state.project, clipId)
      if (!location) return
      if (location.track ? isOverlayLocked(location.track) : isMainLocked(state.project)) return
      if (!canChangeClipSpeed(location.clip)) {
        state.notify('定格片段不支持变速', 'warning')
        return
      }
      const next = clampSpeed(speed)
      const previous = clampSpeed(location.clip.speed ?? 1)
      if (Math.abs(next - previous) < 1e-6 && (location.clip.keepPitch !== false) === keepPitch) {
        return
      }
      run(
        createUpdateAnyClipCommand(
          clipId,
          { speed: next, keepPitch },
          `变速 ${Number(next.toFixed(2))}x`,
        ),
      )
    },
    setClipOpacity: (clipId, opacity) => {
      const state = get()
      const location = findClipLocation(state.project, clipId)
      if (!location) return
      if (location.track ? isOverlayLocked(location.track) : isMainLocked(state.project)) return
      const next = Math.max(0, Math.min(1, opacity))
      if (Math.abs(clipOpacity(location.clip) - next) < 1e-4) return
      run(
        createUpdateAnyClipCommand(
          clipId,
          { opacity: next },
          `不透明度 ${Math.round(next * 100)}%`,
        ),
      )
    },
    setClipMask: (clipId, mask) => {
      run(
        createUpdateAnyClipCommand(
          clipId,
          { mask },
          mask ? '设置蒙版' : '清除蒙版',
        ),
      )
    },
    setClipSpeedSegments: (clipId, segments) => {
      run(
        createUpdateAnyClipCommand(
          clipId,
          { speedSegments: segments },
          segments ? '设置变速分段' : '清除变速分段',
        ),
      )
    },
    setClipSpeedCurve: (clipId, curve) => {
      const state = get()
      const location = findClipLocation(state.project, clipId)
      if (!location) return
      if (location.track ? isOverlayLocked(location.track) : isMainLocked(state.project)) return
      if (!canChangeClipSpeed(location.clip)) {
        state.notify('定格片段不支持变速', 'warning')
        return
      }
      const normalized = curve ? normalizeSpeedCurve(curve) : undefined
      // 归一化后不成立（不足 2 点等）→ 视为无效输入，不改工程。
      if (curve && !normalized) return
      run(
        createUpdateAnyClipCommand(
          clipId,
          // 曲线与分段互斥：写曲线时把分段清掉，避免分段继续覆盖曲线。
          { speedCurve: normalized, speedSegments: undefined },
          normalized ? '设置速度曲线' : '清除速度曲线',
        ),
      )
    },
    setClipChromaKey: (clipId, key) => {
      run(
        createUpdateAnyClipCommand(
          clipId,
          { chromaKey: key },
          key ? '设置抠像' : '关闭抠像',
        ),
      )
    },
    setClipBlendMode: (clipId, mode) => {
      const state = get()
      const location = findClipLocation(state.project, clipId)
      if (!location) return
      if (location.track ? isOverlayLocked(location.track) : isMainLocked(state.project)) return
      const next = normalizeBlendMode(mode)
      if (clipBlendMode(location.clip) === next) return
      run(
        createUpdateAnyClipCommand(
          clipId,
          { blendMode: next },
          `混合模式 ${blendModeLabel(next)}`,
        ),
      )
    },
    setClipColor: (clipId, color) => {
      const state = get()
      const location = findClipLocation(state.project, clipId)
      if (!location) return
      if (location.track ? isOverlayLocked(location.track) : isMainLocked(state.project)) return
      const next = normalizeColor(color)
      if (isSameColor(normalizeColor(location.clip.color), next)) return
      run(createUpdateAnyClipCommand(clipId, { color: next }, '调整调色'))
    },
    applyColorToAll: (color) => {
      const state = get()
      if (isMainLocked(state.project)) {
        state.notify('主轨已锁定，请先解锁', 'warning')
        return
      }
      const preview = applyColorToAllClips(state.project, color)
      if (preview.applied === 0) {
        state.notify('所有片段已经是这组调色参数', 'info')
        return
      }
      if (run(createSetColorAllCommand(normalizeColor(color)))) {
        state.notify(`已应用到 ${preview.applied} 个片段`, 'success')
      }
    },
    setCanvasBackground: (background) => {
      run(createSetCanvasBackgroundCommand(background))
    },
    setClipBackground: (ids, background) => {
      const state = get()
      const targets = ids.filter((id) => {
        const location = findClipLocation(state.project, id)
        if (!location) return false
        return !(location.track
          ? isOverlayLocked(location.track)
          : isMainLocked(state.project))
      })
      if (targets.length === 0) return
      run(createSetClipBackgroundCommand(targets, background))
    },
    applyBackgroundToAll: (background) => {
      const state = get()
      const ids = selectableOrder(state.project)
      // 先在工程级写入，再用同一份背景覆盖所有片段（黑场则清掉片段级覆盖）。
      const normalized = normalizeBackground(background)
      const command: EditorCommand = {
        label: '背景应用到全部',
        execute(project) {
          const next = createSetCanvasBackgroundCommand(normalized).execute(project)
          if (normalized.type === 'black') {
            const strip = (clip: Clip): Clip => {
              const { background: _removed, ...rest } = clip
              return rest
            }
            return {
              ...next,
              clips: next.clips.map(strip),
              overlayTracks: (next.overlayTracks ?? []).map((track) => ({
                ...track,
                clips: track.clips.map(strip),
              })),
            }
          }
          return createSetClipBackgroundCommand(ids, normalized).execute(next)
        },
      }
      run(command)
    },
    setTransition: (clipId, type, duration) => {
      const state = get()
      const index = state.project.clips.findIndex((clip) => clip.id === clipId)
      if (index < 0) return
      if (isMainLocked(state.project)) {
        state.notify('主轨已锁定，请先解锁', 'warning')
        return
      }
      const clip = state.project.clips[index]
      const next = state.project.clips[index + 1] ?? null

      // 清除转场
      if (type === null) {
        if (!clip.transitionOut) return
        run(
          createUpdateAnyClipCommand(
            clipId,
            { transitionOut: undefined },
            '移除转场',
          ),
        )
        return
      }

      if (!next) {
        state.notify('转场需要相邻的下一个片段', 'warning')
        return
      }
      if (Math.max(0, next.gapBefore ?? 0) > 0.0001) {
        state.notify('两段之间存在空隙，先移除空隙才能加转场', 'warning')
        return
      }
      const limit = maxTransitionDuration(clip, next)
      if (limit <= 0) {
        state.notify('两侧片段太短，放不下转场', 'warning')
        return
      }
      const wanted = duration ?? clip.transitionOut?.duration ?? TRANSITION_MIN_DURATION * 2
      const clamped = Math.min(clampTransitionDuration(wanted), limit)
      run(
        createUpdateAnyClipCommand(
          clipId,
          {
            transitionOut: {
              type: normalizeTransitionType(type),
              duration: Math.max(TRANSITION_MIN_DURATION, clamped),
            },
          },
          `转场 ${transitionLabel(normalizeTransitionType(type))} ${clamped.toFixed(1)}s`,
        ),
      )
    },
    applyClipDefaults: (clipId, patch, label) => {
      const state = get()
      const location = findClipLocation(state.project, clipId)
      if (!location) return
      if (location.track ? isOverlayLocked(location.track) : isMainLocked(state.project)) return
      run(createUpdateAnyClipCommand(clipId, patch, label))
    },
    applyTransitionToAll: (type, duration) => {
      const state = get()
      if (isMainLocked(state.project)) {
        state.notify('主轨已锁定，请先解锁', 'warning')
        return
      }
      // 先干跑一次拿到统计（命令本身是纯函数，重复计算成本可忽略）。
      const preview = applyTransitionToAllJunctions(state.project, { type, duration })
      if (preview.applied === 0) {
        state.notify('没有可应用转场的交界（空隙 / 定格 / 片段太短）', 'warning')
        return
      }
      if (run(createSetTransitionAllCommand({ type, duration }))) {
        state.notify(`已应用 ${preview.applied} 处，跳过 ${preview.skipped} 处`, 'success')
      }
    },
    closeGapBefore: (clipId) => {
      const state = get()
      const index = state.project.clips.findIndex((clip) => clip.id === clipId)
      if (index < 0) return
      if (isMainLocked(state.project)) {
        state.notify('主轨已锁定，请先解锁', 'warning')
        return
      }
      const clip = state.project.clips[index]
      if (Math.max(0, clip.gapBefore ?? 0) <= 0.0001) return
      run(createUpdateAnyClipCommand(clipId, { gapBefore: 0 }, '闭合空隙'))
    },
    splitAtPlayhead: () => {
      const state = get()
      const audio = findAudioClipLocation(state.project, state.selectedClipId)
      if (audio) {
        const availability = getAudioActionAvailability(
          state.project,
          audio.clip.id,
          state.playhead,
        )
        if (!availability.canSplit) return
        const rightId = createId('audio')
        if (
          run(
            createSplitAudioClipCommand(
              audio.track.id,
              audio.clip.id,
              state.playhead,
              rightId,
            ),
          )
        ) {
          get().notify('已在播放头分割音频片段', 'success')
        }
        return
      }
      const text = findTextClipLocation(state.project, state.selectedClipId)
      if (text) {
        if (
          !getTextActionAvailability(state.project, text.clip.id, state.playhead)
            .canSplit
        ) {
          return
        }
        const rightId = createId('text')
        if (
          run(
            createSplitTextClipCommand(
              text.track.id,
              text.clip.id,
              state.playhead,
              rightId,
            ),
          )
        ) {
          get().notify('已在播放头分割文本片段', 'success')
        }
        return
      }
      const clip = selectedClip(state.project, state.selectedClipId)
      if (!clip) return
      const location = findClipLocation(state.project, clip.id)
      if (location?.track) {
        if (
          !getActionAvailability(state.project, state.selectedClipId, state.playhead)
            .canSplit
        ) {
          return
        }
        const rightId = createId('clip')
        if (
          run(
            createSplitOverlayClipCommand(
              location.track.id,
              clip.id,
              state.playhead,
              rightId,
            ),
          )
        ) {
          get().notify('已在播放头分割叠加片段', 'success')
        }
        return
      }
      const available = getActionAvailability(state.project, state.selectedClipId, state.playhead)
      if (!available.canSplit) return
      const rightId = createId('clip')
      if (run(createSplitCommand(clip.id, state.playhead, rightId))) {
        get().notify('已在播放头分割片段', 'success')
      }
    },
    trimLeftAtPlayhead: () => {
      const state = get()
      const audio = findAudioClipLocation(state.project, state.selectedClipId)
      if (audio) {
        if (
          !getAudioActionAvailability(state.project, audio.clip.id, state.playhead)
            .canTrimLeft
        ) {
          return
        }
        run(
          createTrimAudioClipCommand(
            audio.track.id,
            audio.clip.id,
            state.playhead,
            'left',
          ),
        )
        return
      }
      const text = findTextClipLocation(state.project, state.selectedClipId)
      if (text) {
        if (
          !getTextActionAvailability(state.project, text.clip.id, state.playhead)
            .canTrimLeft
        ) {
          return
        }
        run(
          createTrimTextClipCommand(
            text.track.id,
            text.clip.id,
            state.playhead,
            'left',
          ),
        )
        return
      }
      const clip = selectedClip(state.project, state.selectedClipId)
      if (!clip) return
      const location = findClipLocation(state.project, clip.id)
      if (location?.track) {
        if (
          !getActionAvailability(state.project, state.selectedClipId, state.playhead)
            .canTrimLeft
        ) {
          return
        }
        run(
          createTrimOverlayClipCommand(
            location.track.id,
            clip.id,
            state.playhead,
            'left',
          ),
        )
        return
      }
      const available = getActionAvailability(state.project, state.selectedClipId, state.playhead)
      if (!available.canTrimLeft) return
      run(createTrimLeftCommand(clip.id, state.playhead))
    },
    trimRightAtPlayhead: () => {
      const state = get()
      const audio = findAudioClipLocation(state.project, state.selectedClipId)
      if (audio) {
        if (
          !getAudioActionAvailability(state.project, audio.clip.id, state.playhead)
            .canTrimRight
        ) {
          return
        }
        run(
          createTrimAudioClipCommand(
            audio.track.id,
            audio.clip.id,
            state.playhead,
            'right',
          ),
        )
        return
      }
      const text = findTextClipLocation(state.project, state.selectedClipId)
      if (text) {
        if (
          !getTextActionAvailability(state.project, text.clip.id, state.playhead)
            .canTrimRight
        ) {
          return
        }
        run(
          createTrimTextClipCommand(
            text.track.id,
            text.clip.id,
            state.playhead,
            'right',
          ),
        )
        return
      }
      const clip = selectedClip(state.project, state.selectedClipId)
      if (!clip) return
      const location = findClipLocation(state.project, clip.id)
      if (location?.track) {
        if (
          !getActionAvailability(state.project, state.selectedClipId, state.playhead)
            .canTrimRight
        ) {
          return
        }
        run(
          createTrimOverlayClipCommand(
            location.track.id,
            clip.id,
            state.playhead,
            'right',
          ),
        )
        return
      }
      const available = getActionAvailability(state.project, state.selectedClipId, state.playhead)
      if (!available.canTrimRight) return
      run(createTrimRightCommand(clip.id, state.playhead))
    },
    insertFreeze: () => {
      const state = get()
      const available = getActionAvailability(state.project, state.selectedClipId, state.playhead)
      if (!available.canFreeze) return
      const freezeId = createId('freeze')
      const rightSplitId = createId('clip')
      if (
        run(
          createInsertFreezeCommand(
            state.playhead,
            freezeId,
            FREEZE_DEFAULT_DURATION,
            rightSplitId,
          ),
        )
      ) {
        get().notify('已插入 3 秒定格片段', 'success')
      }
    },
    resizeFreeze: (duration) => {
      const state = get()
      const clip = selectedClip(state.project, state.selectedClipId)
      if (!clip || clip.type !== 'freeze') return
      const next = clamp(duration, FREEZE_MIN_DURATION, FREEZE_MAX_DURATION)
      if (Math.abs(next - clipTimelineDuration(clip)) < 0.001) return
      run(createResizeFreezeCommand(clip.id, next))
    },
    resizeClipEdge: (clipId, edge, delta) => {
      const state = get()
      if (!Number.isFinite(delta) || Math.abs(delta) < 0.0001) return
      const location = findClipLocation(state.project, clipId)
      if (
        !location ||
        (location.track ? isOverlayLocked(location.track) : isMainLocked(state.project))
      ) {
        return
      }
      const asset = state.assets.find((item) => item.url === location.clip.sourceUrl)
      const sourceDuration =
        asset?.duration ??
        state.source?.duration ??
        Math.max(location.clip.sourceEnd, 0.1)
      if (location.track) {
        run(
          createResizeOverlayClipEdgeCommand(
            location.track.id,
            clipId,
            edge,
            delta,
            sourceDuration,
          ),
        )
        return
      }
      run(createResizeClipEdgeCommand(clipId, edge, delta, sourceDuration))
    },
    reorderClip: (clipId, targetIndex) => {
      const state = get()
      if (!state.project.clips.some((clip) => clip.id === clipId)) return
      if (isMainLocked(state.project)) return
      if (run(createReorderClipCommand(clipId, targetIndex))) {
        const moved = findSegmentById(get().project.clips, clipId)
        if (moved) set({ playhead: moved.start })
        get().notify('已调整片段顺序', 'success')
      }
    },
    reorderOverlayClip: (trackId, clipId, targetIndex) => {
      const state = get()
      const track = (state.project.overlayTracks ?? []).find((item) => item.id === trackId)
      if (!track?.clips.some((clip) => clip.id === clipId)) return
      if (isOverlayLocked(track)) return
      if (run(createReorderOverlayClipCommand(trackId, clipId, targetIndex))) {
        const moved = findClipLocation(get().project, clipId)
        if (moved) set({ playhead: moved.segment.start })
        get().notify('已调整叠加片段顺序', 'success')
      }
    },
    moveOverlayClip: (sourceTrackId, clipId, targetTrackId, targetIndex, targetStart) => {
      if (sourceTrackId === targetTrackId) return
      const project = get().project
      const sourceTrack = (project.overlayTracks ?? []).find(
        (item) => item.id === sourceTrackId,
      )
      const targetTrack = (project.overlayTracks ?? []).find(
        (item) => item.id === targetTrackId,
      )
      if (!sourceTrack || !targetTrack) return
      if (isOverlayLocked(sourceTrack) || isOverlayLocked(targetTrack)) return
      if (
        run(
          createMoveOverlayClipCommand(
            sourceTrackId,
            clipId,
            targetTrackId,
            targetIndex,
            targetStart,
          ),
        )
      ) {
        const moved = findClipLocation(get().project, clipId)
        if (moved) set({ playhead: moved.segment.start })
        get().notify('已移动叠加片段到目标轨', 'success')
      }
    },
    moveClipToTrackAtTime: (clipId, targetTrackId, targetStart) => {
      const project = get().project
      const location = findClipLocation(project, clipId)
      if (
        location &&
        (location.track
          ? isOverlayLocked(location.track)
          : isMainLocked(project))
      ) {
        return
      }
      if (targetTrackId === null) {
        if (isMainLocked(project)) {
          get().notify('主轨已锁定，无法拖入', 'warning')
          return
        }
      } else {
        const target = (project.overlayTracks ?? []).find(
          (item) => item.id === targetTrackId,
        )
        if (!target || isOverlayLocked(target)) {
          get().notify('目标叠加轨已锁定，无法拖入', 'warning')
          return
        }
      }
      if (
        run(
          createMoveClipToTrackAtTimeCommand(
            clipId,
            targetTrackId,
            targetStart,
            get().timelineSettings.linkage,
            get().timelineSettings.mainTrackMagnet,
          ),
        )
      ) {
        const moved = findClipLocation(get().project, clipId)
        if (moved) set({ playhead: moved.segment.start })
        get().notify('已移动片段', 'success')
      }
    },
    addOverlayTrack: () => {
      const state = get()
      const tracks = state.project.overlayTracks ?? []
      if (tracks.length >= MAX_OVERLAY_TRACKS) {
        get().notify('最多 8 条视频轨（主轨 + 7 条叠加轨）', 'warning')
        return
      }
      const location = findClipLocation(state.project, state.selectedClipId)
      if (!location) {
        get().notify('时间轴为空，无法新增叠加轨', 'warning')
        return
      }
      const trackId = createId('overlay')
      if (
        run(
          createAddEmptyOverlayTrackCommand(
            trackId,
            state.selectedClipId,
          ),
        )
      ) {
        get().notify('已新增空叠加轨；拖动片段进入即可', 'success')
      }
    },
    setCoverFromFrame: (time) => {
      const state = get()
      const segment = findSegmentAt(state.project.clips, time)
      if (!segment) {
        state.notify('当前时间没有可截取的画面', 'warning')
        return
      }
      const clip = segment.clip
      const asset = state.assets.find((item) => item.url === clip.sourceUrl)
      if (!asset) {
        state.notify('该片段的素材已移除，无法截帧', 'warning')
        return
      }
      const offset = Math.max(0, time - segment.start)
      const sourceTime =
        clip.type === 'freeze'
          ? clipFreezeFrame(clip)
          : clip.sourceStart + offset * clipSpeedValue(clip)
      const { width, height } = coverCanvasSize(state)
      void captureCoverFrame(asset, sourceTime, width, height).then((dataUrl) => {
        if (!dataUrl) {
          get().notify('截帧失败：没有可用画面', 'warning')
          return
        }
        const current = get()
        applyCover({
          dataUrl,
          source: { kind: 'frame', assetId: asset.id, time },
          mode: current.project.cover?.mode ?? 'separate',
        })
      })
    },
    setCoverFromImage: (file) => {
      const allowed = ['image/jpeg', 'image/png', 'image/webp']
      if (!allowed.includes(file.type)) {
        get().notify('封面只支持 JPG / PNG / WebP 图片', 'warning')
        return
      }
      const state = get()
      const { width, height } = coverCanvasSize(state)
      void readCoverImage(file, width, height).then((dataUrl) => {
        if (!dataUrl) {
          get().notify('无法读取该图片', 'warning')
          return
        }
        const current = get()
        applyCover({
          dataUrl,
          source: { kind: 'image', name: file.name },
          mode: current.project.cover?.mode ?? 'separate',
        })
      })
    },
    setCoverMode: (mode) => {
      const state = get()
      const cover = state.project.cover
      if (!cover || cover.mode === mode) return
      run(createSetCoverCommand({ ...cover, mode }))
    },
    clearCover: () => {
      const state = get()
      if (!state.project.cover) return
      if (run(createClearCoverCommand())) state.notify('已移除封面', 'info')
    },
    moveKeyframes: (clipId, refs, delta) => {
      const state = get()
      if (refs.length === 0) return
      // 先干跑一次：被夹取到 0 或产生重复时命令返回原 project（不写历史）。
      const preview = moveKeyframesInProject(state.project, clipId, refs, delta)
      if (!preview) {
        state.notify('关键帧位置重复，已回到拖动前', 'warning')
        return
      }
      if (run(createMoveKeyframesCommand(clipId, refs, delta))) {
        state.notify(refs.length > 1 ? `已移动 ${refs.length} 个关键帧` : '已移动关键帧', 'info')
      } else {
        state.notify('关键帧位置重复，已回到拖动前', 'warning')
      }
    },
    deleteKeyframes: (clipId, refs) => {
      const state = get()
      if (refs.length === 0) return
      if (run(createRemoveKeyframesCommand(clipId, refs))) {
        state.notify(`已删除 ${refs.length} 个关键帧`, 'info')
      }
    },
    setKeyframeEasing: (refs, ease) => {
      const state = get()
      const clipId = state.selectedClipId
      if (!clipId || refs.length === 0) return
      const label =
        ease === 'linear' ? '线性' : ease === 'easeIn' ? '缓入' : ease === 'easeOut' ? '缓出'
          : ease === 'easeInOut' ? '缓入缓出' : '保持'
      if (run(createSetKeyframeEasingCommand(clipId, refs, ease))) {
        state.notify(`已设为「${label}」`, 'success')
      }
    },
    clearPropertyKeyframes: (prop) => {
      const state = get()
      const clipId = state.selectedClipId
      if (!clipId) return
      if (run(createClearPropertyKeyframesCommand(clipId, prop))) {
        state.notify('已清空该属性的关键帧', 'info')
      }
    },
    toggleKeyframe: (prop) => {
      const state = get()
      const clipId = state.selectedClipId
      if (!clipId) return
      const context = animationContextAt(state.project, clipId, state.playhead)
      if (!context) return
      const { target, t } = context
      if (!isPropertyAnimatizable(target, prop)) {
        state.notify('该属性不支持关键帧', 'warning')
        return
      }
      const clip = target.clip
      const keys = (clip.anim?.[prop] ?? []) as Keyframe[]
      const exists = keys.some((key) => Math.abs(key.t - t) <= 1e-4)
      if (exists) {
        if (run(createRemoveKeyframeCommand(clip.id, prop, t))) {
          get().notify('已删除关键帧', 'info')
        }
        return
      }
      const value = evalAnimation(keys, t, animationBaseValue(target, prop))
      if (run(createSetKeyframeCommand(clip.id, prop, t, value))) {
        get().notify('已添加关键帧', 'success')
      }
    },
    setAnimatableValue: (prop, value) => {
      const state = get()
      const clipId = state.selectedClipId
      if (!clipId) return
      const context = animationContextAt(state.project, clipId, state.playhead)
      if (!context) return
      const { target, t } = context
      if (!isPropertyAnimatizable(target, prop)) return
      const clip = target.clip
      const applyBase = () => {
        if (target.kind === 'audio') {
          if (target.trackId) {
            state.updateAudioClip(
              target.trackId,
              target.clipId,
              { volume: value },
              '调整音频音量',
            )
          }
          return
        }
        if (target.kind === 'text') {
          if (!target.trackId) return
          const patch =
            prop === 'position.x'
              ? { x: value }
              : prop === 'position.y'
                ? { y: value }
                : prop === 'scale'
                  ? { scale: value }
                  : prop === 'opacity'
                    ? { opacity: value }
                    : null
          if (patch) {
            state.updateTextClip(target.trackId, target.clipId, patch, '调整文本属性')
          }
          return
        }
        switch (prop) {
          case 'scale':
            state.setScale(value)
            return
          case 'rotation':
            state.setRotation(value)
            return
          case 'opacity':
            state.setClipOpacity(clip.id, value)
            return
          case 'position.x':
            state.setPosition(value, (clip as Clip).position.y)
            return
          case 'position.y':
            state.setPosition((clip as Clip).position.x, value)
            return
          case 'volume':
            state.setClipAudio(clip.id, { volume: value }, '调整片段音量')
            return
          default:
        }
      }
      const keys = (clip.anim?.[prop] ?? []) as Keyframe[]
      if (keys.length === 0) {
        applyBase()
        return
      }
      const atKey = keys.some((key) => Math.abs(key.t - t) <= 1e-4)
      if (atKey) {
        if (run(createSetKeyframeCommand(clip.id, prop, t, value))) {
          state.notify('已更新关键帧', 'info')
        }
        return
      }
      applyBase()
      state.notify('该属性已启用动画，此修改只在无关键帧时生效', 'warning')
    },
    moveTrack: (kind, trackId, targetDisplayIndex) => {
      run(createMoveTrackCommand(kind, trackId, targetDisplayIndex))
    },
    moveTrackBy: (kind, trackId, direction) => {
      const state = get()
      const list =
        kind === 'overlay'
          ? state.project.overlayTracks ?? []
          : kind === 'audio'
            ? state.project.audioTracks ?? []
            : state.project.textTracks ?? []
      const arrayIndex = list.findIndex((track) => track.id === trackId)
      if (arrayIndex < 0) return
      // 界面下标：叠加轨倒序，音频/文字轨同序。
      const displayIndex = displayToArrayIndex(kind, arrayIndex, list.length)
      const target = direction === 'up' ? displayIndex - 1 : displayIndex + 1
      run(createMoveTrackCommand(kind, trackId, target))
    },
    moveOverlayTrack: (trackId, direction) => {
      const state = get()
      const tracks = state.project.overlayTracks ?? []
      const index = tracks.findIndex((track) => track.id === trackId)
      if (index < 0) return
      // 边界：已在最上层 / 最下层，直接返回（不产生撤销历史）。
      const targetIndex = direction === 'up' ? index + 1 : index - 1
      if (targetIndex < 0 || targetIndex >= tracks.length) return
      if (run(createMoveOverlayTrackCommand(trackId, direction))) {
        state.notify(direction === 'up' ? '叠加轨上移一层' : '叠加轨下移一层', 'info')
      }
    },
    removeOverlayTrack: (trackId) => {
      const state = get()
      if (!(state.project.overlayTracks ?? []).some((track) => track.id === trackId)) return
      const nextSelection = state.project.clips[0]?.id ?? null
      if (run(createRemoveOverlayTrackCommand(trackId, nextSelection))) {
        get().notify('已删除叠加轨', 'info')
      }
    },
    toggleOverlayTrackVisibility: (trackId) => {
      const track = (get().project.overlayTracks ?? []).find((item) => item.id === trackId)
      if (!track) return
      const hidden = !track.hidden
      run(
        createUpdateOverlayTrackCommand(
          trackId,
          { hidden },
          hidden ? '隐藏叠加轨' : '显示叠加轨',
        ),
      )
    },
    toggleTrackFlag: (kind, trackId, flag) => {
      const state = get()
      let current = false
      if (kind === 'main') {
        current = mainTrackState(state.project)[flag]
      } else if (kind === 'overlay') {
        const track = (state.project.overlayTracks ?? []).find((item) => item.id === trackId)
        if (!track) return
        current = overlayTrackState(track)[flag]
      } else if (kind === 'audio') {
        const track = (state.project.audioTracks ?? []).find((item) => item.id === trackId)
        if (!track) return
        current = audioTrackState(track)[flag]
      } else {
        const track = (state.project.textTracks ?? []).find((item) => item.id === trackId)
        if (!track) return
        current = textTrackState(track)[flag]
      }
      const next = !current
      const labels: Record<TrackFlag, [string, string]> = {
        enabled: ['停用轨道', '启用轨道'],
        locked: ['锁定轨道', '解锁轨道'],
        hidden: ['隐藏画面', '显示画面'],
        muted: ['静音轨道', '取消静音'],
        solo: ['开启独奏', '关闭独奏'],
      }
      const label = labels[flag][next ? 0 : 1]
      const patch = { [flag]: next } as Partial<
        Record<TrackFlag, boolean>
      >
      if (kind === 'main') {
        run(createUpdateMainTrackCommand(patch, label))
      } else if (kind === 'overlay' && trackId) {
        run(createUpdateOverlayTrackCommand(trackId, patch, label))
      } else if (kind === 'audio' && trackId) {
        run(createUpdateAudioTrackCommand(trackId, patch, label))
      } else if (trackId) {
        run(createUpdateTextTrackCommand(trackId, patch, label))
      }
      if (flag === 'locked' && next) {
        const selection = get().selectedClipId
        if (!selection) return
        if (kind === 'main') {
          const location = findClipLocation(get().project, selection)
          if (location && !location.track) set({ selectedClipId: null })
        } else if (kind === 'overlay') {
          const location = findClipLocation(get().project, selection)
          if (location?.track?.id === trackId) set({ selectedClipId: null })
        } else if (kind === 'audio') {
          const audio = findAudioClipLocation(get().project, selection)
          if (audio?.track.id === trackId) set({ selectedClipId: null })
        } else {
          const text = findTextClipLocation(get().project, selection)
          if (text?.track.id === trackId) set({ selectedClipId: null })
        }
      }
    },
    addAudioTrack: () => {
      const trackId = createId('audioTrack')
      if (run(createAddAudioTrackCommand(trackId, get().selectedClipId))) {
        get().notify('已新增音频轨', 'success')
      }
    },
    removeAudioTrack: (trackId) => {
      const state = get()
      if (!(state.project.audioTracks ?? []).some((track) => track.id === trackId)) return
      const nextSelection = state.project.clips[0]?.id ?? null
      if (run(createRemoveAudioTrackCommand(trackId, nextSelection))) {
        get().notify('已删除音频轨', 'info')
      }
    },
    toggleAudioTrackVisibility: (trackId) => {
      const track = (get().project.audioTracks ?? []).find((item) => item.id === trackId)
      if (!track) return
      const hidden = !track.hidden
      run(
        createUpdateAudioTrackCommand(
          trackId,
          { hidden },
          hidden ? '隐藏音频轨' : '显示音频轨',
        ),
      )
    },
    toggleAudioTrackMuted: (trackId) => {
      const track = (get().project.audioTracks ?? []).find((item) => item.id === trackId)
      if (!track) return
      const muted = !track.muted
      run(
        createUpdateAudioTrackCommand(
          trackId,
          { muted },
          muted ? '静音音频轨' : '取消静音',
        ),
      )
    },
    setAudioTrackVolume: (trackId, volume) => {
      const track = (get().project.audioTracks ?? []).find((item) => item.id === trackId)
      if (!track) return
      const next = clamp(Number.isFinite(volume) ? volume : 1, 0, 2)
      if (Math.abs(next - track.volume) < 0.001) return
      run(createUpdateAudioTrackCommand(trackId, { volume: next }, '调整音频轨音量'))
    },
    updateAudioClip: (trackId, clipId, update, label = '调整音频片段') => {
      const location = findAudioClipLocation(get().project, clipId)
      if (!location || isAudioLocked(location.track)) return
      const duration = audioClipDuration(location.clip)
      const next: Partial<Omit<AudioClip, 'id'>> = { ...update }
      if (next.volume !== undefined) next.volume = clamp(next.volume, 0, 2)
      if (next.fadeIn !== undefined) next.fadeIn = clamp(next.fadeIn, 0, duration)
      if (next.fadeOut !== undefined) next.fadeOut = clamp(next.fadeOut, 0, duration)
      if (next.start !== undefined) next.start = Math.max(0, next.start)
      run(createUpdateAudioClipCommand(trackId, clipId, next, label))
    },
    moveAudioClip: (trackId, clipId, start) => {
      const location = findAudioClipLocation(get().project, clipId)
      if (!location || isAudioLocked(location.track)) return
      run(createMoveAudioClipCommand(trackId, clipId, start))
    },
    resizeAudioClipEdge: (trackId, clipId, edge, delta) => {
      const location = findAudioClipLocation(get().project, clipId)
      if (!location || isAudioLocked(location.track)) return
      const asset = get().assets.find((item) => item.url === location.clip.sourceUrl)
      if (!asset || !Number.isFinite(delta) || Math.abs(delta) < 0.0001) return
      run(
        createResizeAudioClipCommand(
          trackId,
          clipId,
          edge,
          delta,
          asset.duration,
        ),
      )
    },
    deleteAudioClip: (trackId, clipId) => {
      const location = findAudioClipLocation(get().project, clipId)
      if (!location || isAudioLocked(location.track)) return
      const track = location.track
      const index = track.clips.findIndex((clip) => clip.id === clipId)
      const nextSelection =
        track.clips[index + 1]?.id ??
        track.clips[index - 1]?.id ??
        get().project.clips[0]?.id ??
        null
      if (run(createRemoveAudioClipCommand(trackId, clipId, nextSelection))) {
        get().notify('已删除音频片段', 'info')
      }
    },
    addTextAtPlayhead: () => {
      const state = get()
      const trackId = state.project.textTracks?.[0]?.id ?? createId('textTrack')
      const start = Math.max(0, state.playhead)
      const clip: TextClip = {
        id: createId('text'),
        text: '输入文字',
        start,
        end: start + 3,
        x: 0.5,
        y: 0.82,
        fontSize: 0.06,
        color: '#ffffff',
        background: 'transparent',
        align: 'center',
        bold: true,
      }
      if (run(createAddTextClipCommand(trackId, clip))) {
        get().selectClip(clip.id)
        get().notify('已添加文本片段；在属性面板修改内容', 'success')
      }
    },
    addTextTrack: () => {
      const trackId = createId('textTrack')
      if (run(createAddTextTrackCommand(trackId))) {
        get().notify('已新增文本轨', 'success')
      }
    },
    removeTextTrack: (trackId) => {
      const state = get()
      if (!(state.project.textTracks ?? []).some((track) => track.id === trackId)) return
      if (run(createRemoveTextTrackCommand(trackId, null))) {
        get().notify('已删除文本轨', 'info')
      }
    },
    updateTextClip: (trackId, clipId, update, label = '修改文本') => {
      const location = findTextClipLocation(get().project, clipId)
      if (!location || isTextLocked(location.track)) return
      const next = { ...update }
      if (next.start !== undefined) next.start = Math.max(0, next.start)
      if (next.end !== undefined && next.start !== undefined) {
        next.end = Math.max(next.start + 0.2, next.end)
      }
      if (next.fontSize !== undefined) {
        next.fontSize = Math.min(0.2, Math.max(0.02, next.fontSize))
      }
      run(createUpdateTextClipCommand(trackId, clipId, next, label))
    },
    moveTextClip: (trackId, clipId, start) => {
      const location = findTextClipLocation(get().project, clipId)
      if (!location || isTextLocked(location.track)) return
      run(createMoveTextClipCommand(trackId, clipId, start))
    },
    resizeTextClipEdge: (trackId, clipId, edge, delta) => {
      const location = findTextClipLocation(get().project, clipId)
      if (!location || isTextLocked(location.track)) return
      run(createResizeTextClipCommand(trackId, clipId, edge, delta))
    },
    deleteTextClip: (trackId, clipId) => {
      const location = findTextClipLocation(get().project, clipId)
      if (!location || isTextLocked(location.track)) return
      const nextSelection =
        location.track.clips[location.index + 1]?.id ??
        location.track.clips[location.index - 1]?.id ??
        null
      if (run(createRemoveTextClipCommand(trackId, clipId, nextSelection))) {
        get().notify('已删除文本片段', 'info')
      }
    },
    importAutoCaptions: (words, options) => {
      if (words.length === 0) return 0
      const project = get().project
      const replace = options?.replace ?? false
      const clips = buildCaptionClips(project, words)
      if (clips.length === 0) {
        get().notify('没有识别到可成句的字幕', 'warning')
        return 0
      }
      if (replace) {
        // 只替换目标那一条 caption 轨（存在则复用其 id/样式/状态）。
        const target = (project.textTracks ?? []).find((track) => track.kind === 'caption')
        const trackId = target?.id ?? createId('textTrack')
        if (run(createReplaceAutoCaptionsCommand(trackId, clips))) {
          get().selectClip(clips[0].id)
          set({ playhead: Math.max(0, clips[0].start) })
          get().notify(`已生成 ${clips.length} 条智能字幕`, 'success')
          return clips.length
        }
        return 0
      }
      const captionCount = (project.textTracks ?? []).filter(
        (track) => track.kind === 'caption',
      ).length
      const trackId = createId('textTrack')
      if (
        run(
          createImportAutoCaptionsCommand(
            trackId,
            clips,
            captionCount === 0 ? '智能字幕' : `智能字幕 ${captionCount + 1}`,
          ),
        )
      ) {
        get().selectClip(clips[0].id)
        set({ playhead: Math.max(0, clips[0].start) })
        get().notify(`已生成 ${clips.length} 条智能字幕`, 'success')
        return clips.length
      }
      return 0
    },
    realignCaptions: () => {
      const words = get().asrWordsBySource
      if (!words) {
        get().notify('请先识别智能字幕，再进行重新对齐', 'warning')
        return
      }
      const project = get().project
      const urlToAssetId = new Map(get().assets.map((asset) => [asset.url, asset.id]))
      const timelineWords = mapWordsToTimeline(
        project,
        words,
        { includeOverlay: false, includeAudio: true },
        urlToAssetId,
      )
      if (timelineWords.length === 0) {
        get().notify('没有可重新对齐的字幕', 'warning')
        return
      }
      const clips = buildCaptionClips(project, timelineWords)
      if (clips.length === 0) {
        get().notify('没有可重新对齐的字幕', 'warning')
        return
      }
      const target = (project.textTracks ?? []).find((track) => track.kind === 'caption')
      // 保留用户手改过的文字，只更新时间。
      const merged = target
        ? mergeRelinkedCaptions(target.clips, clips)
        : clips
      const trackId = target?.id ?? createId('textTrack')
      if (run(createReplaceAutoCaptionsCommand(trackId, merged))) {
        get().selectClip(merged[0].id)
        set({ playhead: Math.max(0, merged[0].start) })
        get().notify('已重新对齐字幕', 'success')
      }
    },
    updateCaptionStyle: (trackId, clipId, patch, applyAll, label) => {
      const project = get().project
      const track = (project.textTracks ?? []).find((item) => item.id === trackId)
      if (!track) return
      if (applyAll) {
        const base = captionStyleForTrack(track) ?? {}
        run(createUpdateCaptionTrackStyleCommand(trackId, { ...base, ...patch }, label))
        return
      }
      if (!clipId) return
      const clip = track.clips.find((item) => item.id === clipId)
      if (!clip) return
      const base = clip.styleOverride ?? {}
      run(createUpdateCaptionClipStyleCommand(trackId, clipId, { ...base, ...patch }, label))
    },
    editCaptionText: (clipId, text) => {
      const location = findTextClipLocation(get().project, clipId)
      if (!location) return
      const clip = location.clip
      if (clip.text === text) return
      run(
        createUpdateTextClipCommand(
          location.track.id,
          clipId,
          { text, words: undefined, edited: true },
          '修改字幕文字',
        ),
      )
    },
    splitCaption: (clipId, cursorIndex) => {
      const location = findTextClipLocation(get().project, clipId)
      if (!location) return
      const parts = splitCaptionText(location.clip, cursorIndex)
      if (!parts.leftText || !parts.rightText) return
      const rightId = createId('text')
      if (run(createSplitCaptionCommand(location.track.id, clipId, parts, rightId))) {
        get().selectClip(rightId)
      }
    },
    mergeCaptionUp: (clipId) => {
      const location = findTextClipLocation(get().project, clipId)
      if (!location || location.index === 0) return
      run(createMergeCaptionWithPreviousCommand(location.track.id, clipId))
    },
    replaceCaptionText: (trackId, find, replace) => {
      if (!find) return
      run(createReplaceCaptionTextCommand(trackId, find, replace))
    },
    replaceCaptionTextInClip: (clipId, find, replace) => {
      if (!find) return
      const location = findTextClipLocation(get().project, clipId)
      if (!location) return
      if (!location.clip.text.includes(find)) return
      run(
        createUpdateTextClipCommand(
          location.track.id,
          clipId,
          { text: location.clip.text.split(find).join(replace), words: undefined, edited: true },
          '替换当前字幕文字',
        ),
      )
    },
    importSubtitles: (cues) => {
      if (cues.length === 0) return
      const state = get()
      const trackId = state.project.textTracks?.[0]?.id ?? createId('textTrack')
      const clips = cues.map((cue) => cueToTextClip(cue, createId('text')))
      if (
        run(createImportSubtitlesCommand(trackId, clips)) &&
        clips.length > 0
      ) {
        get().selectClip(clips[0].id)
        set({ playhead: Math.max(0, cues[0].start) })
        get().notify(`已导入 ${clips.length} 条字幕`, 'success')
      }
    },
    rotateSelected: (delta) => {
      const state = get()
      const clip = selectedClip(state.project, state.selectedClipId)
      if (!clip) return
      const angle = normalizeAngle(clip.rotation + delta)
      run(createUpdateAnyClipCommand(clip.id, { rotation: angle }, '旋转画面'))
    },
    setRotation: (angle) => {
      const state = get()
      const clip = selectedClip(state.project, state.selectedClipId)
      if (!clip) return
      // 角度是环形的：-180 再逆时针 90° 应是 90，而不是被 clamp 卡在 -180。
      const next = normalizeAngle(Number.isFinite(angle) ? angle : 0)
      if (Math.abs(next - clip.rotation) < 0.001) return
      run(createUpdateAnyClipCommand(clip.id, { rotation: next }, '调整旋转角度'))
    },
    resetRotation: () => {
      const state = get()
      const clip = selectedClip(state.project, state.selectedClipId)
      if (!clip || clip.rotation === 0) return
      run(createUpdateAnyClipCommand(clip.id, { rotation: 0 }, '重置旋转'))
    },
    toggleFlipH: () => {
      const state = get()
      const clip = selectedClip(state.project, state.selectedClipId)
      if (!clip) return
      run(createUpdateAnyClipCommand(clip.id, { flipH: !clip.flipH }, '水平镜像'))
    },
    toggleFlipV: () => {
      const state = get()
      const clip = selectedClip(state.project, state.selectedClipId)
      if (!clip) return
      run(createUpdateAnyClipCommand(clip.id, { flipV: !clip.flipV }, '垂直镜像'))
    },
    setScale: (scale) => {
      const state = get()
      const clip = selectedClip(state.project, state.selectedClipId)
      if (!clip) return
      const next = clamp(scale, SCALE_MIN, SCALE_MAX)
      if (Math.abs(next - clip.scale) < 0.001) return
      run(createUpdateAnyClipCommand(clip.id, { scale: next }, '调整画面缩放'))
    },
    fitSelected: () => {
      const state = get()
      const clip = selectedClip(state.project, state.selectedClipId)
      if (!clip || Math.abs(clip.scale - 1) < 0.001) return
      run(createUpdateAnyClipCommand(clip.id, { scale: 1 }, '画面适应'))
    },
    fillSelected: () => {
      const state = get()
      const clip = selectedClip(state.project, state.selectedClipId)
      // 叠加片段的素材可能不同于主素材：优先用片段自己的资产算填充比例。
      const source =
        state.assets.find((asset) => asset.url === clip?.sourceUrl) ?? state.source
      if (!clip || !source) return
      const scale = fillScaleFor(
        clip,
        source,
        aspectValue(state.project.aspectRatio, source),
      )
      if (Math.abs(scale - clip.scale) < 0.001) return
      run(createUpdateAnyClipCommand(clip.id, { scale }, '画面填充'))
    },
    setPosition: (x, y) => {
      const state = get()
      const clip = selectedClip(state.project, state.selectedClipId)
      if (!clip) return
      const nextX = clamp(Number.isFinite(x) ? x : 0, -2, 2)
      const nextY = clamp(Number.isFinite(y) ? y : 0, -2, 2)
      if (Math.abs(nextX - clip.position.x) < 0.0005 && Math.abs(nextY - clip.position.y) < 0.0005) {
        return
      }
      run(createUpdateAnyClipCommand(clip.id, { position: { x: nextX, y: nextY } }, '移动画面'))
    },
    resetPosition: () => {
      const state = get()
      const clip = selectedClip(state.project, state.selectedClipId)
      if (!clip || (clip.position.x === 0 && clip.position.y === 0)) return
      run(createUpdateAnyClipCommand(clip.id, { position: { x: 0, y: 0 } }, '重置画面位置'))
    },
    beginCrop: () => {
      const state = get()
      const location = findClipLocation(state.project, state.selectedClipId)
      if (!location) return
      const clip = location.clip
      // 叠加轨也支持画面裁剪（与主轨同一套 CropRect）。
      if (location.track ? isOverlayLocked(location.track) : isMainLocked(state.project)) return
      const segment = location.segment
      const local = state.playhead - segment.start
      const playhead =
        local <= 0 || local >= segment.duration ? segment.start : segment.start + local
      set({
        isPlaying: false,
        previewPatch: null,
        playhead,
        cropSession: { clipId: clip.id, draft: { ...clip.crop }, preset: 'free' },
        markerEditorId: null,
      })
    },
    updateCropDraft: (crop) => {
      const session = get().cropSession
      if (!session) return
      set({ cropSession: { ...session, draft: clampCrop(crop) } })
    },
    applyCropPreset: (preset) => {
      const state = get()
      const session = state.cropSession
      if (!session) return
      // 用被裁片段自身的素材尺寸（叠加轨片段不一定等于主素材）。
      const location = findClipLocation(state.project, session.clipId)
      const asset = location
        ? state.assets.find((item) => item.url === location.clip.sourceUrl)
        : undefined
      const width = asset?.width ?? state.source?.width ?? 0
      const height = asset?.height ?? state.source?.height ?? 0
      if (!width || !height) return
      const sourceRatio = width / height
      const definition = CROP_PRESETS.find((item) => item.id === preset)
      let target: number | null = null
      if (preset === 'original') target = sourceRatio
      else if (preset !== 'free' && definition) {
        const [w, h] = definition.label.split(':').map(Number)
        if (w > 0 && h > 0) target = w / h
      }
      const draft = cropRectForAspect(sourceRatio, target)
      set({ cropSession: { ...session, draft, preset } })
    },
    commitCrop: () => {
      const state = get()
      const session = state.cropSession
      if (!session) return
      const crop = clampCrop(session.draft)
      const changed = run(
        createUpdateAnyClipCommand(session.clipId, { crop }, '确认画面裁剪'),
      )
      set({ cropSession: null })
      if (changed) get().notify('画面裁剪已应用', 'success')
    },
    cancelCrop: () => set({ cropSession: null }),
    addMarker: () => {
      const state = get()
      const total = getProjectEnd(state.project)
      if (total <= 0) return
      const time = clamp(state.playhead, 0, total)
      const existing = state.project.markers.find((marker) => Math.abs(marker.time - time) < 0.03)
      if (existing) {
        set({ markerEditorId: existing.id })
        get().notify('该位置已有标记', 'info')
        return
      }
      const marker: Marker = {
        id: createId('marker'),
        time,
        color: MARKER_COLORS[state.project.markers.length % MARKER_COLORS.length],
        note: '',
      }
      if (run(createAddMarkerCommand(marker))) {
        get().notify('已添加标记', 'success')
      }
    },
    updateMarker: (marker) => {
      const state = get()
      const existing = state.project.markers.find((item) => item.id === marker.id)
      if (!existing) return
      if (
        existing.color === marker.color &&
        existing.note === marker.note &&
        Math.abs(existing.time - marker.time) < 0.0001
      ) {
        return
      }
      run(createUpdateMarkerCommand(marker))
    },
    deleteMarker: (id) => {
      if (!get().project.markers.some((marker) => marker.id === id)) return
      if (run(createDeleteMarkerCommand(id))) {
        set({ markerEditorId: null })
        get().notify('已删除标记', 'info')
      }
    },
    setAspectRatio: (aspectRatio) => {
      const state = get()
      if (state.project.aspectRatio === aspectRatio) return
      run(createSetAspectRatioCommand(aspectRatio))
    },
    setExportQuality: (quality) => {
      const state = get()
      if (
        state.project.exportQuality.resolution === quality.resolution &&
        state.project.exportQuality.fps === quality.fps
      ) {
        return
      }
      run(createSetExportQualityCommand(quality))
    },
    reverseClip: (clipId) => {
      const state = get()
      const location = findClipLocation(state.project, clipId)
      if (!location) return
      const clip = location.clip
      const locked = location.track
        ? isOverlayLocked(location.track)
        : isMainLocked(state.project)
      // 工具栏与右键菜单共用同一套可用性判断，这里再兜一层（防止并发状态）。
      const action = reverseActionState({
        clip,
        assets: state.assets,
        locked,
        cropping: Boolean(state.cropSession),
        busy: Boolean(state.reverseJob),
      })
      if (!action.enabled) {
        state.notify(action.reason, 'warning')
        return
      }

      // 片段已经处于倒放状态：立即换回原素材与原始区间（不跑 FFmpeg，一步撤销）。
      if (action.reversed) {
        const plan = planReverseRestore({ clip, assets: state.assets })
        if (!plan) {
          // 纯函数返回 null = 不应该产生任何改动（原素材已不在素材库）。
          state.notify('原素材已删除，无法恢复正放', 'warning')
          return
        }
        const linked = countLinkedCaptions(state.project, clipId)
        const changed = run(createReverseClipCommand(plan.input))
        if (!changed) {
          state.notify('取消倒放失败：片段不存在', 'warning')
          return
        }
        const base = `已取消倒放，画面恢复为「${plan.originalAsset.name}」`
        if (linked > 0) {
          get().notify(`${base}；已断开 ${linked} 条智能字幕链接，请重新对齐`, 'warning')
        } else {
          get().notify(`${base}，可 Ctrl+Z 撤销`, 'success')
        }
        return
      }

      const asset = state.assets.find((item) => item.url === clip.sourceUrl)
      if (!asset) {
        state.notify('该片段的素材已移除，无法倒放', 'warning')
        return
      }
      // 以「未裁剪的源区间」为准：变速/裁剪不改变要倒放的内容。
      const sourceStart = Math.max(0, clip.sourceStart)
      const sourceEnd = Math.max(sourceStart, clip.sourceEnd)
      const span = sourceEnd - sourceStart
      if (reverseChunks(sourceStart, sourceEnd).length === 0) {
        state.notify('片段太短，无法倒放', 'warning')
        return
      }
      if (
        needsReverseConfirm(span) &&
        typeof window !== 'undefined' &&
        !window.confirm(
          `倒放 ${span.toFixed(1)} 秒需要逐段重编码，可能耗时较长（与素材分辨率、时长有关）。继续吗？`,
        )
      ) {
        return
      }

      const origin = reverseAssetOrigin(asset, sourceStart, sourceEnd)
      /** 把片段换成倒放素材（1 个命令 = 1 步撤销），并提示字幕链接的变化。 */
      const finish = (target: MediaAsset, reused: boolean) => {
        const current = get()
        const locationNow = findClipLocation(current.project, clipId)
        if (!locationNow) {
          current.notify(
            `${reused ? '已复用' : '已生成'}倒放素材「${target.name}」，但片段已被删除`,
            'info',
          )
          return
        }
        // 倒放期间片段被改动（裁剪 / 换素材）：不覆盖用户的改动，素材仍留在素材库。
        const clipNow = locationNow.clip
        if (
          clipNow.sourceUrl !== asset.url ||
          Math.abs(clipNow.sourceStart - sourceStart) > 1e-3 ||
          Math.abs(clipNow.sourceEnd - sourceEnd) > 1e-3
        ) {
          current.notify(
            `片段在倒放期间被改动，未替换画面；倒放素材「${target.name}」已保留在素材库`,
            'info',
          )
          return
        }
        const linked = countLinkedCaptions(current.project, clipId)
        const limit = target.duration > 0 ? Math.min(span, target.duration) : span
        const changed = run(
          createReverseClipCommand({
            clipId,
            sourceUrl: target.url,
            sourceStart: 0,
            sourceEnd: limit,
            // 用片段**当前**的关键帧镜像（生成期间用户可能改过），而不是任务开始时的快照。
            // 淡入/淡出由命令内部按执行时的片段对调，同样不会覆盖期间的手改。
            anim: mirrorAnimationTimes(clipNow.anim),
            label: '倒放片段',
          }),
        )
        if (!changed) {
          current.notify('倒放失败：片段不存在', 'warning')
          return
        }
        const base = `${reused ? '已复用' : '已生成'}倒放素材「${target.name}」`
        if (linked > 0) {
          // 字幕链接已在同一个命令里断开：必须明确提示，避免字幕静默错位。
          get().notify(
            `${base}；已断开 ${linked} 条智能字幕链接，请重新对齐字幕时间`,
            'warning',
          )
        } else {
          get().notify(`${base}，可 Ctrl+Z 撤销`, 'success')
        }
      }

      // 同一片段、同一源区间重复倒放：直接复用已有素材，不重复生成。
      const existing = state.assets.find((item) => matchesReverseOrigin(item, origin))
      if (existing) {
        finish(existing, true)
        return
      }

      const controller = new AbortController()
      internals.setReverseController(controller)
      /** 任务开始时的工程 id：切换工程后晚到的结果一律丢弃。 */
      const ownerProjectId = state.projectId
      const updateJob = (patch: Partial<ReverseJob>): void => {
        set((current) =>
          current.reverseJob ? { reverseJob: { ...current.reverseJob, ...patch } } : {},
        )
      }
      set({
        reverseJob: { clipId, assetName: asset.name, progress: 0, status: '准备中…' },
        isPlaying: false,
      })
      void (async () => {
        /**
         * 每个 await 之后都要校验：任务是否已被取消、是否已被新任务替换、
         * 工程是否已切换。命中就把已经产生的临时结果清理掉，绝不写进工程/素材库/IndexedDB。
         */
        const stale = (): boolean =>
          controller.signal.aborted ||
          internals.getReverseController() !== controller ||
          get().projectId !== ownerProjectId
        let createdUrl: string | null = null
        let savedAssetId: string | null = null
        const discard = async (): Promise<void> => {
          if (createdUrl) {
            try {
              URL.revokeObjectURL(createdUrl)
            } catch {
              // URL 已失效时忽略。
            }
            createdUrl = null
          }
          if (savedAssetId) {
            await deleteMediaBlob(savedAssetId).catch(() => undefined)
            savedAssetId = null
          }
        }
        try {
          const file = await reverseAssetSpan({
            asset,
            sourceStart,
            sourceEnd,
            signal: controller.signal,
            onProgress: (progress) => updateJob({ progress }),
            onStatus: (status) => updateJob({ status }),
            onWarning: (message) => get().notify(message, 'warning'),
          })
          if (stale()) {
            await discard()
            return
          }
          const created = await readAssetFile(file)
          createdUrl = created.url
          if (stale()) {
            await discard()
            return
          }
          const newAsset: MediaAsset = { ...created, reversedFrom: origin }
          // 持久化到 IndexedDB：刷新草稿后倒放素材还在（与导入本地素材的做法一致）。
          // 失败不阻断本次会话，但必须提示（否则用户以为刷新后还在）。
          savedAssetId = newAsset.id
          await saveMediaBlob(newAsset.id, file).catch(() => {
            savedAssetId = null
            get().notify('倒放素材未能保存到本地，刷新页面后可能需要重新倒放', 'warning')
          })
          if (stale()) {
            await discard()
            return
          }
          savedAssetId = null
          set({ reverseJob: null })
          get().addAssets([newAsset])
          finish(newAsset, false)
        } catch (error) {
          set({ reverseJob: null })
          await discard()
          if (isReverseAbort(error)) {
            get().notify('已取消倒放，工程未改动', 'info')
          } else {
            get().notify(
              `倒放失败：${error instanceof Error ? error.message : String(error)}`,
              'warning',
            )
          }
        } finally {
          if (internals.getReverseController() === controller) internals.setReverseController(null)
          if (get().reverseJob) set({ reverseJob: null })


        }
      })()
    },
  }
}
