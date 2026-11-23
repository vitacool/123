import { assetKindOf } from '../core/assets'
import { resolveAssetPlacement, type AssetPlacementIntent } from '../core/assetPlacement'
import type { ChromaKey } from '../core/chromaKey'
import { createStore } from 'zustand/vanilla'
import { aspectValue } from '../core/aspect'
import { CROP_PRESETS, type CropPresetId } from '../core/constants'
import { createAddAudioClipCommand, createAddClipToNewOverlayTrackCommand, createAddAudioTrackCommand, createAddClipCommand, createAddMarkerCommand, createAddEmptyOverlayTrackCommand, createAddTextClipCommand, createAddTextTrackCommand, createImportAutoCaptionsCommand, createImportSubtitlesCommand, createReplaceAutoCaptionsCommand, createDeleteMarkerCommand, createInsertFreezeCommand, createMoveAudioClipCommand, createMoveOverlayClipCommand, createMoveClipToTrackAtTimeCommand, createMoveTextClipCommand, createRemoveAudioClipCommand, createRemoveAudioTrackCommand, createRemoveOverlayTrackCommand, createRemoveTextClipCommand, createRemoveTextTrackCommand, createReorderClipCommand, createReorderOverlayClipCommand, createResizeAudioClipCommand, createResizeClipEdgeCommand, createResizeFreezeCommand, createResizeOverlayClipEdgeCommand, createResizeTextClipCommand, createSetAspectRatioCommand, createSetExportQualityCommand, createSplitAudioClipCommand, createSplitCommand, createSetTransitionAllCommand, createSetColorAllCommand, createMoveOverlayTrackCommand, createRemoveAssetClipsCommand, createSetCoverCommand, createClearCoverCommand, createSetKeyframeCommand, createRemoveKeyframeCommand, createMoveKeyframesCommand, createSetKeyframeEasingCommand, createClearPropertyKeyframesCommand, createRemoveKeyframesCommand, createSplitOverlayClipCommand, createSplitTextClipCommand, createTrimAudioClipCommand, createTrimLeftCommand, createTrimOverlayClipCommand, createTrimRightCommand, createTrimTextClipCommand, createUpdateAudioClipCommand, createUpdateAudioTrackCommand, createUpdateAnyClipCommand, createReverseClipCommand, createUpdateMainTrackCommand, createUpdateMarkerCommand, createUpdateOverlayTrackCommand, createUpdateCaptionClipStyleCommand, createUpdateCaptionTrackStyleCommand, createReplaceCaptionTextCommand, createMergeCaptionWithPreviousCommand, createSplitCaptionCommand, createMoveTrackCommand, createUpdateTextClipCommand, createUpdateTextTrackCommand } from '../core/commands'
import type { EditorCommand } from '../core/commands'
import type { TrackOrderKind } from '../core/operations'
import type { DraftSettings } from '../core/draft'
import {
  type FrameCutTheme,
  type ResolvedTheme,
} from '../core/theme'
import {
  EXPORT_RANGE_MIN_DURATION,
  clampExportRange,
  exportRangeDuration,
  type ExportRange,
} from '../core/exportRange'
import { formatClock } from '../core/format'
import { createStoreInternals, type HistoryState } from './internal'
import { createPlaybackSlice } from './slices/playback'
import { createSelectionSlice } from './slices/selection'
import { createUiSlice } from './slices/ui'
import { clampCrop, createEmptyProject, createInitialProject, applyTransitionToAllJunctions, applyColorToAllClips, normalizeAngle, displayToArrayIndex } from '../core/operations'
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
import { clampSpeed, canChangeClipSpeed, clipSpeedValue, normalizeSpeedCurve } from '../core/speed'
import { clipFreezeFrame, clipTimelineDuration } from '../core/clipTime'
import {
  clampTransitionDuration,
  maxTransitionDuration,
  normalizeTransitionType,
  transitionLabel,
  TRANSITION_MIN_DURATION,
} from '../core/transition'
import { isSameColor, normalizeColor, type ColorAdjustments } from '../core/color'
import { isAssetReferenced, unusedAssets } from '../core/assets'
import { captureCoverFrame, coverTargetSize, readCoverImage } from '../core/cover'
import { animationContextAt, moveKeyframesInProject } from '../core/keyframes'
import { animationBaseValue, isPropertyAnimatizable } from '../core/animationTargets'
import { evalAnimation } from '../core/animation'
import type { KeyframeRef } from '../core/keyframeEdit'
import {
  deleteMediaBlob,
  reportDraftSaveFailure,
  saveMediaBlob,
  saveProjectRecord,
  toDraftSnapshot,
} from '../services/draftStore'
import {
  DEFAULT_PROJECT_NAME,
  normalizeProjectName,
  projectNameFromSource,
  projectThumbnail,
} from '../core/projectLibrary'
import { readAssetFile } from '../services/assetReader'
import {
  countLinkedCaptions,
  matchesReverseOrigin,
  mirrorAnimationTimes,
  needsReverseConfirm,
  planReverseRestore,
  reverseActionState,
  reverseAssetOrigin,
  reverseChunks,
} from '../core/reverse'
import { isReverseAbort, reverseAssetSpan } from '../services/reverseMedia'
import { type ClipboardPayload } from '../core/clipboard'
import {
  blendModeLabel,
  clipBlendMode,
  clipOpacity,
  normalizeBlendMode,
} from '../core/blend'
import { createDetachAudioCommand, createSetCanvasBackgroundCommand, createSetClipBackgroundCommand } from '../core/commands'
import { mapWordsToTimeline } from '../core/captionMapping'
import { mergeRelinkedCaptions } from '../core/captionLink'
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
  findSegmentAt,
  findSegmentById,
  getActionAvailability,
  getProjectEnd,
  getTimeline,
} from '../core/timeline'
import {
  FREEZE_DEFAULT_DURATION,
  FREEZE_MAX_DURATION,
  FREEZE_MIN_DURATION,
  MARKER_COLORS,
  MAX_OVERLAY_TRACKS,
  SCALE_MAX,
  SCALE_MIN,
  TIMELINE_MAX_ZOOM,
  TIMELINE_MIN_ZOOM,
} from '../core/constants'
import type {
  AnimatableProperty,
  AspectRatioPreset,
  Easing,
  AudioClip,
  BlendMode,
  CanvasBackground,
  TransitionType,
  CaptionStyle,
  Clip,
  ClipMask,
  CoverMode,
  CropRect,
  ExportQuality,
  Keyframe,
  Marker,
  MediaAsset,
  Project,
  ProjectCover,
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

/** 进行中的「倒放」任务（用于进度条 / 取消按钮；不写进工程与撤销历史）。 */
export interface ReverseJob {
  clipId: string
  /** 源素材名（展示用）。 */
  assetName: string
  /** 0–100。 */
  progress: number
  status: string
}

export interface ToastMessage {
  id: number
  kind: ToastKind
  message: string
}

/**
 * 已删除、但还不能真正回收的素材。
 *
 * 删除素材时：片段删除走命令（可撤销），但 `URL.revokeObjectURL` 与 IndexedDB 的
 * blob 删除是**不可逆**的。如果立刻执行，Ctrl+Z 把片段恢复回来时源已经失效
 * （时间轴上出现无法播放的坏片段）。所以删除只把素材标记成 pending、
 * 立刻从 `assets` 移出（素材库随之隐藏），真正回收推迟到「历史栈里已无引用」。
 */
export interface PendingReclaimEntry {
  /** 删除时的素材快照（它已经从 assets 里移走了，这里留一份用于恢复 / 回收）。 */
  asset: MediaAsset
  /** 删除前在素材库里的位置：撤销恢复时插回原处，避免列表顺序跳动。 */
  indexAtDelete: number
  /** 删除时的 projectId：回收 blob 时沿用「别删其它项目还在用的素材」判定。 */
  projectId: string | null
  /**
   * 删除时是否连带删掉了引用它的片段。
   * 只有这种删除才需要「撤销把片段带回来 → 素材回素材库」的恢复；
   * `removeClips:false`（仅从素材库移除、片段保留）不做恢复，它会一直等到没人引用。
   */
  removedClips: boolean
  deletedAt: number
}

export interface EditorState {
  project: Project
  source: SourceInfo | null
  assets: MediaAsset[]
  /**
   * 待回收素材（key = assetId）。删除后不在素材库显示，但在真正回收前仍可被撤销带回。
   * 会话级状态：不进撤销历史、不写进草稿。
   */
  pendingReclaim: Record<string, PendingReclaimEntry>
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
  /** 设置 / 清除片段形状蒙版（一个命令 = 一步撤销）。 */
  setClipMask: (clipId: string, mask: ClipMask | undefined) => void
  /** 设置 / 清除色度抠像（一个命令 = 一步撤销）。 */
  setClipChromaKey: (clipId: string, key: ChromaKey | undefined) => void
  /** 设置 / 清除分段变速（2–8 段，段内常速；一个命令 = 一步撤销）。 */
  setClipSpeedSegments: (
    clipId: string,
    segments: { at: number; speed: number }[] | undefined,
  ) => void
  /**
   * 设置 / 清除平滑变速曲线（一个命令 = 一步撤销）。
   * 写入曲线时同时清掉 speedSegments：两者互斥，曲线优先于单一倍率。
   */
  setClipSpeedCurve: (
    clipId: string,
    curve: { at: number; speed: number }[] | undefined,
  ) => void
  /** 把一组调色参数应用到所有画面片段（一个命令）。 */
  applyColorToAll: (color: ColorAdjustments) => void
  /** 调色剪贴板：「复制当前设置」后供其他片段「粘贴调色」。 */
  colorClipboard: ColorAdjustments | null
  /** 预览是否临时显示封面（hover / 点击封面块）。 */
  coverPreview: boolean
  /**
  /** 在当前播放头处切换某个属性的关键帧（有则删、无则按当前值加）。 */
  toggleKeyframe: (prop: AnimatableProperty) => void
  /** 多选整体平移关键帧（1 步撤销）；被唯一性校验拒绝时 Toast 提示并放弃。 */
  moveKeyframes: (clipId: string, refs: KeyframeRef[], delta: number) => void
  /** 批量删除关键帧（1 步撤销）。 */
  deleteKeyframes: (clipId: string, refs: KeyframeRef[]) => void
  /** 给选中的关键帧批量设置缓动（1 步撤销）。 */
  setKeyframeEasing: (refs: KeyframeRef[], ease: Easing) => void
  /** 清空选中片段某个属性的全部关键帧（1 步撤销）。 */
  clearPropertyKeyframes: (prop: AnimatableProperty) => void
  /** 可视化属性的统一写入入口：有关键帧时改关键帧，否则改基础值。 */
  setAnimatableValue: (prop: AnimatableProperty, value: number) => void
  /** 封面设置浮层是否打开。 */
  coverPanelOpen: boolean
  openCoverPanel: () => void
  closeCoverPanel: () => void
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
  /** 复制变速属性（倍率 / 分段 / 曲线）到模块级属性剪贴板。 */
  copySpeedAttributes: (clipId: string) => void
  /** 把变速属性粘贴到一组可变速片段（一个命令；定格 / 图片被跳过）。 */
  pasteSpeedAttributes: (ids: string[]) => void

  /** 从播放头所在的主轨画面截一帧作为封面（失败时 Toast 警告，不写状态）。 */
  setCoverFromFrame: (time: number) => void
  /** 用上传的图片作为封面（只接受 jpg / png / webp），按画布比例居中裁剪。 */
  setCoverFromImage: (file: File) => void
  /** 切换封面的导出行为。 */
  setCoverMode: (mode: CoverMode) => void
  /** 移除封面（1 步撤销）。 */
  clearCover: () => void
  /** 预览临时显示封面（hover / 点击封面块时）。 */
  setCoverPreview: (active: boolean) => void
  /** 设置工程级画布背景（一个命令）。 */
  setCanvasBackground: (background: CanvasBackground) => void
  /** 给指定片段设置背景覆盖（一个命令）。 */
  setClipBackground: (ids: string[], background: CanvasBackground) => void
  /** 把工程级背景同步到所有片段（清掉片段级覆盖，一个命令）。 */
  applyBackgroundToAll: (background: CanvasBackground) => void
  playhead: number
  isPlaying: boolean
  timelineZoom: number
  /** 当前项目在 IndexedDB 里的 id；还没有内容（未分配）时为 null。 */
  projectId: string | null
  /** 当前项目名（默认取主素材名，可重命名）。 */
  projectName: string
  /** 用户是否手动改过项目名：改过就不再跟随主素材名。 */
  projectNameEdited: boolean
  /** 重命名当前项目（随自动保存写入 IndexedDB）。 */
  renameProject: (name: string) => void
  /** 切到某个已有项目：先保存当前项目，再接管新的 id / 名字。 */
  adoptProject: (id: string, name: string) => void
  /** 立即保存当前项目（切换项目 / 关闭前调用；失败时提示一次）。 */
  flushProjectSave: () => void
  /**
   * 导出区间（入点 / 出点，秒）；null 表示导出整条时间轴。
   * 会话 / 草稿级设置：直接 set，不进撤销历史，随草稿持久化。
   */
  exportRange: ExportRange | null
  /** 界面主题偏好（'system' 跟随系统）。纯界面状态：不写进工程/草稿/撤销历史。 */
  theme: FrameCutTheme
  /** 当前实际生效的主题（system 已解析）。Canvas 界面元素据此重绘。 */
  resolvedTheme: ResolvedTheme
  /** 设置主题偏好（由编辑器外壳或 API 调用）。 */
  setTheme: (theme: FrameCutTheme) => void
  /** 写入解析后的实际主题（由编辑器外壳跟随系统变化时更新）。 */
  setResolvedTheme: (theme: ResolvedTheme) => void
  /** 在播放头设入点；只设了一端时出点取工程终点。 */
  setExportInPoint: (time?: number) => void
  /** 在播放头设出点；只设了一端时入点取工程起点。 */
  setExportOutPoint: (time?: number) => void
  /** 拖动时间轴上的区间端点；长度保持至少 0.1 秒。 */
  setExportRangeEdge: (edge: 'start' | 'end', time: number) => void
  /** 清除导出区间（Alt+X）。 */
  clearExportRange: () => void
  /** 时间轴可视区宽度（px），由 Timeline 组件测量后回填，用于「适应窗口」。 */
  timelineViewportWidth: number
  /** 全屏预览开关（F 进入，Esc 退出）。 */
  previewFullscreen: boolean
  setPreviewFullscreen: (fullscreen: boolean) => void
  timelineSettings: TimelineSettings
  cropSession: CropSession | null
  previewPatch: PreviewPatch | null
  /** 「倒放」生成中的任务；null 表示空闲。 */
  reverseJob: ReverseJob | null
  /** 把片段（主轨或叠加轨的 video）改成倒放素材；必要时生成新素材。 */
  reverseClip: (clipId: string) => void
  /** 取消进行中的倒放（在分段之间生效）。 */
  cancelReverse: () => void
  markerEditorId: string | null
  exportDialogOpen: boolean
  /** 历史栈摘要：canUndo / canRedo 由它派生（见 selectCanUndo / selectCanRedo）。 */
  history: HistoryState
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
  /**
   * 从素材库删除一个素材。
   * - removeClips=true：同时删除所有引用它的片段（1 步撤销）。
   * - removeClips=false：片段保留，但会显示为「素材已移除」。
   *
   * 删除本身只把素材标记为「待回收」并立刻从素材库隐藏：objectURL 与 IndexedDB 的
   * blob 是不可逆的，必须等到历史栈（past + present + future）里再没有任何片段引用它
   * 时才真正回收，否则撤销回来的片段会指向已经失效的源。撤销会自动把素材放回素材库。
   */
  removeAsset: (assetId: string, options: { removeClips: boolean }) => void
  /** 一次性清理所有未被任何片段引用的素材（同样走延迟回收）。 */
  cleanupUnusedAssets: () => void
  /**
   * 立即回收全部待回收素材（关闭 / 切换项目、组件卸载、destroy 时调用）。
   * 这些时刻历史栈会被丢弃（或编辑器已经不存在），不可能再撤销回来。
   */
  disposePendingAssets: () => void
  /** 把素材库里的素材加到时间轴；落点由 core/assetPlacement 决定。 */
  addAssetToTimeline: (assetId: string, intent: AssetPlacementIntent) => void
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
  /**
   * 预览时把「带分段变速的片段」静音：浏览器预览只能按 playbackRate 播放（会变调），
   * 而导出用 atempo 保音高。开启后预览与导出的听感一致（预览不出这些片段的声音）。
   */
  previewMuteSegmentedSpeed?: boolean
  togglePreviewMuteSegmentedSpeed: () => void
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
  /** 把轨道移动到目标界面下标（跨类型不允许，主轨不可移动）。 */
  moveTrack: (kind: TrackOrderKind, trackId: string, targetDisplayIndex: number) => void
  /** 按界面上下移动一层（按钮与 Alt+上下箭头共用）。 */
  moveTrackBy: (kind: TrackOrderKind, trackId: string, direction: 'up' | 'down') => void
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

/** 封面出图尺寸：跟随画布比例，短边 ≤1280（与 core/cover 的规则一致）。 */
const coverCanvasSize = (state: EditorState): { width: number; height: number } => {
  const reference = state.source ?? state.assets[0] ?? null
  const ratio = aspectValue(state.project.aspectRatio, reference)
  const height = 720
  return coverTargetSize(Math.round(height * Math.max(0.1, ratio)), height)
}


export function createEditorStore() {
  const initial = createEmptyProject()

  return createStore<EditorState>()((set, get) => {
  /** 共享内核：历史栈、命令执行、状态同步、素材回收（见 store/internal.ts）。 */
  const internals = createStoreInternals(get, set, initial)
  const { sync, run, reconcilePendingAssets, cancelReverseForProjectSwap } = internals




  /** 统一的选中入口：写 selectedIds，并派生 selectedClipId。 */

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


    /** 把封面写入工程历史（1 步撤销），成功后提示。 */
    const applyCover = (cover: ProjectCover): void => {
      const state = get()
      if (run(createSetCoverCommand(cover))) state.notify('封面已更新', 'success')
    }

    return {
      ...createUiSlice({ get, set, internals }),
      ...createPlaybackSlice({ get, set, internals }),
      ...createSelectionSlice({ get, set, internals }),
      project: initial,
      source: null,
      assets: [],
      pendingReclaim: {},
      projectId: null,
      projectName: DEFAULT_PROJECT_NAME,
      projectNameEdited: false,
      exportRange: null,
      cropSession: null,
      reverseJob: null,
      exportDialogOpen: false,
      history: {
        stack: internals.history,
        pastLength: 0,
        futureLength: 0,
        version: 0,
      },
      lastAction: '',

      loadSource: (source) => {
        cancelReverseForProjectSwap()
        const asset: MediaAsset = { ...source, id: createId('asset') }
        const project = createInitialProject(source, createId('clip'))
        internals.resetHistory(project)
        set({
          source: asset,
          assets: [asset],
          project,
          // 新会话 = 新项目：分配 id，项目名取主素材名。
          projectId: createId('project'),
          projectName: projectNameFromSource(source.name),
          projectNameEdited: false,
          selectedClipId: project.clips[0]?.id ?? null,
          // 必须同时重置多选：否则上一个项目的 id 会残留，复制/删除会用到失效 id。
          selectedIds: project.clips[0]?.id ? [project.clips[0].id] : [],
          playhead: 0,
          isPlaying: false,
          exportRange: null,
          cropSession: null,
          previewPatch: null,
          markerEditorId: null,
          exportDialogOpen: false,
          lastAction: '',
          toast: null,
          asrWordsBySource: null,
        })
      },

      hydrateDraft: (draft) => {
        cancelReverseForProjectSwap()
        internals.resetHistory(draft.project)
        const firstAudio = draft.project.audioTracks?.[0]?.clips[0]?.id ?? null
        const firstSelection = draft.project.clips[0]?.id ?? firstAudio
        set({
          project: draft.project,
          assets: draft.assets,
          source: draft.source,
          selectedClipId: firstSelection,
          // 切项目必须重置多选集合（否则复制/删除会读到上一个项目的失效 id）。
          selectedIds: firstSelection ? [firstSelection] : [],
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
          // 旧草稿没有 exportRange：按「导出全部」处理，越界区间夹回有效范围。
          exportRange: clampExportRange(
            draft.timelineSettings.exportRange ?? null,
            Math.max(0, getProjectEnd(draft.project)),
          ),
          cropSession: null,
          previewPatch: null,
          markerEditorId: null,
          exportDialogOpen: false,
          lastAction: '',
          toast: null,
          asrWordsBySource: null,
        })
        // 换到了另一个项目：旧工程的历史栈刚被 reset，待回收素材已不可能被撤销带回。
        reconcilePendingAssets({ force: true })
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
          internals.resetHistory(project)
          set({
            source: primary,
            assets: merged,
            project,
            // 第一次导入素材即成为新项目：分配 id，名字跟随主素材。
            projectId: current.projectId ?? createId('project'),
            projectName: current.projectNameEdited
              ? current.projectName
              : projectNameFromSource(primary.name),
            selectedClipId: project.clips[0]?.id ?? null,
            playhead: 0,
            isPlaying: false,
            cropSession: null,
            previewPatch: null,
            asrWordsBySource: null,
            lastAction: '',
          })
          current.notify(`已导入素材「${primary.name}」`, 'success')
          return
        }
        const nextSource =
          current.source ?? merged.find((asset) => asset.kind !== 'audio') ?? null
        set({
          assets: merged,
          source: nextSource,
          // 空会话里只导入音频时也要有一个项目身份；名字仍跟随主素材（若有）。
          projectId:
            current.projectId ??
            (nextSource || merged.length > 0 ? createId('project') : null),
          projectName:
            current.projectNameEdited || !nextSource
              ? current.projectName
              : projectNameFromSource(nextSource.name),
        })
        current.notify(
          incoming.length === 1 ? `已导入素材「${incoming[0].name}」` : `已导入 ${incoming.length} 个素材`,
          'success',
        )
      },

      removeAsset: (assetId, options) => {
        const state = get()
        const asset = state.assets.find((item) => item.id === assetId)
        if (!asset) return
        const referenced = isAssetReferenced(state.project, asset)
        const removedClips = options.removeClips && referenced

        // 先删片段（1 步撤销）。素材本身不在撤销历史里，所以这里**不销毁**它：
        // 只标记成待回收并从素材库隐藏，revoke / 删 blob 等到历史栈不再引用时再做
        // （见 reconcilePendingAssets），这样 Ctrl+Z 回来的片段仍然有可用的源。
        if (removedClips) {
          run(createRemoveAssetClipsCommand({ url: asset.url, assetId: asset.id }))
        }

        const current = get()
        const indexAtDelete = Math.max(
          0,
          current.assets.findIndex((item) => item.id === assetId),
        )
        const assets = current.assets.filter((item) => item.id !== assetId)
        const nextSource =
          current.source?.url === asset.url
            ? assets.find((item) => item.kind !== 'audio') ?? null
            : current.source
        set({
          assets,
          source: nextSource,
          pendingReclaim: {
            ...current.pendingReclaim,
            [assetId]: {
              asset,
              indexAtDelete,
              projectId: state.projectId,
              removedClips,
              deletedAt: Date.now(),
            },
          },
        })
        // 如果它已经没有任何引用（含历史栈），这里立刻回收；否则先挂着等撤销窗口关闭。
        reconcilePendingAssets()
        state.notify(`已删除素材「${asset.name}」，撤销可恢复`, 'info')
      },

      cleanupUnusedAssets: () => {
        const state = get()
        const unused = unusedAssets(state.project, state.assets)
        if (unused.length === 0) {
          state.notify('没有未使用的素材', 'info')
          return
        }
        const unusedIds = new Set(unused.map((asset) => asset.id))
        const assets = state.assets.filter((asset) => !unusedIds.has(asset.id))
        const source =
          state.source && unused.some((asset) => asset.url === state.source?.url)
            ? assets.find((asset) => asset.kind !== 'audio') ?? null
            : state.source
        // 同样只标记待回收：如果被清理的素材还留在撤销历史里（例如刚删过引用它的片段），
        // 撤销后片段还能恢复，立刻删 blob 会造出坏片段。
        const pendingReclaim = { ...state.pendingReclaim }
        unused.forEach((asset) => {
          pendingReclaim[asset.id] = {
            asset,
            indexAtDelete: Math.max(
              0,
              state.assets.findIndex((item) => item.id === asset.id),
            ),
            projectId: state.projectId,
            // 这些素材本来就没有片段引用，不存在「撤销把片段带回来」的恢复。
            removedClips: false,
            deletedAt: Date.now(),
          }
        })
        set({ assets, source, pendingReclaim })
        reconcilePendingAssets()
        state.notify(`已清理 ${unused.length} 个未使用素材`, 'success')
      },

      disposePendingAssets: () => {
        // 切/关项目、组件卸载：历史栈随后被丢弃，不可能再撤销回来，直接全部回收。
        reconcilePendingAssets({ force: true })
      },

      addAssetToTimeline: (assetId, intent) => {
        const state = get()
        const asset = state.assets.find((item) => item.id === assetId)
        if (!asset) return
        // 防御：旧调用点若还传 (assetId, trackId, start)，第二个参数会是字符串/null。
        // 这种情况按「自动落点」处理，绝不能把它当 trackId 去查轨道（会误报「已锁定」）。
        const normalizedIntent: AssetPlacementIntent =
          intent && typeof intent === 'object' && 'kind' in intent
            ? intent
            : { kind: 'auto', time: typeof intent === 'number' ? intent : state.playhead }
        // 落点规则集中在 core/assetPlacement（纯函数），store 只负责执行命令。
        const placement = resolveAssetPlacement(state.project, asset, normalizedIntent)
        if (placement.target === 'blocked') {
          state.notify(placement.message, 'warning')
          return
        }
        const kind = assetKindOf(asset)

        if (placement.target === 'audio') {
          const clip: AudioClip = {
            id: createId('audio'),
            sourceUrl: asset.url,
            sourceStart: 0,
            sourceEnd: Math.max(0.1, asset.duration ?? 0),
            start: placement.start,
            volume: 1,
            fadeIn: 0,
            fadeOut: 0,
          }
          const changed = placement.trackId
            ? run(createAddAudioClipCommand(placement.trackId, clip))
            : run(createAddAudioClipCommand(createId('audioTrack'), clip, placement.newTrackName))
          if (changed) {
            get().selectClip(clip.id)
            get().notify(placement.message, 'success')
          }
          return
        }

        const isImage = kind === 'image'
        const clip: Clip = {
          id: createId('clip'),
          sourceUrl: asset.url,
          sourceStart: 0,
          sourceEnd: isImage ? IMAGE_DEFAULT_DURATION : Math.max(0.1, asset.duration ?? 0),
          type: isImage ? 'image' : 'video',
          rotation: 0,
          flipH: false,
          flipV: false,
          crop: { x: 0, y: 0, w: 1, h: 1 },
          scale: 1,
          position: { x: 0, y: 0 },
          volume: isImage ? 0 : 1,
        }
        const changed =
          placement.target === 'main'
            ? run(createAddClipCommand(clip, null, placement.start))
            : placement.trackId
              ? run(createAddClipCommand(clip, placement.trackId, placement.start))
              : run(
                  createAddClipToNewOverlayTrackCommand(
                    createId('overlayTrack'),
                    placement.newTrackName ?? '叠加轨',
                    clip,
                    placement.start,
                  ),
                )
        if (changed) {
          get().selectClip(clip.id)
          get().notify(placement.message, 'success')
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
        cancelReverseForProjectSwap()
        const empty = createEmptyProject()
        internals.resetHistory(empty)
        set({
          source: null,
          assets: [],
          project: empty,
          // 空会话没有项目身份：首次导入素材时再分配。
          projectId: null,
          projectName: DEFAULT_PROJECT_NAME,
          projectNameEdited: false,
          selectedClipId: null,
          selectedIds: [],
          playhead: 0,
          isPlaying: false,
          exportRange: null,
          cropSession: null,
          previewPatch: null,
          markerEditorId: null,
          exportDialogOpen: false,
          lastAction: '',
          toast: null,
          asrWordsBySource: null,
        })
        // 关闭当前项目（清空会话）：历史栈已 reset，待回收素材一律立即回收。
        reconcilePendingAssets({ force: true })
      },

      execute: (command) => run(command),

      undo: () => {
        const entry = internals.undo()
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
        const entry = internals.redo()
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


















      renameProject: (name) => {
        const next = normalizeProjectName(name)
        const state = get()
        if (state.projectName === next && state.projectNameEdited) return
        set({ projectName: next, projectNameEdited: true })
      },

      adoptProject: (id, name) => {
        // 切项目前先把当前项目落盘，避免「切换发生在自动保存防抖窗口内」丢编辑。
        get().flushProjectSave()
        set({
          projectId: id,
          projectName: normalizeProjectName(name),
          projectNameEdited: true,
        })
        // 接管新项目：旧工程的历史即将被 hydrateDraft 重置，待回收素材按「关闭」处理。
        reconcilePendingAssets({ force: true })
      },

      flushProjectSave: () => {
        const state = get()
        const id = state.projectId
        // 没有项目身份（从未有内容的新会话）不落盘，避免列表里出现空项目。
        if (!id) return
        const snapshot = toDraftSnapshot(state)
        const record = {
          id,
          name: state.projectName,
          updatedAt: Date.now(),
          thumbnail: projectThumbnail(snapshot),
          snapshot,
        }
        void saveProjectRecord(record).catch(() => reportDraftSaveFailure(state.notify))
      },

      setExportInPoint: (time) => {
        const state = get()
        const total = Math.max(0, getProjectEnd(state.project))
        const start = clamp(time ?? state.playhead, 0, total)
        // 还没有区间时另一端取工程终点；已有区间时另一端保持不变。
        const end = state.exportRange?.end ?? total
        const next = clampExportRange({ start, end }, total)
        if (!next) {
          state.notify('入点必须比出点早至少 0.1 秒', 'warning')
          return
        }
        set({ exportRange: next })
        state.notify(
          `导出范围 ${formatClock(next.start)} – ${formatClock(next.end)}（${exportRangeDuration(next).toFixed(1)} 秒）`,
          'success',
        )
      },

      setExportOutPoint: (time) => {
        const state = get()
        const total = Math.max(0, getProjectEnd(state.project))
        const end = clamp(time ?? state.playhead, 0, total)
        // 还没有区间时另一端取工程起点；已有区间时另一端保持不变。
        const start = state.exportRange?.start ?? 0
        const next = clampExportRange({ start, end }, total)
        if (!next) {
          state.notify('出点必须比入点晚至少 0.1 秒', 'warning')
          return
        }
        set({ exportRange: next })
        state.notify(
          `导出范围 ${formatClock(next.start)} – ${formatClock(next.end)}（${exportRangeDuration(next).toFixed(1)} 秒）`,
          'success',
        )
      },

      setExportRangeEdge: (edge, time) => {
        const state = get()
        const range = state.exportRange
        if (!range) return
        const total = Math.max(0, getProjectEnd(state.project))
        const next =
          edge === 'start'
            ? {
                start: clamp(
                  time,
                  0,
                  Math.max(0, range.end - EXPORT_RANGE_MIN_DURATION),
                ),
                end: range.end,
              }
            : {
                start: range.start,
                end: clamp(
                  time,
                  Math.min(total, range.start + EXPORT_RANGE_MIN_DURATION),
                  total,
                ),
              }
        const clamped = clampExportRange(next, total)
        if (!clamped) return
        if (clamped.start === range.start && clamped.end === range.end) return
        set({ exportRange: clamped })
      },

      clearExportRange: () => {
        const state = get()
        if (!state.exportRange) return
        set({ exportRange: null })
        state.notify('已清除导出范围，导出整条时间轴', 'info')
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

      cancelReverse: () => {
        if (!get().reverseJob) return
        internals.getReverseController()?.abort()
        get().notify('正在取消倒放（当前分段结束后停止）…', 'info')
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


    }
  })
}

export type EditorStore = ReturnType<typeof createEditorStore>

/**
 * 能否撤销 / 重做：**派生**自历史摘要，不再是需要手工同步的布尔字段。
 * 组件用 `useEditorStore(selectCanUndo)` 订阅即可。
 */
export const selectCanUndo = (state: EditorState): boolean => state.history.pastLength > 0
export const selectCanRedo = (state: EditorState): boolean => state.history.futureLength > 0