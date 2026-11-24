export { VideoEditor } from './VideoEditor'
export type { VideoEditorProps } from './VideoEditor'
export { createEditorStore } from './store/editorStore'
export type {
  EditorState,
  EditorStore,
  CropSession,
  PreviewPatch,
  ReverseJob,
  ToastKind,
  ToastMessage,
} from './store/editorStore'
// 宿主可直接用这些钩子注入/订阅 store（配合 <VideoEditor store={...} />）。
export {
  EditorStoreProvider,
  useEditorStore,
  useEditorStoreApi,
} from './store/EditorProvider'
// 宿主控制句柄（<VideoEditor onReady={(api) => ...} />）。
export { createFrameCutApi, applyProjectToStore } from './api'
export type { FrameCutApi, FrameCutApiOptions, ApplyProjectInput } from './api'
// 工程文件（.framecut.json）读写。
export {
  PROJECT_FILE_KIND,
  PROJECT_FILE_VERSION,
  countLocalAssets,
  createProjectFile,
  downloadProjectFile,
  isLocalAsset,
  parseProjectFile,
  projectFileFromSnapshot,
  projectFileName,
  serializeProjectFile,
} from './projectFile'
export type { ProjectFile, ProjectFileSource } from './projectFile'
// 界面主题（纯界面偏好，不影响作品内容）。
export {
  DEFAULT_FRAMECUT_THEME,
  FRAMECUT_THEME_STORAGE_KEY,
  effectiveTheme,
  isFrameCutTheme,
  parseStoredTheme,
  readStoredTheme,
  resolveTheme,
  toggleTheme,
  writeStoredTheme,
} from './core/theme'
export type { FrameCutTheme, ResolvedTheme, ThemeStorage } from './core/theme'
export type { DraftAsset, DraftSettings, DraftSnapshot } from './core/draft'
// 形状蒙版（阶段 A：静态参数，无关键帧）。
export {
  MASK_DEFAULTS,
  MASK_SHAPES,
  drawMaskShape,
  maskShortSide,
  normalizeMask,
  supportsMask,
} from './core/mask'
export type { MaskCanvasTarget } from './core/mask'
export type { ClipMask, MaskShape } from './core/types'
// 最近项目（多草稿）：纯逻辑与存储 API。
export {
  DEFAULT_PROJECT_NAME,
  PROJECT_LIMIT,
  collectReferencedMediaIds,
  formatProjectUpdatedAt,
  localMediaIds,
  mediaIdsToDelete,
  normalizeProjectName,
  projectLimitReached,
  projectNameFromSource,
  projectThumbnail,
  sortProjectRecords,
  type DraftProjectRecord,
} from './core/projectLibrary'
export {
  countProjectRecords,
  deleteDraftProject,
  loadProjectRecord,
  loadProjectRecords,
  saveProjectRecord,
} from './services/draftStore'
// 素材读取（宿主也可用同一套探测逻辑）。
export { readAssetFile, isSupportedMedia, remoteName } from './services/assetReader'
export type { ReadAssetOptions } from './services/assetReader'
export { terminateFFmpegRuntime } from './services/ffmpegExporter'
export type {
  AspectRatioPreset,
  CaptionStyle,
  Clip,
  CropRect,
  ExportFps,
  ExportLoudness,
  ExportQuality,
  ExportResolution,
  Marker,
  Point,
  Project,
  SourceInfo,
  TimelineSegment,
} from './core/types'
export { createEmptyProject, createInitialProject } from './core/operations'
export { HistoryStack } from './core/history'
export type { EditorCommand } from './core/commands'
export { buildExportPlan, buildExportArgs, buildAudioExportPlan, buildAudioExportArgs, applyExportRangeTrim } from './core/exportPlan'
export type { AudioExportFormat, BuildExportOptions, ExportInput, ExportPlan } from './core/exportPlan'
// 导出区间（入点 / 出点）。
export {
  EXPORT_RANGE_MIN_DURATION,
  clampExportRange,
  exportRangeDuration,
} from './core/exportRange'
export type { ExportRange } from './core/exportRange'
// 导出当前帧（离屏合成：图层排序 + 尺寸 / 文件名纯函数）。
export {
  composeFrame,
  frameCaptureSize,
  frameCompositionAt,
  frameFileName,
} from './core/frameCompose'
export type {
  ComposeFrameInput,
  FrameComposition,
  FrameImage,
  FrameLayer,
} from './core/frameCompose'
export { captureFrameBlob, frameCaptureWarning } from './services/frameCapture'
export type { CaptureFrameInput, CaptureFrameResult } from './services/frameCapture'
// 倒放（生成倒放素材）：纯计算 + 生成服务。
export {
  mirrorAnimationTimes,
  replaceClipSourceInProject,
  reverseAssetFileName,
  reverseAssetName,
  reverseChunks,
  reverseScalePlan,
} from './core/reverse'
export type { ReverseChunk, ReplaceClipSourceInput } from './core/reverse'
export { isReverseAbort, reverseAssetSpan } from './services/reverseMedia'
export type { ReverseMediaOptions } from './services/reverseMedia'
export {
  configureFFmpegAssets,
  getRuntimeCapabilities,
} from './services/ffmpegExporter'
export type {
  ExportFormat,
  ExportOptions,
} from './services/ffmpegExporter'
export type { TranscribeProvider } from './services/asr/types'
export { configureAsrAssets } from './services/asr/assets'
export type { AsrLanguage, AsrWord } from './core/asr'
export type { TimelineWord, WordsBySource } from './core/captionMapping'