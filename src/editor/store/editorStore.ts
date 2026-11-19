import { createStore } from 'zustand/vanilla'
import { aspectValue } from '../core/aspect'
import { CROP_PRESETS, type CropPresetId } from '../core/constants'
import {
  createAddAudioClipCommand,
  createAddAudioTrackCommand,
  createAddClipCommand,
  createAddMarkerCommand,
  createAddEmptyOverlayTrackCommand,
  createAddTextClipCommand,
  createAddTextTrackCommand,
  createImportAutoCaptionsCommand,
  createImportSubtitlesCommand,
  createReplaceAutoCaptionsCommand,
  createDeleteClipCommand,
  createDeleteMarkerCommand,
  createDeleteOverlayClipCommand,
  createInsertFreezeCommand,
  createMoveAudioClipCommand,
  createMoveOverlayClipCommand,
  createMoveClipToTrackAtTimeCommand,
  createMoveTextClipCommand,
  createRemoveAudioClipCommand,
  createRemoveAudioTrackCommand,
  createRemoveOverlayTrackCommand,
  createRemoveTextClipCommand,
  createRemoveTextTrackCommand,
  createReorderClipCommand,
  createReorderOverlayClipCommand,
  createResizeAudioClipCommand,
  createResizeClipEdgeCommand,
  createResizeFreezeCommand,
  createResizeOverlayClipEdgeCommand,
  createResizeTextClipCommand,
  createSetAspectRatioCommand,
  createSetExportQualityCommand,
  createSplitAudioClipCommand,
  createSplitCommand,
  createSetTransitionAllCommand,
  createSetColorAllCommand,
  createPasteVisualAttributesCommand,
  createPasteAudioAttributesCommand,
  createMoveOverlayTrackCommand,
  createSplitOverlayClipCommand,
  createSplitTextClipCommand,
  createTrimAudioClipCommand,
  createTrimLeftCommand,
  createTrimOverlayClipCommand,
  createTrimRightCommand,
  createTrimTextClipCommand,
  createUpdateAudioClipCommand,
  createUpdateAudioTrackCommand,
  createUpdateAnyClipCommand,
  createUpdateMainTrackCommand,
  createUpdateMarkerCommand,
  createUpdateOverlayTrackCommand,
  createUpdateCaptionClipStyleCommand,
  createUpdateCaptionTrackStyleCommand,
  createReplaceCaptionTextCommand,
  createMergeCaptionWithPreviousCommand,
  createSplitCaptionCommand,
  createRelinkCaptionsCommand,
  createUpdateTextClipCommand,
  createUpdateTextTrackCommand,
} from '../core/commands'
import type { EditorCommand } from '../core/commands'
import type { DraftSettings } from '../core/draft'
import { HistoryStack } from '../core/history'
import {
  clampCrop,
  createEmptyProject,
  createInitialProject,
  applyTransitionToAllJunctions,
  applyColorToAllClips,
  applyAttributePatch,
  normalizeAngle,
} from '../core/operations'
import { createId } from '../core/ids'
import {
  audioClipDuration,
  findAudioClipLocation,
  getAudioActionAvailability,
} from '../core/audio'
import {
  captionStyleForTrack,
  cueToCaptionClip,
  cueToTextClip,
  findTextClipLocation,
  getTextActionAvailability,
  type SubtitleCue,
} from '../core/text'
import { buildCaptionsFromWords, splitCaptionText } from '../core/captions'
import { IMAGE_DEFAULT_DURATION } from '../core/image'
import { normalizeBackground } from '../core/background'
import { clampSpeed, canChangeClipSpeed } from '../core/speed'
import {
  clampTransitionDuration,
  maxTransitionDuration,
  normalizeTransitionType,
  transitionLabel,
  TRANSITION_MIN_DURATION,
} from '../core/transition'
import { isSameColor, normalizeColor, type ColorAdjustments } from '../core/color'
import {
  captureAudioAttrs,
  captureVisualAttrs,
  getAudio as getAudioAttrs,
  getVisual as getVisualAttrs,
  setAudio as setAudioAttrs,
  setVisual as setVisualAttrs,
} from '../core/attributeClipboard'
import {
  blendModeLabel,
  clipBlendMode,
  clipOpacity,
  normalizeBlendMode,
} from '../core/blend'
import { clipTimelineDuration } from '../core/clipTime'
import {
  buildClipboardPayload,
  planPaste,
  type ClipboardPayload,
  type IdFactory,
} from '../core/clipboard'
import {
  normalizeSelection,
  planBatchMove,
  primaryOf,
  rangeSelection,
  toggleSelection,
} from '../core/selection'
import { createDeleteManyCommand, createDetachAudioCommand, createMoveManyCommand, createPasteCommand, createSetCanvasBackgroundCommand, createSetClipBackgroundCommand } from '../core/commands'
import {
  collectEditPoints,
  fitZoom,
  nextEditPoint,
  stepByFrames,
  stepBySeconds,
} from '../core/playhead'
import { mapWordsToTimeline } from '../core/captionMapping'
import { mergeRelinkedCaptions, relinkCaptions } from '../core/captionLink'
import type { TimelineWord, WordsBySource } from '../core/captionMapping'
import {
  audioTrackState,
  isAudioLocked,
  isMainLocked,
  isOverlayLocked,
  isTextLocked,
  mainTrackState,
  overlayTrackState,
  textTrackState,
  type TrackFlag,
  type TrackKind,
} from '../core/tracks'
import {
  fillScaleFor,
  cropRectForAspect,
} from '../core/geometry'
import {
  clamp,
  findClipLocation,
  findSegmentById,
  getActionAvailability,
  getProjectEnd,
  getTimeline,
  snapToMarker,
} from '../core/timeline'
import {
  FREEZE_DEFAULT_DURATION,
  FREEZE_MAX_DURATION,
  FREEZE_MIN_DURATION,
  MARKER_COLORS,
  MAX_OVERLAY_TRACKS,
  SCALE_MAX,
  SCALE_MIN,
  TIMELINE_DEFAULT_ZOOM,
  TIMELINE_MAX_ZOOM,
  TIMELINE_MIN_ZOOM,
} from '../core/constants'
import type {
  AspectRatioPreset,
  AudioClip,
  BlendMode,
  CanvasBackground,
  TransitionType,
  CaptionStyle,
  Clip,
  CropRect,
  ExportQuality,
  Marker,
  MediaAsset,
  Project,
  SourceInfo,
  TextClip,
} from '../core/types'

