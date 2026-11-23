import { type AssetPlacementIntent } from '../core/assetPlacement'
import type { ChromaKey } from '../core/chromaKey'
import { createStore } from 'zustand/vanilla'
import { type CropPresetId } from '../core/constants'
import type { EditorCommand } from '../core/commands'
import type { TrackOrderKind } from '../core/operations'
import type { DraftSettings, MissingAsset } from '../core/draft'
import {
  type FrameCutTheme,
  type ResolvedTheme,
} from '../core/theme'
import { type ExportRange } from '../core/exportRange'
import { createStoreInternals, type HistoryState } from './internal'
import { createAssetsSlice } from './slices/assets'
import { createEditingSlice } from './slices/editing'
import { createExportSlice } from './slices/export'
import { createHistorySlice } from './slices/history'
import { createPersistenceSlice } from './slices/persistence'
import { createPlaybackSlice } from './slices/playback'
import { createSelectionSlice } from './slices/selection'
import { createUiSlice } from './slices/ui'
import { createEmptyProject } from '../core/operations'
import { type SubtitleCue } from '../core/text'
import { type ColorAdjustments } from '../core/color'
import type { KeyframeRef } from '../core/keyframeEdit'
import { type ClipboardPayload } from '../core/clipboard'
import type { TimelineWord, WordsBySource } from '../core/captionMapping'
import { type TrackFlag, type TrackKind } from '../core/tracks'
import { type AnimatableProperty, type AspectRatioPreset, type Easing, type AudioClip, type BlendMode, type CanvasBackground, type TransitionType, type CaptionStyle, type Clip, type ClipMask, type CoverMode, type CropRect, type ExportQuality, type Marker, type MediaAsset, type Project, type SourceInfo, type TextClip } from '../core/types'

/** 时间轴上的可选中片段顺序（主轨 → 叠加轨 → 音频轨 → 文本轨，各按时间排序）。 */


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
   * 工程引用、但本地没有 Blob 的素材（占位片段）。
   * 它们在素材库里不显示，只用于把缺失片段保留在时间轴上，并随草稿一起持久化。
   */
  missingAssets: MissingAsset[]
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
    /** 工程引用、但本地没有 Blob 的素材（占位片段）。缺省 = 没有占位。 */
    missingAssets?: MissingAsset[]
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



/** 封面出图尺寸：跟随画布比例，短边 ≤1280（与 core/cover 的规则一致）。 */



export function createEditorStore() {
  const initial = createEmptyProject()

  return createStore<EditorState>()((set, get) => {
  /** 共享内核：历史栈、命令执行、状态同步、素材回收（见 store/internal.ts）。 */
  const internals = createStoreInternals(get, set, initial)




  /** 统一的选中入口：写 selectedIds，并派生 selectedClipId。 */




    /** 把封面写入工程历史（1 步撤销），成功后提示。 */


    return {
      ...createUiSlice({ get, set, internals }),
      ...createPlaybackSlice({ get, set, internals }),
      ...createSelectionSlice({ get, set, internals }),
      ...createAssetsSlice({ get, set, internals }),
      ...createExportSlice({ get, set, internals }),
      ...createPersistenceSlice({ get, set, internals }),
      ...createHistorySlice({ get, set, internals, initialProject: initial }),
      ...createEditingSlice({ get, set, internals }),
      cropSession: null,
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