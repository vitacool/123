export { VideoEditor } from './VideoEditor'
export type { VideoEditorProps } from './VideoEditor'
export { createEditorStore } from './store/editorStore'
export type {
  EditorState,
  EditorStore,
  CropSession,
  PreviewPatch,
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
export type { DraftAsset, DraftSettings, DraftSnapshot } from './core/draft'
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
export { buildExportPlan, buildExportArgs } from './core/exportPlan'
export type { ExportInput, ExportPlan } from './core/exportPlan'
export {
  configureFFmpegAssets,
  getRuntimeCapabilities,
} from './services/ffmpegExporter'
export type { TranscribeProvider } from './services/asr/types'
export type { AsrLanguage, AsrWord } from './core/asr'
export type { TimelineWord, WordsBySource } from './core/captionMapping'