/** 时间轴上的可选中片段顺序（主轨 → 叠加轨 → 音频轨 → 文本轨，各按时间排序）。 */
function selectableOrder(project: Project): string[] {
  const ids: string[] = []
  for (const segment of getTimeline(project.clips)) ids.push(segment.clip.id)
  for (const track of project.overlayTracks ?? []) {
    for (const segment of getTimeline(track.clips)) ids.push(segment.clip.id)
  }
  for (const track of project.audioTracks ?? []) {
    for (const clip of track.clips) ids.push(clip.id)
  }
  for (const track of project.textTracks ?? []) {
    for (const clip of track.clips) ids.push(clip.id)
  }
  return ids
}

export interface CropSession {
  clipId: string
  draft: CropRect
  preset: CropPresetId
}

/**
 * 临时预览通道：拖动滑块时的即时反馈，**不写历史、不改 project**。
 * 松手时由 onCommit 走命令写入，因此一次拖动只产生 1 条撤销记录。
 */
export interface PreviewPatch {
  /** 目标片段 id；纯轨道级 / 工程级预览时可以省略。 */
  clipId?: string
  patch: Partial<Clip>
  /** 音频轨音量的临时预览（拖动轨道音量滑块）。 */
  trackVolume?: { trackId: string; volume: number }
  /** 画布背景的临时预览（拖动背景模糊强度等）。 */
  canvasBackground?: CanvasBackground
}

export interface TimelineSettings {
  mainTrackMagnet: boolean
  autoSnap: boolean
  linkage: boolean
  previewAxis: boolean
}

export type TimelineSettingKey = keyof TimelineSettings

export type ToastKind = 'info' | 'success' | 'warning' | 'error'

export interface ToastMessage {
  id: number
  kind: ToastKind
  message: string
}

export interface EditorState {
  project: Project
  source: SourceInfo | null
  assets: MediaAsset[]
  selectedClipId: string | null
  /** 多选集合；`selectedClipId` 始终是其中的「主选中」（派生值）。 */
  selectedIds: string[]
  /** 剪贴板内容（不持久化，属于会话状态）。 */
  clipboard: ClipboardPayload
  /** Ctrl/⌘ 点击：切换选中。 */
  toggleSelectClip: (id: string) => void
  /** Shift 点击：按锚点做区间选择。 */
  rangeSelectClip: (id: string) => void
  /** 时间区间框选（null 表示清空）。 */
  selectIds: (ids: string[]) => void
  selectAll: () => void
  copySelection: () => void
  cutSelection: () => void
  pasteAtPlayhead: () => void
  /** 批量移动选中片段（一个命令）。 */
  moveSelectionBy: (delta: number) => void
  /** 修改片段音频参数（一个命令）。 */
  setClipAudio: (
    clipId: string,
    patch: Partial<Pick<Clip, 'volume' | 'fadeIn' | 'fadeOut'>>,
    label: string,
  ) => void
  /** 分离音频：抽出为音频轨片段并把画面片段静音。 */
  detachAudio: (clipId: string) => void
  /** 设置片段倍率与是否保持音调（一个命令）。 */
  setClipSpeed: (clipId: string, speed: number, keepPitch: boolean) => void
  /** 设置不透明度（0–1，一个命令）。 */
  setClipOpacity: (clipId: string, opacity: number) => void
  /** 设置混合模式（一个命令）。 */
  setClipBlendMode: (clipId: string, mode: BlendMode) => void
  /** 设置片段调色（一个命令）。 */
  setClipColor: (clipId: string, color: ColorAdjustments) => void
  /** 把一组调色参数应用到所有画面片段（一个命令）。 */
  applyColorToAll: (color: ColorAdjustments) => void
  /** 调色剪贴板：「复制当前设置」后供其他片段「粘贴调色」。 */
  colorClipboard: ColorAdjustments | null
  copyClipColor: (clipId: string) => void
  pasteClipColor: (clipId: string) => void
  /** 设置/清除片段尾部转场（一个命令）。 */
  setTransition: (clipId: string, type: TransitionType | null, duration?: number) => void
  /** 把同一种转场应用到主轨所有可用交界（一个命令，跳过空隙/定格/太短的交界）。 */
  applyTransitionToAll: (type: TransitionType, duration: number) => void
  /** 闭合该片段与上一段之间的空隙：gapBefore 归零（一个命令）。 */
  closeGapBefore: (clipId: string) => void
  /** 把一组属性重置为默认值（一个命令，1 步撤销）。 */
  applyClipDefaults: (clipId: string, patch: Partial<Clip>, label: string) => void
  /** 复制画面属性到模块级属性剪贴板（不进撤销栈）。 */
  copyVisualAttributes: (clipId: string) => void
  /** 把画面属性粘贴到一组片段（一个命令，多选时 1 步撤销）。 */
  pasteVisualAttributes: (ids: string[]) => void
  /** 复制音频属性（音量 / 淡入淡出）到模块级属性剪贴板。 */
  copyAudioAttributes: (clipId: string) => void
  /** 把音频属性粘贴到一组片段（一个命令）。 */
  pasteAudioAttributes: (ids: string[]) => void
  /** 设置工程级画布背景（一个命令）。 */
  setCanvasBackground: (background: CanvasBackground) => void
  /** 给指定片段设置背景覆盖（一个命令）。 */
  setClipBackground: (ids: string[], background: CanvasBackground) => void
  /** 把工程级背景同步到所有片段（清掉片段级覆盖，一个命令）。 */
  applyBackgroundToAll: (background: CanvasBackground) => void
  playhead: number
  isPlaying: boolean
  timelineZoom: number
  /** 时间轴可视区宽度（px），由 Timeline 组件测量后回填，用于「适应窗口」。 */
  timelineViewportWidth: number
  /** 全屏预览开关（F 进入，Esc 退出）。 */
  previewFullscreen: boolean
  setPreviewFullscreen: (fullscreen: boolean) => void
  timelineSettings: TimelineSettings
  cropSession: CropSession | null
  previewPatch: PreviewPatch | null
  markerEditorId: string | null
  exportDialogOpen: boolean
  canUndo: boolean
  canRedo: boolean
  lastAction: string
  toast: ToastMessage | null

  loadSource: (source: SourceInfo) => void
  hydrateDraft: (draft: {
    project: Project
    assets: MediaAsset[]
    source: SourceInfo | null
    timelineZoom: number
    timelineSettings: DraftSettings
    playhead: number
  }) => void
  addAssets: (assets: MediaAsset[]) => void
  addAssetToTimeline: (
    assetId: string,
    targetTrackId: string | null,
    targetStart: number,
  ) => void
  clearSource: () => void
  updateSourceMeta: (patch: Partial<SourceInfo>) => void
  execute: (command: EditorCommand) => boolean
  undo: () => void
  redo: () => void

  selectClip: (id: string | null) => void
  setPlayhead: (time: number, snapThreshold?: number) => void
  /** 相对当前位置逐帧移动（按项目 fps）。 */
  stepPlayheadFrames: (frames: number) => void
  /** 相对当前位置按秒移动。 */
  nudgePlayhead: (seconds: number) => void
  /** 跳到上/下一个剪辑点（片段边界 + 标记）。 */
  jumpToEditPoint: (direction: 'prev' | 'next') => void
  /** 时间轴适应窗口。 */
  zoomToFit: () => void
  setTimelineViewportWidth: (width: number) => void
  setPlaying: (playing: boolean) => void
  togglePlay: () => void
  replay: () => void
  finishPlayback: () => void
  setTimelineZoom: (zoom: number) => void
  toggleTimelineSetting: (key: TimelineSettingKey) => void

  setPreviewPatch: (patch: PreviewPatch | null) => void
  splitAtPlayhead: () => void
  trimLeftAtPlayhead: () => void
  trimRightAtPlayhead: () => void
  insertFreeze: () => void
  resizeFreeze: (duration: number) => void
  resizeClipEdge: (clipId: string, edge: 'left' | 'right', delta: number) => void
  reorderClip: (clipId: string, targetIndex: number) => void
  reorderOverlayClip: (trackId: string, clipId: string, targetIndex: number) => void
  moveOverlayClip: (
    sourceTrackId: string,
    clipId: string,
    targetTrackId: string,
    targetIndex: number,
    targetStart: number,
  ) => void
  moveClipToTrackAtTime: (
    clipId: string,
    targetTrackId: string | null,
    targetStart: number,
  ) => void
  deleteSelectedClip: () => void
  addOverlayTrack: () => void
  /** 调整叠加轨层级：'up' = 往上层（数组 index+1），'down' = 往下层。 */
  moveOverlayTrack: (trackId: string, direction: 'up' | 'down') => void
  removeOverlayTrack: (trackId: string) => void
  toggleOverlayTrackVisibility: (trackId: string) => void
  toggleTrackFlag: (kind: TrackKind, trackId: string | null, flag: TrackFlag) => void

  addAudioTrack: () => void
  removeAudioTrack: (trackId: string) => void
  toggleAudioTrackVisibility: (trackId: string) => void
  toggleAudioTrackMuted: (trackId: string) => void
  setAudioTrackVolume: (trackId: string, volume: number) => void
  updateAudioClip: (
    trackId: string,
    clipId: string,
    update: Partial<Omit<AudioClip, 'id'>>,
    label?: string,
  ) => void
  moveAudioClip: (trackId: string, clipId: string, start: number) => void
  resizeAudioClipEdge: (
    trackId: string,
    clipId: string,
    edge: 'left' | 'right',
    delta: number,
  ) => void
  deleteAudioClip: (trackId: string, clipId: string) => void

  addTextAtPlayhead: () => void
  addTextTrack: () => void
  removeTextTrack: (trackId: string) => void
  updateTextClip: (
    trackId: string,
    clipId: string,
    update: Partial<Omit<TextClip, 'id'>>,
    label?: string,
  ) => void
  moveTextClip: (trackId: string, clipId: string, start: number) => void
  resizeTextClipEdge: (
    trackId: string,
    clipId: string,
    edge: 'left' | 'right',
    delta: number,
  ) => void
  deleteTextClip: (trackId: string, clipId: string) => void
  importAutoCaptions: (words: TimelineWord[], options?: { replace?: boolean }) => number
  importSubtitles: (cues: SubtitleCue[]) => void
  asrWordsBySource: WordsBySource | null
  setAsrWordsBySource: (words: WordsBySource | null) => void
  realignCaptions: () => void
  captionApplyAll: boolean
  setCaptionApplyAll: (applyAll: boolean) => void
  captionFollow: boolean
  setCaptionFollow: (follow: boolean) => void
  captionStylePreview: { trackId: string; style: CaptionStyle } | null
  setCaptionStylePreview: (preview: { trackId: string; style: CaptionStyle } | null) => void
  updateCaptionStyle: (
    trackId: string,
    clipId: string | null,
    patch: CaptionStyle,
    applyAll: boolean,
    label: string,
  ) => void
  editCaptionText: (clipId: string, text: string) => void
  splitCaption: (clipId: string, cursorIndex: number) => void
  mergeCaptionUp: (clipId: string) => void
  replaceCaptionText: (trackId: string, find: string, replace: string) => void
  replaceCaptionTextInClip: (clipId: string, find: string, replace: string) => void

  rotateSelected: (delta: number) => void
  setRotation: (angle: number) => void
  resetRotation: () => void
  toggleFlipH: () => void
  toggleFlipV: () => void
  setScale: (scale: number) => void
  fitSelected: () => void
  fillSelected: () => void
  setPosition: (x: number, y: number) => void
  resetPosition: () => void

  beginCrop: () => void
  updateCropDraft: (crop: CropRect) => void
  applyCropPreset: (preset: CropPresetId) => void
  commitCrop: () => void
  cancelCrop: () => void

  addMarker: () => void
  openMarkerEditor: (id: string) => void
  closeMarkerEditor: () => void
  updateMarker: (marker: Marker) => void
  deleteMarker: (id: string) => void

  setAspectRatio: (aspectRatio: AspectRatioPreset) => void
  setExportQuality: (quality: ExportQuality) => void
  openExportDialog: () => void
  closeExportDialog: () => void
  notify: (message: string, kind?: ToastKind) => void
  clearToast: () => void
}

const selectedClip = (project: Project, id: string | null): Clip | null => {
  const location = findClipLocation(project, id)
  if (!location) return null
  const locked = location.track
    ? isOverlayLocked(location.track)
    : isMainLocked(project)
  return locked ? null : location.clip
}

/** 粘贴目标：显式传入的 ids 优先，其次多选，最后当前单选。 */
const resolvePasteTargets = (state: EditorState, ids: readonly string[]): string[] => {
  if (ids.length > 0) return [...ids]
  if (state.selectedIds.length > 0) return [...state.selectedIds]
  return state.selectedClipId ? [state.selectedClipId] : []
}

const clampMainTrackStart = (project: Project): Project => {
  if (project.clips.length === 0) return project
  const first = project.clips[0]
  if ((first.gapBefore ?? 0) <= 0.0001) return project
  return {
    ...project,
    clips: [{ ...first, gapBefore: 0 }, ...project.clips.slice(1)],
  }
}

export function createEditorStore() {
  const initial = createEmptyProject()
  const history = new HistoryStack(initial)
  let toastCounter = 0

  return createStore<EditorState>()((set, get) => {
    /** 判断某 id 是否仍存在于工程中（任意轨道、任意类型）。 */
  const idExists = (project: Project, id: string): boolean =>
    Boolean(
      findClipLocation(project, id) ||
        findAudioClipLocation(project, id) ||
        findTextClipLocation(project, id),
    )

  const sync = (project: Project, selection?: string | null): void => {
      const effective = get().timelineSettings.mainTrackMagnet
        ? clampMainTrackStart(project)
        : project
      const total = getProjectEnd(effective)
      const current = get()
      // 多选：保留仍然存在的项；命令指定的 selection 覆盖为单选。
      const previousIds =
        current.selectedIds.length > 0
          ? current.selectedIds
          : current.selectedClipId
            ? [current.selectedClipId]
            : []
      let ids = previousIds.filter((id) => idExists(effective, id))
      if (selection !== undefined) {
        if (selection === null) ids = []
        else if (!ids.includes(selection)) ids = [selection]
      }
      const nextSelection = primaryOf(ids, current.selectedClipId)
      const playhead = clamp(current.playhead, 0, Math.max(0, total))
      set({
        project: effective,
        selectedIds: ids,
        selectedClipId: nextSelection,
        playhead,
        canUndo: history.canUndo,
        canRedo: history.canRedo,
        cropSession:
          current.cropSession && findClipLocation(effective, current.cropSession.clipId)
            ? current.cropSession
            : null,
        previewPatch: null,
        markerEditorId:
          current.markerEditorId &&
          effective.markers.some((marker) => marker.id === current.markerEditorId)
            ? current.markerEditorId
            : null,
      })
    }

  /** 统一的选中入口：写 selectedIds，并派生 selectedClipId。 */
  const setSelection = (ids: string[], preferred?: string | null): void => {
      const nextIds = normalizeSelection(ids)
      set({
        selectedIds: nextIds,
        selectedClipId: primaryOf(nextIds, preferred),
        markerEditorId: null,
        cropSession: null,
      })
    }

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

    const run = (command: EditorCommand): boolean => {
      const effectiveCommand: EditorCommand = {
        ...command,
        execute(project) {
          let next = command.execute(project)
          if (next === project) return project
          if (get().timelineSettings.mainTrackMagnet) {
            next = clampMainTrackStart(next)
          }
          // 统一的字幕联动 hook：任何改动片段布局的命令都在同一步撤销里
          // 重新对齐带 link 的智能字幕。
          if (get().captionFollow) {
            const urlToAssetId = new Map(get().assets.map((asset) => [asset.url, asset.id]))
            next = relinkCaptions(next, urlToAssetId)
          }
          return next
        },
      }
      const result = history.execute(effectiveCommand)
      if (!result.changed) return false
      set({ isPlaying: false })
      sync(result.project, command.selectionAfter)
      set({ lastAction: command.label })
      return true
    }

    return {
      project: initial,
      source: null,
      assets: [],
      selectedClipId: null,
      selectedIds: [],
      clipboard: { items: [], count: 0 },
      playhead: 0,
      isPlaying: false,
      timelineZoom: TIMELINE_DEFAULT_ZOOM,
      timelineViewportWidth: 960,
      previewFullscreen: false,
      timelineSettings: {
        mainTrackMagnet: false,
        autoSnap: true,
        linkage: false,
        previewAxis: true,
      },
      cropSession: null,
      previewPatch: null,
      markerEditorId: null,
      exportDialogOpen: false,
      colorClipboard: null,
      canUndo: false,
      canRedo: false,
      lastAction: '',
      toast: null,
      asrWordsBySource: null,
      captionApplyAll: true,
      captionFollow: true,
      captionStylePreview: null,

      loadSource: (source) => {
        const asset: MediaAsset = { ...source, id: createId('asset') }
        const project = createInitialProject(source, createId('clip'))
        history.reset(project)
        set({
          source: asset,
          assets: [asset],
          project,
          selectedClipId: project.clips[0]?.id ?? null,
          playhead: 0,
          isPlaying: false,
          cropSession: null,
          previewPatch: null,
          markerEditorId: null,
          exportDialogOpen: false,
          canUndo: false,
          canRedo: false,
          lastAction: '',
          toast: null,
          asrWordsBySource: null,
        })
      },

      hydrateDraft: (draft) => {
        history.reset(draft.project)
        const firstAudio = draft.project.audioTracks?.[0]?.clips[0]?.id ?? null
        set({
          project: draft.project,
          assets: draft.assets,
          source: draft.source,
          selectedClipId: draft.project.clips[0]?.id ?? firstAudio,
          playhead: clamp(
            draft.playhead,
            0,
            Math.max(0, getProjectEnd(draft.project)),
          ),
          isPlaying: false,
          timelineZoom: clamp(
            draft.timelineZoom,
            TIMELINE_MIN_ZOOM,
            TIMELINE_MAX_ZOOM,
          ),
          timelineSettings: {
            mainTrackMagnet: draft.timelineSettings.mainTrackMagnet,
            autoSnap: draft.timelineSettings.autoSnap,
            linkage: draft.timelineSettings.linkage,
            previewAxis: draft.timelineSettings.previewAxis,
          },
          captionFollow: draft.timelineSettings.captionFollow ?? true,
          cropSession: null,
          previewPatch: null,
          markerEditorId: null,
          exportDialogOpen: false,
          canUndo: false,
          canRedo: false,
          lastAction: '',
          toast: null,
          asrWordsBySource: null,
        })
      },

      addAssets: (incoming) => {
        if (incoming.length === 0) return
        const current = get()
        const merged = [...current.assets]
        for (const asset of incoming) {
          if (!merged.some((item) => item.url === asset.url)) merged.push(asset)
        }
        if (current.assets.length === 0 && current.project.clips.length === 0) {
          const primary = merged.find((asset) => asset.kind !== 'audio')
          if (!primary) {
            set({ assets: merged, source: null })
            current.notify(
              incoming.length === 1
                ? `已导入音频「${incoming[0].name}」；再导入视频即可开始剪辑`
                : `已导入 ${incoming.length} 个素材；再导入视频即可开始剪辑`,
              'success',
            )
            return
          }
          const project = createInitialProject(primary, createId('clip'), primary.kind)
          history.reset(project)
          set({
            source: primary,
            assets: merged,
            project,
            selectedClipId: project.clips[0]?.id ?? null,
            playhead: 0,
            isPlaying: false,
            cropSession: null,
            previewPatch: null,
            canUndo: false,
            canRedo: false,
            asrWordsBySource: null,
            lastAction: '',
          })
          current.notify(`已导入素材「${primary.name}」`, 'success')
          return
        }
        set({ assets: merged, source: current.source ?? merged.find((asset) => asset.kind !== 'audio') ?? null })
        current.notify(
          incoming.length === 1 ? `已导入素材「${incoming[0].name}」` : `已导入 ${incoming.length} 个素材`,
          'success',
        )
      },

      addAssetToTimeline: (assetId, targetTrackId, targetStart) => {
        const asset = get().assets.find((item) => item.id === assetId)
        if (!asset) return
        if (asset.kind === 'audio') {
          const project = get().project
          const trackId = project.audioTracks?.[0]?.id ?? createId('audioTrack')
          const track = project.audioTracks?.find((item) => item.id === trackId)
          if (track && isAudioLocked(track)) {
            get().notify('音频轨已锁定，请先解锁', 'warning')
            return
          }
          const audioClip: AudioClip = {
            id: createId('audio'),
            sourceUrl: asset.url,
            sourceStart: 0,
            sourceEnd: Math.max(0.1, asset.duration),
            start: Math.max(0, targetStart),
            volume: 1,
            fadeIn: 0,
            fadeOut: 0,
          }
          if (run(createAddAudioClipCommand(trackId, audioClip))) {
            get().selectClip(audioClip.id)
            get().notify(`已添加音频「${asset.name}」`, 'success')
          }
          return
        }
        const project = get().project
        if (targetTrackId === null) {
          if (isMainLocked(project)) {
            get().notify('主轨已锁定，请先解锁', 'warning')
            return
          }
        } else {
          const track = (project.overlayTracks ?? []).find(
            (item) => item.id === targetTrackId,
          )
          if (!track || isOverlayLocked(track)) {
            get().notify('目标叠加轨已锁定，请先解锁', 'warning')
            return
          }
        }
        const isImage = asset.kind === 'image'
        const clip: Clip = {
          id: createId('clip'),
          sourceUrl: asset.url,
          sourceStart: 0,
          sourceEnd: isImage ? IMAGE_DEFAULT_DURATION : Math.max(0.1, asset.duration),
          type: isImage ? 'image' : 'video',
          rotation: 0,
          flipH: false,
          flipV: false,
          crop: { x: 0, y: 0, w: 1, h: 1 },
          scale: 1,
          position: { x: 0, y: 0 },
          volume: isImage ? 0 : 1,
        }
        if (run(createAddClipCommand(clip, targetTrackId, targetStart))) {
          get().selectClip(clip.id)
          get().notify(`已添加「${asset.name}」到时间轴`, 'success')
        }
      },

      updateSourceMeta: (patch) => {
        const source = get().source
        if (!source) return
        set({
          source: { ...source, ...patch },
          assets: get().assets.map((asset) =>
            asset.url === source.url ? { ...asset, ...patch } : asset,
          ),
        })
      },

      clearSource: () => {
        const empty = createEmptyProject()
        history.reset(empty)
        set({
          source: null,
          assets: [],
          project: empty,
          selectedClipId: null,
          playhead: 0,
          isPlaying: false,
          cropSession: null,
          previewPatch: null,
          markerEditorId: null,
          exportDialogOpen: false,
          canUndo: false,
          canRedo: false,
          lastAction: '',
          toast: null,
          asrWordsBySource: null,
        })
      },

      execute: (command) => run(command),

      undo: () => {
        const entry = history.undo()
        if (!entry) return
        set({ isPlaying: false, cropSession: null, previewPatch: null })
        // 撤销后按命令声明的 selectionAfter 恢复选中（与 redo 一致），
        // 否则撤销“删除”“分割”等操作后选区会丢失，用户还得重新找片段。
        const selection =
          entry.command.selectionAfter &&
          (findClipLocation(entry.before, entry.command.selectionAfter) ||
            findAudioClipLocation(entry.before, entry.command.selectionAfter) ||
            findTextClipLocation(entry.before, entry.command.selectionAfter))
            ? entry.command.selectionAfter
            : get().selectedClipId
        sync(entry.before, selection)
        set({ lastAction: `撤销 · ${entry.command.label}` })
      },

      redo: () => {
        const entry = history.redo()
        if (!entry) return
        set({ isPlaying: false, cropSession: null, previewPatch: null })
        const selection =
          entry.command.selectionAfter &&
          (findClipLocation(entry.after, entry.command.selectionAfter) ||
            findAudioClipLocation(entry.after, entry.command.selectionAfter) ||
            findTextClipLocation(entry.after, entry.command.selectionAfter))
            ? entry.command.selectionAfter
            : get().selectedClipId
        sync(entry.after, selection)
        set({ lastAction: `重做 · ${entry.command.label}` })
      },

      selectClip: (id) => {
        const project = get().project
        let textToReveal: TextClip | null = null
        if (id) {
          const video = findClipLocation(project, id)
          if (video) {
            const locked = video.track
              ? isOverlayLocked(video.track)
              : isMainLocked(project)
            if (locked) return
          } else {
            const audio = findAudioClipLocation(project, id)
            if (audio && isAudioLocked(audio.track)) return
            const text = findTextClipLocation(project, id)
            if (text) {
              if (isTextLocked(text.track)) return
              textToReveal = text.clip
            }
          }
        }
        const crop = get().cropSession
        setSelection(id ? [id] : [])
        if (crop && crop.clipId !== id) {
          set({ cropSession: null })
        }
        if (crop && crop.clipId === id) {
          set({ cropSession: crop })
        }
        if (textToReveal) {
          const playhead = get().playhead
          if (
            playhead < textToReveal.start - 0.001 ||
            playhead >= textToReveal.end - 0.001
          ) {
            set({ playhead: Math.max(0, textToReveal.start) })
          }
        }
      },

      toggleSelectClip: (id) => {
        const state = get()
        const project = state.project
        // 锁定轨道上的片段不可选中。
        const video = findClipLocation(project, id)
        if (video && (video.track ? isOverlayLocked(video.track) : isMainLocked(project))) return
        const audio = findAudioClipLocation(project, id)
        if (audio && isAudioLocked(audio.track)) return
        const text = findTextClipLocation(project, id)
        if (text && isTextLocked(text.track)) return

        const base = state.selectedIds.length > 0
          ? state.selectedIds
          : state.selectedClipId
            ? [state.selectedClipId]
            : []
        setSelection(toggleSelection(base, id), id)
      },

      rangeSelectClip: (id) => {
        const state = get()
        // 以主选中为锚点，按时间轴上的显示顺序做区间选择。
        const ordered = selectableOrder(state.project)
        setSelection(rangeSelection(ordered, state.selectedClipId, id), id)
      },

      selectIds: (ids) => {
        setSelection(ids)
      },

      selectAll: () => {
        const state = get()
        setSelection(selectableOrder(state.project))
      },

      copySelection: () => {
        const state = get()
        const ids = state.selectedIds.length > 0
          ? state.selectedIds
          : state.selectedClipId
            ? [state.selectedClipId]
            : []
        const payload = buildClipboardPayload(state.project, ids)
        if (payload.count === 0) return
        set({ clipboard: payload })
        state.notify(`已复制 ${payload.count} 个片段`, 'info')
      },

      cutSelection: () => {
        const state = get()
        const ids = state.selectedIds.length > 0
          ? state.selectedIds
          : state.selectedClipId
            ? [state.selectedClipId]
            : []
        const payload = buildClipboardPayload(state.project, ids)
        if (payload.count === 0) return
        set({ clipboard: payload })
        if (run(createDeleteManyCommand(ids))) {
          state.notify(`已剪切 ${payload.count} 个片段`, 'info')
        }
      },

      pasteAtPlayhead: () => {
        const state = get()
        const payload = state.clipboard
        if (payload.count === 0) {
          state.notify('剪贴板为空', 'warning')
          return
        }
        const lockedTrackIds = new Set<string>()
        for (const track of state.project.overlayTracks ?? []) {
          if (isOverlayLocked(track)) lockedTrackIds.add(track.id)
        }
        for (const track of state.project.audioTracks ?? []) {
          if (isAudioLocked(track)) lockedTrackIds.add(track.id)
        }
        for (const track of state.project.textTracks ?? []) {
          if (isTextLocked(track)) lockedTrackIds.add(track.id)
        }
        const plan = planPaste(state.project, payload, state.playhead, { lockedTrackIds })
        const outIds: string[] = []
        const nextId: IdFactory = (prefix) => createId(prefix === 'overlay' ? 'overlay' : prefix)
        if (run(createPasteCommand(plan, nextId, outIds))) {
          if (outIds.length > 0) setSelection(outIds, outIds[0])
          get().notify(`已粘贴 ${outIds.length} 个片段`, 'success')
        }
      },

      moveSelectionBy: (delta) => {
        const state = get()
        const ids = state.selectedIds.length > 0
          ? state.selectedIds
          : state.selectedClipId
            ? [state.selectedClipId]
            : []
        if (ids.length === 0 || Math.abs(delta) < 0.0001) return
        // 顺序轨以段头最小 gapBefore 收敛，避免越界。
        const items = ids.map((id) => {
          const video = findSegmentById(state.project.clips, id)
          if (video) return { id, start: video.start, duration: video.duration }
          for (const track of state.project.overlayTracks ?? []) {
            const segment = findSegmentById(track.clips, id)
            if (segment) return { id, start: segment.start, duration: segment.duration }
          }
          const audio = findAudioClipLocation(state.project, id)
          if (audio) return { id, start: audio.clip.start, duration: clipTimelineDuration(audio.clip) }
          const text = findTextClipLocation(state.project, id)
          if (text) return { id, start: text.clip.start, duration: text.clip.end - text.clip.start }
          return null
        }).filter((item): item is { id: string; start: number; duration: number } => item !== null)
        if (items.length === 0) return
        const moves = planBatchMove(items, delta)
        if (run(createMoveManyCommand(moves.map((move) => move.id), moves[0].delta))) {
          get().notify(`已移动 ${moves.length} 个片段`, 'info')
        }
      },

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

      copyClipColor: (clipId) => {
        const state = get()
        const location =
          findClipLocation(state.project, clipId)?.clip ??
          findAudioClipLocation(state.project, clipId)?.clip ??
          null
        if (!location) return
        set({ colorClipboard: normalizeColor('color' in location ? location.color : null) })
        state.notify('已复制当前调色设置', 'info')
      },

      pasteClipColor: (clipId) => {
        const state = get()
        const clipboard = state.colorClipboard
        if (!clipboard) {
          state.notify('还没有复制调色设置', 'warning')
          return
        }
        const location = findClipLocation(state.project, clipId)
        if (!location) return
        if (location.track ? isOverlayLocked(location.track) : isMainLocked(state.project)) return
        if (isSameColor(normalizeColor(location.clip.color), clipboard)) return
        run(createUpdateAnyClipCommand(clipId, { color: clipboard }, '粘贴调色'))
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

      copyVisualAttributes: (clipId) => {
        const state = get()
        const location = findClipLocation(state.project, clipId)
        if (!location) {
          state.notify('没有可复制的片段', 'warning')
          return
        }
        // 复制是只读操作，锁定轨道上的片段也允许复制。
        setVisualAttrs(captureVisualAttrs(location.clip))
        state.notify('已复制画面属性', 'info')
      },

      pasteVisualAttributes: (ids) => {
        const state = get()
        const attrs = getVisualAttrs()
        if (!attrs || Object.keys(attrs).length === 0) {
          state.notify('剪贴板为空', 'warning')
          return
        }
        const targets = resolvePasteTargets(state, ids)
        if (targets.length === 0) {
          state.notify('没有可粘贴的片段', 'warning')
          return
        }
        // 先干跑一次拿统计（命令本身是纯函数）。
        const preview = applyAttributePatch(state.project, targets, attrs as Partial<Clip>)
        if (preview.applied === 0) {
          state.notify('目标片段在锁定轨道上，未粘贴', 'warning')
          return
        }
        if (run(createPasteVisualAttributesCommand(targets, attrs))) {
          state.notify(`已粘贴到 ${preview.applied} 个片段`, 'success')
        }
      },

      copyAudioAttributes: (clipId) => {
        const state = get()
        const location = findClipLocation(state.project, clipId)
        if (!location) {
          state.notify('没有可复制的片段', 'warning')
          return
        }
        setAudioAttrs(captureAudioAttrs(location.clip))
        state.notify('已复制音频属性', 'info')
      },

      pasteAudioAttributes: (ids) => {
        const state = get()
        const attrs = getAudioAttrs()
        if (!attrs || Object.keys(attrs).length === 0) {
          state.notify('剪贴板为空', 'warning')
          return
        }
        const targets = resolvePasteTargets(state, ids)
        if (targets.length === 0) {
          state.notify('没有可粘贴的片段', 'warning')
          return
        }
        const preview = applyAttributePatch(state.project, targets, attrs as Partial<Clip>)
        if (preview.applied === 0) {
          state.notify('目标片段在锁定轨道上，未粘贴', 'warning')
          return
        }
        if (run(createPasteAudioAttributesCommand(targets, attrs))) {
          state.notify(`已粘贴到 ${preview.applied} 个片段`, 'success')
        }
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

      setPlayhead: (time, snapThreshold = 0) => {
        const state = get()
        const total = getProjectEnd(state.project)
        const snapped = snapThreshold > 0 ? snapToMarker(time, state.project.markers, snapThreshold) : time
        set({ playhead: clamp(snapped, 0, Math.max(0, total)) })
      },

      stepPlayheadFrames: (frames) => {
        const state = get()
        const total = getProjectEnd(state.project)
        const fps = state.project.exportQuality.fps
        set({
          playhead: stepByFrames(state.playhead, frames, fps, total),
          isPlaying: false,
        })
      },

      nudgePlayhead: (seconds) => {
        const state = get()
        const total = getProjectEnd(state.project)
        set({ playhead: stepBySeconds(state.playhead, seconds, total), isPlaying: false })
      },

      jumpToEditPoint: (direction) => {
        const state = get()
        const points = collectEditPoints(state.project)
        const target = nextEditPoint(points, state.playhead, direction)
        if (target === null) return
        set({ playhead: target, isPlaying: false })
      },

      zoomToFit: () => {
        const state = get()
        const total = getProjectEnd(state.project)
        set({
          timelineZoom: fitZoom(
            total,
            state.timelineViewportWidth,
            TIMELINE_MIN_ZOOM,
            TIMELINE_MAX_ZOOM,
          ),
        })
      },

      setTimelineViewportWidth: (width) => {
        if (width > 0) set({ timelineViewportWidth: width })
      },

      setPreviewFullscreen: (fullscreen) => {
        set({ previewFullscreen: fullscreen })
      },

      setPlaying: (playing) => {
        const state = get()
        const total = getProjectEnd(state.project)
        if (total <= 0) {
          set({ isPlaying: false })
          return
        }
        if (playing && state.playhead >= total - 0.001) {
          set({ playhead: 0, isPlaying: true })
          return
        }
        set({ isPlaying: playing })
      },

      togglePlay: () => {
        const state = get()
        state.setPlaying(!state.isPlaying)
      },

      replay: () => {
        const state = get()
        if (getProjectEnd(state.project) <= 0) return
        set({ playhead: 0, isPlaying: true, previewPatch: null })
      },

      finishPlayback: () => {
        const total = getProjectEnd(get().project)
        set({ isPlaying: false, playhead: total })
      },

      setTimelineZoom: (zoom) => {
        set({ timelineZoom: clamp(zoom, TIMELINE_MIN_ZOOM, TIMELINE_MAX_ZOOM) })
      },

      toggleTimelineSetting: (key) => {
        const state = get()
        const next = !state.timelineSettings[key]
        set((current) => ({
          timelineSettings: {
            ...current.timelineSettings,
            [key]: next,
          },
        }))
        if (key === 'mainTrackMagnet' && next) {
          const project = get().project
          if (project.clips[0] && (project.clips[0].gapBefore ?? 0) > 0.0001) {
            run({
              label: '主轨首段贴齐',
              selectionAfter: get().selectedClipId,
              execute: (current) => clampMainTrackStart(current),
            })
          }
        }
      },

      setPreviewPatch: (patch) => set({ previewPatch: patch }),

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

      deleteSelectedClip: () => {
        const state = get()
        // 多选：一次命令批量删除（锁定轨道上的片段跳过）。
        if (state.selectedIds.length > 1) {
          const deletable = state.selectedIds.filter((id) => {
            const video = findClipLocation(state.project, id)
            if (video) {
              return !(video.track
                ? isOverlayLocked(video.track)
                : isMainLocked(state.project))
            }
            const audio = findAudioClipLocation(state.project, id)
            if (audio) return !isAudioLocked(audio.track)
            const text = findTextClipLocation(state.project, id)
            if (text) return !isTextLocked(text.track)
            return false
          })
          if (deletable.length === 0) return
          if (run(createDeleteManyCommand(deletable))) {
            get().notify(`已删除 ${deletable.length} 个片段`, 'info')
          }
          return
        }
        const audio = findAudioClipLocation(state.project, state.selectedClipId)
        if (audio) {
          get().deleteAudioClip(audio.track.id, audio.clip.id)
          return
        }
        const text = findTextClipLocation(state.project, state.selectedClipId)
        if (text) {
          get().deleteTextClip(text.track.id, text.clip.id)
          return
        }
        const location = findClipLocation(state.project, state.selectedClipId)
        if (!location) return
        if (location.track ? isOverlayLocked(location.track) : isMainLocked(state.project)) {
          return
        }
        if (location.track) {
          const track = location.track
          const index = track.clips.findIndex((clip) => clip.id === location.clip.id)
          const nextSelection =
            track.clips[index + 1]?.id ??
            track.clips[index - 1]?.id ??
            state.project.clips[0]?.id ??
            null
          if (run(createDeleteOverlayClipCommand(track.id, location.clip.id, nextSelection))) {
            get().notify('已删除叠加片段', 'info')
          }
          return
        }
        const clip = location.clip
        if (state.project.clips.length === 0) return
        const index = state.project.clips.findIndex((item) => item.id === clip.id)
        const nextSelection =
          state.project.clips[index + 1]?.id ?? state.project.clips[index - 1]?.id ?? null
        if (run(createDeleteClipCommand(clip.id, nextSelection))) {
          get().notify('已删除片段', 'info')
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

      setAsrWordsBySource: (words) => {
        set({ asrWordsBySource: words })
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

      setCaptionApplyAll: (applyAll) => {
        set({ captionApplyAll: applyAll })
      },

      setCaptionFollow: (follow) => {
        if (follow === get().captionFollow) return
        set({ captionFollow: follow })
        if (follow) {
          // 开启时立即执行一次 relink，作为一个独立可撤销命令。
          const urlToAssetId = new Map(get().assets.map((asset) => [asset.url, asset.id]))
          run(createRelinkCaptionsCommand(urlToAssetId))
        }
      },

      setCaptionStylePreview: (preview) => {
        set({ captionStylePreview: preview })
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

      openMarkerEditor: (id) => {
        if (get().project.markers.some((marker) => marker.id === id)) {
          set({ markerEditorId: id, isPlaying: false })
        }
      },

      closeMarkerEditor: () => set({ markerEditorId: null }),

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

      openExportDialog: () => {
        set({
          exportDialogOpen: true,
          isPlaying: false,
          cropSession: null,
          previewPatch: null,
          markerEditorId: null,
        })
      },

      closeExportDialog: () => {
        if (get().exportDialogOpen) set({ exportDialogOpen: false })
      },

      notify: (message, kind = 'info') => {
        toastCounter += 1
        set({ toast: { id: toastCounter, kind, message } })
      },

      clearToast: () => set({ toast: null }),
    }
  })
}

export type EditorStore = ReturnType<typeof createEditorStore>