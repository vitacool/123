import { useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  ChangeEvent, DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, } from 'react'
import { MAX_RECOMMENDED_FILE_BYTES } from './core/constants'
import {
  DEFAULT_FRAMECUT_THEME, readStoredTheme, resolveTheme, writeStoredTheme, type FrameCutTheme, type ResolvedTheme, } from './core/theme'
import { getProjectEnd } from './core/timeline'
import { frameCaptureSize, frameFileName } from './core/frameCompose'
import { captureFrameBlob, frameCaptureWarning } from './services/frameCapture'
import type { MediaAsset, Project, SourceInfo } from './core/types'
import { createEditorStore } from './store/editorStore'
import type { EditorStore } from './store/editorStore'
import { EditorStoreProvider, useEditorStore, useEditorStoreApi } from './store/EditorProvider'
import {
  createFrameCutApi, applyProjectToStore, type FrameCutApi, } from './api'
import {
  countLocalAssets, createProjectFile, downloadProjectFile, isLocalAsset, parseProjectFile, type ProjectFile, } from './projectFile'
import { projectMediaUrls, type DraftAsset, type MissingAsset } from './core/draft'
import { assetKindOf } from './core/assets'
import {
  applyPickOutcome, countClipReferences, emptyMissingAssetsSelection, mergeMissingAssets,
  missingAssetFromDraft, missingAssetsForUnpicked, missingSelectionSummary, pendingMissingAssets,
  skipAllMissingAssets, skipMissingAsset, type MissingAssetsSelection } from './core/missingAssets'
import { pickFilesWithCancel } from './services/assetPicker'
import { MissingAssetsDialog, type MissingAssetRow } from './components/MissingAssetsDialog'
import {
  captureThumbnail, isSupportedMedia, readAssetFile, remoteName, waitForVideoMetadata, } from './services/assetReader'
import { configureFFmpegAssets } from './services/ffmpegExporter'
import { parseSubtitleText } from './core/text'
import type { TranscribeProvider } from './services/asr/types'
import {
  countProjectRecords, deleteDraftProject, hasProjectRecord, loadProjectRecords, persistImportedAssets, reportDraftSaveFailure, restoreDraft, saveMediaBlob, toDraftAsset, buildDraftRecord, saveProjectRecordSerialized, saveProjectRecord } from './services/draftStore'
import {
  PROJECT_LIMIT,
  projectLimitReached,
  projectNameFromSource,
  type DraftProjectRecord,
} from './core/projectLibrary'
import { TopBar } from './components/TopBar'
import { ProjectLibrary, type ProjectLibraryProps } from './components/ProjectLibrary'
import { ContextMenu } from './components/ContextMenu'
import { Preview } from './components/Preview'
import { MediaLibrary } from './components/MediaLibrary'
import { CanvasBackgroundPanel } from './components/CanvasBackgroundPanel'
import { CoverPanel } from './components/CoverPanel'
import { PropertiesPanel } from './components/PropertiesPanel'
import { Toolbar } from './components/Toolbar'
import { Timeline } from './components/Timeline'
import { ExportDialog, triggerDownload } from './components/ExportDialog'
import { AutoCaptionDialog } from './components/AutoCaptionDialog'
import { Toast } from './components/Toast'
import { ReverseJobBanner } from './components/ReverseJobBanner'
import { Icon } from './components/Icon'
import './styles/editor.css'

export interface VideoEditorProps {
  /** A local File or an existing video URL supplied by the host platform. */
  initialVideo?: File | string | null
  /** Called once FFmpeg.wasm has produced the final MP4. */
  onExport?: (blob: Blob) => void
  /** Called with the separately exported cover image (mode=separate). */
  onCoverExport?: (blob: Blob) => void
  /** Called when the user asks to leave the editor. */
  onCancel?: () => void
  /**
   * Optional base URL of the directory that contains `core/` and `core-mt/`.
   * Defaults to `${BASE_URL}ffmpeg/`.
   */
  ffmpegBaseUrl?: string
  /** Optional host-injected speech engine; defaults to the built-in Whisper. */
  transcribeProvider?: TranscribeProvider
  className?: string
  /**
   * 宿主自建的 store（`createEditorStore()`）。传入后编辑器不再自建，
   * 宿主可以直接 `useEditorStore` 订阅同一份状态。
   */
  store?: EditorStore
  /** store 初始化完成后调用一次，把控制句柄交给宿主。 */
  onReady?: (api: FrameCutApi) => void
  /** project 变化时防抖 500ms 回调（与草稿保存共用同一个订阅）。 */
  onProjectChange?: (project: Project) => void
  /**
   * 是否启用「最近项目」多草稿模式，默认开启。
   * 传 `false` 可关闭项目列表（宿主模式通常希望自己管理入口）。
   * 注：注入了 `store` 或传了 `initialVideo` 时，无论该值如何都不会弹出项目列表。
   */
  projects?: boolean
  /**
   * 界面主题偏好：'light' | 'dark' | 'system'。
   * 传了就是**受控模式**：以宿主为准，不读也不写 localStorage，切换时调用 onThemeChange。
   * 不传则是非受控模式：默认 'system'，偏好存 localStorage。
   */
  theme?: FrameCutTheme
  /** 受控模式下，用户点击主题按钮时回调（由宿主决定是否改变 theme）。 */
  onThemeChange?: (theme: FrameCutTheme) => void
}

/** 导入工程时的「缺失素材」选择状态。 */
interface ProjectImportState {
  file: ProjectFile
  /** 需要用户提供文件的素材（工程文件里的本地素材）。 */
  items: DraftAsset[]
  selection: MissingAssetsSelection
}

function useSourceLoader(
  activeVideo: File | string | null,
  store: ReturnType<typeof createEditorStore>,
  setError: (message: string | null) => void,
  setLoading: (loading: boolean) => void,
) {
  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    let loader: HTMLVideoElement | null = null

    const run = async () => {
      store.getState().clearSource()
      setError(null)
      if (!activeVideo) {
        setLoading(false)
        return
      }
      setLoading(true)

      const isFile = activeVideo instanceof File
      const name = isFile ? activeVideo.name : remoteName(activeVideo)
      const url = isFile ? URL.createObjectURL(activeVideo) : activeVideo
      if (isFile) objectUrl = url
      const file = isFile ? activeVideo : undefined
      const size = file?.size ?? 0

      loader = document.createElement('video')
      loader.preload = 'auto'
      loader.muted = true
      loader.playsInline = true
      loader.src = url
      try {
        await waitForVideoMetadata(loader)
        if (cancelled) return
        const duration = loader.duration
        const width = loader.videoWidth
        const height = loader.videoHeight
        const source: SourceInfo = {
          url,
          name,
          size,
          duration,
          width,
          height,
          file,
        }
        store.getState().loadSource(source)
        const loadedAsset = store.getState().assets[0]
        if (loadedAsset?.file) {
          void saveMediaBlob(loadedAsset.id, loadedAsset.file).catch(() =>
            reportDraftSaveFailure(store.getState().notify),
          )
        }
        setLoading(false)
        if (file && file.size > MAX_RECOMMENDED_FILE_BYTES) {
          store
            .getState()
            .notify('文件超过 500MB，浏览器合成可能需要较长的时间。', 'warning')
        }

        const thumbnail = await captureThumbnail(loader, duration)
        if (cancelled) return
        if (thumbnail && store.getState().source?.url === url) {
          store.getState().updateSourceMeta({ thumbnail })
        }
      } catch (caught) {
        if (cancelled) return
        const base =
          caught instanceof Error && caught.message
            ? caught.message
            : '无法读取这个视频文件。'
        setError(
          `${base} 请确认文件完整，或换用 H.264 MP4 / WebM 编码。`,
        )
        setLoading(false)
        store.getState().clearSource()
      } finally {
        if (loader) {
          loader.pause()
          loader.removeAttribute('src')
          try {
            loader.load()
          } catch {
            // Detached media teardown is best-effort.
          }
        }
      }
    }

    void run()
    return () => {
      cancelled = true
      if (loader) {
        loader.pause()
        loader.removeAttribute('src')
        try {
          loader.load()
        } catch {
          // Best-effort cleanup.
        }
      }
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [activeVideo, store, setError, setLoading])
}

interface EditorShellProps {
  loading: boolean
  error: string | null
  onPickFile: () => void
  onImportFiles: (files: File[]) => void
  onNewProject: () => void
  onImportSubtitles: () => void
  onExport?: (blob: Blob) => void
  onCoverExport?: (blob: Blob) => void
  onExportProject: () => void
  onImportProject: () => void
  loadingLabel?: string | null
  onCancel?: () => void
  transcribeProvider?: TranscribeProvider
  /** 「最近项目」列表的数据与回调；null 表示不启用多草稿 UI。 */
  projectLibrary?: ProjectLibraryProps | null
  /** 本地多草稿模式下：打开项目列表（TopBar 的「项目」按钮）。 */
  onOpenProjects?: () => void
  /** 本地多草稿模式下：新建空项目。 */
  onNewProjectShortcut?: () => void
  /** 当前实际生效的主题（system 已在 VideoEditor 里解析）。 */
  theme: ResolvedTheme
  /** 主题偏好（用于顶部按钮显示当前是 light / dark / system）。 */
  themePreference: FrameCutTheme
  /** 用户通过顶部按钮切换主题。 */
  onSelectTheme: (theme: FrameCutTheme) => void
  /** 追加在 root 内的浮层（弹窗）；保证样式作用域仍在 `.framecut-root` 下。 */
  overlay?: ReactNode
}

function EditorShell({
  loading,
  error,
  onPickFile,
  onImportFiles,
  onNewProject,
  onImportSubtitles,
  onExport,
  onCoverExport,
  onExportProject,
  onImportProject,
  onCancel,
  loadingLabel,
  transcribeProvider,
  projectLibrary,
  onOpenProjects,
  onNewProjectShortcut,
  theme,
  themePreference,
  onSelectTheme,
  overlay,
}: EditorShellProps) {
  const [autoCaptionOpen, setAutoCaptionOpen] = useState(false)
  const [backgroundOpen, setBackgroundOpen] = useState(false)
  const [projectMenu, setProjectMenu] = useState<{ x: number; y: number } | null>(null)
  /** 首帧之后再打开颜色过渡，避免首次加载（尤其暗色）出现闪变。 */
  const [themeReady, setThemeReady] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setThemeReady(true), 60)
    return () => window.clearTimeout(timer)
  }, [])
  const store = useEditorStoreApi()
  const source = useEditorStore((state) => state.source)
  const projectName = useEditorStore((state) => state.projectName)
  const renameProject = useEditorStore((state) => state.renameProject)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [dragActive, setDragActive] = useState(false)

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    if (source) rootRef.current?.focus({ preventScroll: true })
  }, [source?.url])

  /**
   * 导出当前帧：把播放头所在画面按导出分辨率合成成 PNG 并下载。
   * 素材缺失 / seek 失败只提示（warning），不会抛出未处理的异常。
   */
  const captureCurrentFrame = async () => {
    const state = store.getState()
    const total = getProjectEnd(state.project)
    if (total <= 0) {
      state.notify('时间轴为空，无法导出画面', 'warning')
      return
    }
    if (state.cropSession) {
      state.notify('正在裁剪画面，先完成或取消裁剪', 'warning')
      return
    }
    const time = Math.max(0, Math.min(state.playhead, total))
    const size = frameCaptureSize(state.project, state.source ?? state.assets[0] ?? null)
    state.notify('正在导出当前帧…', 'info')
    let result: Awaited<ReturnType<typeof captureFrameBlob>>
    try {
      result = await captureFrameBlob({
        project: state.project,
        assets: state.assets,
        time,
        width: size.width,
        height: size.height,
      })
    } catch {
      // captureFrameBlob 理论上不会抛；这里兜底，避免任何未处理的异常。
      state.notify('当前帧导出失败', 'warning')
      return
    }
    if (!result.blob) {
      state.notify('当前帧导出失败', 'warning')
      return
    }
    const fileName = frameFileName(
      state.source?.name ?? state.assets[0]?.name ?? null,
      time,
      state.project.exportQuality.fps,
    )
    triggerDownload(result.blob, fileName)
    // 只弹一个提示：有缺失时 warning 优先，避免被 success 覆盖。
    const warning = frameCaptureWarning(result.failures)
    if (warning) {
      state.notify(`已导出 ${fileName}，但有部分画面缺失：${warning}`, 'warning')
    } else {
      state.notify(`已导出当前帧 ${fileName}`, 'success')
    }
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return
    const target = event.target as HTMLElement
    if (
      target.closest('input, textarea, select, [contenteditable="true"]') ||
      target.isContentEditable
    ) {
      return
    }
    const state = store.getState()
    if (state.exportDialogOpen) return
    if (event.repeat) return
    const key = event.key.toLowerCase()
    const modifier = event.ctrlKey || event.metaKey

    if (state.cropSession) {
      if (key === 'escape') {
        event.preventDefault()
        state.cancelCrop()
      }
      return
    }

    if (modifier && key === 'z') {
      event.preventDefault()
      if (event.shiftKey) state.redo()
      else state.undo()
      return
    }
    if (modifier && key === 'y') {
      event.preventDefault()
      state.redo()
      return
    }
    if (modifier && key === 'b') {
      event.preventDefault()
      state.splitAtPlayhead()
      return
    }
    // 多选与剪贴板
    if (modifier && key === 'a') {
      event.preventDefault()
      state.selectAll()
      return
    }
    if (modifier && key === 'c') {
      event.preventDefault()
      state.copySelection()
      return
    }
    if (modifier && key === 'x') {
      event.preventDefault()
      state.cutSelection()
      return
    }
    if (modifier && key === 'v') {
      event.preventDefault()
      state.pasteAtPlayhead()
      return
    }
    // 导出当前帧：Ctrl/⌘ + Shift + S（不与已有的 Ctrl+S/其他组合冲突）。
    if (modifier && event.shiftKey && key === 's') {
      event.preventDefault()
      void captureCurrentFrame().catch(() => undefined)
      return
    }
    if (!modifier && key === 'q') {
      state.trimLeftAtPlayhead()
      return
    }
    if (!modifier && key === 'w') {
      state.trimRightAtPlayhead()
      return
    }
    if (!modifier && key === 'm') {
      state.addMarker()
      return
    }
    // 导出区间打点：I = 入点，O = 出点，Alt+X = 清除（都只在无修饰键时生效，
    // 与 Ctrl+X「剪切」区分开）。
    // 用 event.code 而不是 event.key：macOS 上 Option+X 的 key 是 '≈'（Option+I/O
    // 也会变成别的字符），只有物理键位 code 稳定；输入框里由上面的早退挡住。
    if (!modifier && !event.altKey && !event.shiftKey && event.code === 'KeyI') {
      event.preventDefault()
      state.setExportInPoint()
      return
    }
    if (!modifier && !event.altKey && !event.shiftKey && event.code === 'KeyO') {
      event.preventDefault()
      state.setExportOutPoint()
      return
    }
    if (event.altKey && !modifier && !event.shiftKey && event.code === 'KeyX') {
      event.preventDefault()
      state.clearExportRange()
      return
    }
    if (!modifier && (key === 'delete' || key === 'backspace')) {
      event.preventDefault()
      state.deleteSelectedClip()
      return
    }
    // ←/→ 逐帧；Shift+←/→ 1 秒
    if (!modifier && key === 'arrowleft') {
      event.preventDefault()
      if (event.shiftKey) state.nudgePlayhead(-1)
      else state.stepPlayheadFrames(-1)
      return
    }
    if (!modifier && key === 'arrowright') {
      event.preventDefault()
      if (event.shiftKey) state.nudgePlayhead(1)
      else state.stepPlayheadFrames(1)
      return
    }
    // ↑/↓ 上/下一个剪辑点
    if (!modifier && key === 'arrowup') {
      event.preventDefault()
      state.jumpToEditPoint('prev')
      return
    }
    if (!modifier && key === 'arrowdown') {
      event.preventDefault()
      state.jumpToEditPoint('next')
      return
    }
    if (!modifier && key === 'home') {
      event.preventDefault()
      state.setPlayhead(0)
      return
    }
    if (!modifier && key === 'end') {
      event.preventDefault()
      state.setPlayhead(getProjectEnd(state.project))
      return
    }
    // 时间轴适应窗口：Ctrl+Shift+= / Ctrl+Shift+- / Shift+Z
    if (modifier && event.shiftKey && (key === '=' || key === '+' || key === '-' || key === '_')) {
      event.preventDefault()
      state.zoomToFit()
      return
    }
    if (!modifier && event.shiftKey && key === 'z') {
      event.preventDefault()
      state.zoomToFit()
      return
    }
    // 全屏预览
    if (!modifier && key === 'f') {
      event.preventDefault()
      state.setPreviewFullscreen(true)
      return
    }
    if (!modifier && key === 'escape') {
      if (state.previewFullscreen) {
        event.preventDefault()
        state.setPreviewFullscreen(false)
      }
      return
    }
    if (!modifier && key === ' ') {
      if (target.closest('button, a, [role="button"]')) return
      event.preventDefault()
      state.togglePlay()
    }
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as Element
    if (target.closest('input, textarea, select, button, a')) return
    if (document.activeElement !== rootRef.current) {
      rootRef.current?.focus({ preventScroll: true })
    }
  }

  const hasFiles = (event: ReactDragEvent) =>
    Array.from(event.dataTransfer.types).includes('Files')

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragActive(false)
    const files = Array.from(event.dataTransfer.files ?? [])
    if (files.length > 0) onImportFiles(files)
  }

  return (
    <div
      className={`framecut-root${themeReady ? ' is-theme-ready' : ''}`}
      data-theme={theme}
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onDragEnter={(event) => {
        if (!hasFiles(event)) return
        event.preventDefault()
        setDragActive(true)
      }}
      onDragOver={(event) => {
        if (!hasFiles(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setDragActive(false)
      }}
      onDrop={handleDrop}
      aria-label="帧刻视频编辑器"
    >
      <TopBar
        onProjectMenu={(anchor) =>
          setProjectMenu({ x: anchor.left, y: anchor.bottom + 6 })
        }
        onCaptureFrame={() => void captureCurrentFrame().catch(() => undefined)}
        projectName={projectName}
        onRenameProject={renameProject}
        onOpenProjects={onOpenProjects}
        // 草稿模式下用内部「新建空项目」；宿主模式（没有多草稿 UI）下退回宿主回调，
        // 这样删掉素材库「更多」菜单后，「新建项目」在两种模式下都有入口。
        onNewProject={onNewProjectShortcut ?? onNewProject}
        theme={theme}
        themePreference={themePreference}
        onSelectTheme={onSelectTheme}
        onCancel={
          onCancel
            ? () => {
                store.getState().setPlaying(false)
                onCancel()
              }
            : undefined
        }
      />
      <div className="workspace">
        <MediaLibrary onImport={onPickFile} />
        <Preview onPickFile={onPickFile} loading={loading} error={error} loadingLabel={loadingLabel} />
        {/* 右栏常驻：避免未选中时预览区被 306px 的宽度跳变挤动 */}
        <PropertiesPanel />
      </div>
      <Toolbar
        onAutoCaption={() => setAutoCaptionOpen(true)}
        onImportSubtitles={onImportSubtitles}
      />
      <Timeline onPickFile={onPickFile} />
      {projectMenu && (
        <ContextMenu
          x={projectMenu.x}
          y={projectMenu.y}
          ariaLabel="工程"
          onClose={() => setProjectMenu(null)}
          items={[
            {
              label: '导出工程（.framecut.json）',
              onSelect: onExportProject,
            },
            {
              label: '导入工程…',
              onSelect: onImportProject,
            },
            ...(onOpenProjects
              ? [
                  { label: '最近项目…', separator: true, onSelect: onOpenProjects },
                  ...(onNewProjectShortcut
                    ? [{ label: '新建项目', onSelect: onNewProjectShortcut }]
                    : []),
                ]
              : []),
          ]}
        />
      )}
      {projectLibrary && <ProjectLibrary {...projectLibrary} />}
      <AutoCaptionDialog open={autoCaptionOpen} onClose={() => setAutoCaptionOpen(false)} provider={transcribeProvider} />
      <CoverPanel />
      <ExportDialog onExport={onExport} onCoverExport={onCoverExport} />
      {backgroundOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setBackgroundOpen(false)
          }}
        >
          <div className="export-dialog background-dialog" role="dialog" aria-modal="true" aria-label="画布背景">
            <div className="export-head">
              <h2>画布背景</h2>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭"
                title="关闭（Esc）"
                onClick={() => setBackgroundOpen(false)}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
            <div className="background-dialog-body">
              <CanvasBackgroundPanel />
            </div>
          </div>
        </div>
      )}
      {overlay}
      <Toast />
      <ReverseJobBanner />
      {dragActive && (
        <div className="drop-overlay">
          <span className="drop-icon">
            <Icon name="upload" size={24} />
          </span>
          <strong>松手导入视频</strong>
          <span>原文件不会被修改</span>
        </div>
      )}
    </div>
  )
}

export function VideoEditor({
  initialVideo = null,
  onExport,
  onCancel,
  ffmpegBaseUrl,
  transcribeProvider,
  className,
  store: injectedStore,
  onReady,
  onProjectChange,
  projects = true,
  theme: themeProp,
  onThemeChange,
}: VideoEditorProps) {
  // 宿主可注入 store（多实例/外部订阅）；未注入时编辑器自建一个。
  const [internalStore] = useState(() => createEditorStore())
  const store = injectedStore ?? internalStore
  // 宿主模式（注入 store 或指定初始视频）不弹项目列表，保持原有自动恢复行为。
  const libraryEnabled = projects && !injectedStore && !initialVideo
  /** 受控/非受控主题：传了 prop 就完全听宿主的（不读不写 localStorage）。 */
  const themeControlled = themeProp !== undefined
  const [storedTheme, setStoredTheme] = useState<FrameCutTheme>(() => {
    if (themeControlled) return themeProp as FrameCutTheme
    // localStorage 不可用（隐私模式 / iframe 沙箱）时静默回退默认值。
    if (typeof window === 'undefined') return DEFAULT_FRAMECUT_THEME
    return readStoredTheme(window.localStorage)
  })
  const themePreference = themeControlled ? (themeProp as FrameCutTheme) : storedTheme
  /** system 的解析结果（matchMedia 实时跟随）。 */
  const [systemDark, setSystemDark] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })
  const resolvedTheme = resolveTheme(themePreference, systemDark)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [libraryRecords, setLibraryRecords] = useState<DraftProjectRecord[]>([])
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [activeVideo, setActiveVideo] = useState<File | string | null>(initialVideo)
  const [loading, setLoading] = useState(Boolean(initialVideo))
  const [loadingLabel, setLoadingLabel] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const subtitleInputRef = useRef<HTMLInputElement | null>(null)
  const projectFileInputRef = useRef<HTMLInputElement | null>(null)
  const assetPickInputRef = useRef<HTMLInputElement | null>(null)
  /** 缺失素材对话框当前状态（ref 供 await 之后读最新值）。 */
  const projectImportRef = useRef<ProjectImportState | null>(null)
  const [projectImport, setProjectImport] = useState<ProjectImportState | null>(null)
  // 渲染提交后再同步 ref：异步回调总能读到最新状态，而 setState updater 保持纯函数。
  useEffect(() => {
    projectImportRef.current = projectImport
  }, [projectImport])
  const importedUrlsRef = useRef<string[]>([])
  const restoringRef = useRef(true)
  // 宿主回调放进 ref：内联箭头函数不应导致重新订阅/重复触发 onReady。
  const onReadyRef = useRef(onReady)
  const onProjectChangeRef = useRef(onProjectChange)
  /** 受控主题的最新回调（放进 ref，避免 api 句柄闭包拿到旧函数）。 */
  const onThemeChangeRef = useRef(onThemeChange)
  const apiRef = useRef<FrameCutApi | null>(null)

  useEffect(() => {
    onReadyRef.current = onReady
  }, [onReady])

  useEffect(() => {
    onThemeChangeRef.current = onThemeChange
  }, [onThemeChange])

  useEffect(() => {
    onProjectChangeRef.current = onProjectChange
  }, [onProjectChange])

  // ======================================================================
  // 主题：system → light/dark 的实时解析；受控模式完全以宿主 prop 为准。
  // ======================================================================
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (event: MediaQueryListEvent | MediaQueryList) => setSystemDark(event.matches)
    apply(query)
    // 系统主题变化时实时跟随（旧浏览器回退到 addListener）。
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', apply as (event: MediaQueryListEvent) => void)
      return () =>
        query.removeEventListener('change', apply as (event: MediaQueryListEvent) => void)
    }
    const legacy = query as MediaQueryList & {
      addListener?: (fn: (event: MediaQueryListEvent) => void) => void
      removeListener?: (fn: (event: MediaQueryListEvent) => void) => void
    }
    legacy.addListener?.(apply as (event: MediaQueryListEvent) => void)
    return () => legacy.removeListener?.(apply as (event: MediaQueryListEvent) => void)
  }, [])

  // 把偏好与实际主题同步进 store（顶部按钮、Canvas 界面元素都读 store）。
  useEffect(() => {
    store.getState().setTheme(themePreference)
    store.getState().setResolvedTheme(resolvedTheme)
  }, [store, themePreference, resolvedTheme])

  // 非受控模式：把偏好写回 localStorage（写失败静默）。
  useEffect(() => {
    if (themeControlled) return
    if (typeof window === 'undefined') return
    writeStoredTheme(window.localStorage, storedTheme)
  }, [themeControlled, storedTheme])

  /** 用户切换主题：受控模式交给宿主，非受控模式自己保存。 */
  const selectTheme = (next: FrameCutTheme) => {
    if (themeControlled) {
      onThemeChangeRef.current?.(next)
      return
    }
    setStoredTheme(next)
  }

  // store 就绪后创建控制句柄并交给宿主（只调用一次）。
  useEffect(() => {
    const api = createFrameCutApi({
      store,
      theme: {
        get: () => store.getState().theme,
        set: (next) => selectTheme(next),
      },
    })
    apiRef.current = api
    onReadyRef.current?.(api)
    return () => {
      apiRef.current = null
    }
  }, [store])

  useEffect(() => {
    return () => {
      // 组件卸载：编辑器马上不存在，没人能再撤销 → 待回收素材一律立即回收。
      store.getState().disposePendingAssets()
      for (const url of importedUrlsRef.current) URL.revokeObjectURL(url)
      importedUrlsRef.current = []
    }
  }, [store])

  useEffect(() => {
    configureFFmpegAssets(ffmpegBaseUrl)
  }, [ffmpegBaseUrl])

  useEffect(() => {
    if (initialVideo) {
      restoringRef.current = false
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const records = await loadProjectRecords()
        if (cancelled) return
        setLibraryRecords(records)
        if (libraryEnabled) {
          // 本地多草稿模式：先展示「最近项目」，由用户选择打开哪个项目。
          setLibraryOpen(true)
          return
        }
        // 宿主模式 / 关闭项目列表：保持原有「恢复上次草稿」行为，打开最近更新的项目。
        const latest = records[0]
        if (!latest) return
        const restored = await restoreDraft(latest.snapshot)
        if (!restored || cancelled) return
        restoringRef.current = true
        store.getState().adoptProject(latest.id, latest.name)
        store.getState().hydrateDraft(restored)
        for (const asset of restored.assets) {
          if (asset.url.startsWith('blob:')) importedUrlsRef.current.push(asset.url)
        }
        store.getState().notify(`已恢复项目「${latest.name}」`, 'info')
      } catch {
        // 损坏的草稿不应阻塞编辑器。
      } finally {
        if (!cancelled) restoringRef.current = false
      }
    })()
    return () => {
      cancelled = true
    }
  }, [initialVideo, store, libraryEnabled])

  /** 重新读取「最近项目」列表。 */
  const refreshLibrary = async (): Promise<void> => {
    setLibraryLoading(true)
    try {
      const records = await loadProjectRecords()
      setLibraryRecords(records)
    } catch {
      // 读取失败时保留上一次的列表。
    } finally {
      setLibraryLoading(false)
    }
  }

  /** 打开一个已有项目：先 flush 当前项目（store 内完成），再接管新的 id / 名字。 */
  const openProjectRecord = async (record: DraftProjectRecord) => {
    restoringRef.current = true
    try {
      const restored = await restoreDraft(record.snapshot)
      if (!restored) {
        store.getState().notify('该项目里的素材都不可用，无法打开', 'warning')
        return
      }
      store.getState().adoptProject(record.id, record.name)
      store.getState().hydrateDraft(restored)
      for (const asset of restored.assets) {
        if (asset.url.startsWith('blob:')) importedUrlsRef.current.push(asset.url)
      }
      setLibraryOpen(false)
      setError(null)
      setLoading(false)
    } catch {
      store.getState().notify('打开项目失败', 'warning')
    } finally {
      restoringRef.current = false
    }
  }

  /** 重命名项目（当前打开的项目同时更新 store 里的名字）。 */
  const renameProjectRecord = async (record: DraftProjectRecord, name: string) => {
    const updated: DraftProjectRecord = { ...record, name, updatedAt: Date.now() }
    try {
      await saveProjectRecord(updated)
      setLibraryRecords((current) =>
        current.map((item) => (item.id === record.id ? updated : item)),
      )
      if (store.getState().projectId === record.id) store.getState().renameProject(name)
    } catch {
      reportDraftSaveFailure(store.getState().notify)
    }
  }

  /** 删除项目：只回收不再被其它项目引用的媒体 blob。 */
  const deleteProjectRecord = async (record: DraftProjectRecord) => {
    if (
      !window.confirm(
        `删除项目「${record.name}」？该项目的草稿会从这台电脑上永久删除（其它项目不受影响）。`,
      )
    ) {
      return
    }
    try {
      await deleteDraftProject(record.id)
      if (store.getState().projectId === record.id) {
        store.getState().clearSource()
        setActiveVideo(null)
        setLibraryOpen(libraryEnabled)
      }
      setLibraryRecords((current) => current.filter((item) => item.id !== record.id))
      store.getState().notify(`已删除项目「${record.name}」`, 'info')
    } catch {
      store.getState().notify('删除项目失败', 'warning')
    }
  }

  useEffect(() => {
    let draftTimer = 0
    let projectTimer = 0
    const unsubscribe = store.subscribe((state, previous) => {
      // 宿主回调：project 变化时防抖 500ms（与草稿保存共用同一个订阅）。
      if (state.project !== previous.project) {
        const hostNotify = onProjectChangeRef.current
        if (hostNotify) {
          window.clearTimeout(projectTimer)
          projectTimer = window.setTimeout(() => {
            hostNotify(store.getState().project)
          }, 500)
        }
      }
      if (restoringRef.current) return
      // 改名是一次明确的离散操作，不能等 700ms 的防抖保存：
      // 「最近项目」列表用的是 libraryRecords 快照、打开列表时又会重新读库，
      // 所以这里立刻把内存列表里的名字同步好并马上落盘，避免看到旧名字。
      // 只处理「同名项目、同一个 projectId」的纯改名：adoptProject（切换项目）
      // 也会改 projectName，但那一刻工程内容还没 hydrate，落盘会把旧内容写进新 id。
      if (
        state.projectName !== previous.projectName &&
        state.projectId &&
        state.projectId === previous.projectId
      ) {
        const renamedId = state.projectId
        const renamedName = state.projectName
        setLibraryRecords((current) =>
          current.map((item) =>
            item.id === renamedId ? { ...item, name: renamedName, updatedAt: Date.now() } : item,
          ),
        )
        store.getState().flushProjectSave()
      }
      if (
        state.project === previous.project &&
        state.assets === previous.assets &&
        state.source === previous.source &&
        state.timelineZoom === previous.timelineZoom &&
        state.timelineSettings === previous.timelineSettings &&
        state.captionFollow === previous.captionFollow &&
        state.exportRange === previous.exportRange &&
        state.projectId === previous.projectId &&
        state.projectName === previous.projectName
      ) {
        return
      }
      window.clearTimeout(draftTimer)
      draftTimer = window.setTimeout(() => {
        const current = store.getState()
        const id = current.projectId
        // 没有项目身份（从未有内容的新会话）不落盘，避免列表里堆满空项目；
        // 已有项目被清空时仍要保存，否则列表里会留着旧内容。
        if (!id) return
        // 记录组装与 store 的 flushProjectSave 共用 buildDraftRecord。
        const record = buildDraftRecord(current)
        if (!record) return
        void (async () => {
          try {
            // 串行保存：同一项目 id 不会并发写；旧快照会被更新的一次取代。
            // 数量上限检查放在 beforeSave 里 —— 它在队列内部执行，不会与
            // 同 id 的其它保存交叠，也不会出现"旧快照后写覆盖新快照"。
            const { written } = await saveProjectRecordSerialized(record, {
              beforeSave: async () => {
                // 新增项目才检查上限；已有项目的更新永远允许（否则会丢编辑）。
                if (await hasProjectRecord(id)) return true
                const total = await countProjectRecords()
                if (!projectLimitReached(total)) return true
                current.notify(
                  `最多保存 ${PROJECT_LIMIT} 个项目，请先在「最近项目」里删除一个再继续编辑`,
                  'warning',
                )
                return false
              },
            })
            void written
          } catch {
            reportDraftSaveFailure(current.notify)
          }
        })()
      }, 700)
    })
    return () => {
      unsubscribe()
      window.clearTimeout(draftTimer)
      window.clearTimeout(projectTimer)
    }
  }, [store])

  useEffect(() => {
    setActiveVideo(initialVideo ?? null)
  }, [initialVideo])

  useSourceLoader(activeVideo, store, setError, setLoading)

  const pickFile = () => {
    if (!fileInputRef.current) return
    fileInputRef.current.value = ''
    fileInputRef.current.click()
  }

  const importFiles = async (files: File[]) => {
    const media = files.filter(isSupportedMedia)
    if (media.length === 0) {
      setError('仅支持视频或音频文件，请选择 MP4、WebM、MOV、MP3、WAV 等。')
      store.getState().notify('请选择视频或音频文件', 'warning')
      return
    }
    setError(null)
    setLoading(true)
    setLoadingLabel(null)
    const imported: MediaAsset[] = []
    const failures: string[] = []
    let failed = 0
    for (const file of media) {
      try {
        let notified = false
        const asset = await readAssetFile(file, {
          allowTranscode: true,
          onTranscodeStatus: (message) => {
            setLoadingLabel(message)
            if (!notified && message.includes('检测到浏览器不支持')) {
              notified = true
              store.getState().notify('检测到 HEVC 等不兼容编码，正在本地转码…', 'warning')
            }
          },
          onTranscodeProgress: (progress) => {
            setLoadingLabel(`正在转码 H.264 MP4… ${Math.round(progress)}%`)
          },
        })
        importedUrlsRef.current.push(asset.url)
        imported.push(asset)
      } catch (error) {
        failed += 1
        const message = error instanceof Error ? error.message : String(error)
        failures.push(message)
        console.warn(`[FrameCut] 无法读取素材：${file.name}`, error)
      }
    }
    if (imported.length > 0) {
      // 与工程文件导入共用同一实现：刷新后素材必须还能从 IndexedDB 取回来。
      void persistImportedAssets(imported, { notify: store.getState().notify })
      store.getState().addAssets(imported)
      // 从「最近项目」列表里直接导入时，素材到了就回到编辑器。
      setLibraryOpen(false)
    }
    setLoading(false)
    setLoadingLabel(null)
    if (failed > 0) {
      const detail = failures[0] ? `：${failures[0]}` : ''
      setError(`${failed} 个文件无法读取${detail}。HEVC 会自动转 H.264；其他格式请先转为 H.264 MP4 / WebM。`)
      store.getState().notify(`${failed} 个文件读取失败`, 'warning')
    }
  }

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length > 0) void importFiles(files)
  }

  const pickSubtitles = () => {
    if (!subtitleInputRef.current) return
    subtitleInputRef.current.value = ''
    subtitleInputRef.current.click()
  }

  const handleSubtitleInput = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const cues = parseSubtitleText(await file.text())
      if (cues.length === 0) {
        setError('没有解析到字幕条目，请确认是 SRT 或 VTT 文件。')
        store.getState().notify('字幕文件为空或格式不支持', 'warning')
        return
      }
      store.getState().importSubtitles(cues)
      setError(null)
    } catch {
      setError('字幕文件读取失败。')
    }
  }

  const newProject = () => {
    const state = store.getState()
    // 先把当前项目落盘（不清草稿、不影响其它项目），再开一个空会话。
    state.flushProjectSave()
    state.clearSource()
    setActiveVideo(null)
    setError(null)
    setLoadingLabel(null)
    setLoading(false)
    for (const url of importedUrlsRef.current) URL.revokeObjectURL(url)
    importedUrlsRef.current = []
    // 新建后进入空编辑器：从「最近项目」列表点新建时不能停在列表上，
    // 否则界面看不出任何变化（列表本来就开着）。
    setLibraryOpen(false)
    if (libraryEnabled) void refreshLibrary()
    state.notify('已新建项目，导入素材即可开始剪辑', 'info')
  }

  // ---------------------------------------------------------------- 工程文件导入/导出
  const buildProjectFile = (): ProjectFile => {
    const state = store.getState()
    return createProjectFile({
      project: state.project,
      // 只保留素材元信息（DraftAsset 本身不含 Blob）。
      assets: state.assets.map(toDraftAsset),
      // 占位片段引用的缺失素材：随工程文件带走，导入时不必再次要求选择。
      missingAssets: state.missingAssets,
      sourceUrl: state.source?.url ?? null,
      timelineZoom: state.timelineZoom,
      timelineSettings: { ...state.timelineSettings, captionFollow: state.captionFollow },
      playhead: state.playhead,
    })
  }

  const exportProjectFile = () => {
    const file = buildProjectFile()
    downloadProjectFile(file, store.getState().source?.name)
    const localCount = countLocalAssets(file)
    if (localCount > 0) {
      store
        .getState()
        .notify(`该工程引用了 ${localCount} 个本地素材，导入时需一并提供`, 'warning')
    } else {
      store.getState().notify('已导出工程文件 .framecut.json', 'success')
    }
  }

  const pickProjectFile = () => {
    const input = projectFileInputRef.current
    if (!input) return
    input.value = ''
    input.click()
  }

  /** 对话框状态的唯一写入口。ref 在 effect 里同步（await 之后要读最新值）。 */
  const updateProjectImport = (
    updater: (current: ProjectImportState | null) => ProjectImportState | null,
  ): void => {
    setProjectImport(updater)
  }

  /** 导入/读取工程失败：复位加载态并给出可见提示（不留未处理的 rejection）。 */
  const reportProjectImportFailure = (error: unknown): void => {
    setLoading(false)
    setLoadingLabel(null)
    const message = error instanceof Error ? error.message : String(error)
    setError(`工程导入失败：${message}`)
    store.getState().notify('工程加载失败', 'warning')
  }

  /**
   * 导入工程时按「缺失素材」逐个/批量选择文件；取消选择不会挂起流程：
   * - 单行「选择文件」被取消 → 该素材标记为跳过；
   * - 「一次多选」被取消 → 结束这次选择，状态不变。
   * 选择框必须由用户点击触发（本函数只从按钮 onClick 里调用）。
   */
  const pickMissingAsset = async (targetId?: string): Promise<void> => {
    const current = projectImportRef.current
    const input = assetPickInputRef.current
    if (!current || !input) return
    const pending = pendingMissingAssets(current.items, current.selection)
    const targets = targetId ? pending.filter((item) => item.id === targetId) : pending
    if (targets.length === 0) return
    const kinds = new Set(targets.map((item) => assetKindOf(item)))
    input.accept =
      kinds.size === 1 && kinds.has('audio')
        ? 'audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac'
        : kinds.size === 1 && kinds.has('image')
          ? 'image/*,.jpg,.jpeg,.png,.webp,.gif'
          : 'video/*,audio/*,image/*'
    input.value = ''
    input.dataset.assetId = targetId ?? ''
    // 先挂监听、再 click：两者都发生在用户手势里（Safari 对手势要求更严格）。
    const picked = pickFilesWithCancel(input, { focusTarget: window })
    input.click()
    const outcome = await picked
    const latest = projectImportRef.current
    if (!latest) return
    const applied = applyPickOutcome(latest.selection, latest.items, outcome, targetId)
    if (applied.selection === latest.selection) return
    updateProjectImport((state) => state && { ...state, selection: applied.selection })
    if (applied.unmatched.length > 0) {
      store
        .getState()
        .notify(`有 ${applied.unmatched.length} 个文件没有匹配到缺失素材，已忽略`, 'warning')
    }
  }

  const skipProjectAsset = (id: string): void => {
    updateProjectImport(
      (state) => state && { ...state, selection: skipMissingAsset(state.selection, id) },
    )
  }

  const cancelProjectImport = (): void => {
    updateProjectImport(() => null)
    store.getState().notify('已取消导入工程文件', 'info')
  }

  /** 「全部跳过并打开」：一次标记所有缺失素材为跳过，并立刻打开工程。 */
  const skipAllAndOpenProject = (): void => {
    const current = projectImportRef.current
    if (!current) return
    updateProjectImport(() => null)
    const selection = skipAllMissingAssets(
      current.selection,
      current.items.map((item) => item.id),
    )
    const missing = mergeMissingAssets(
      current.file.missingAssets,
      missingAssetsForUnpicked(current.items, selection),
    )
    void finishProjectImport(current.file, [...selection.picked.entries()], missing).catch(
      reportProjectImportFailure,
    )
  }

  /** 用户确认「打开工程」：把已选文件与跳过项一起应用。 */
  const confirmProjectImport = (): void => {
    const current = projectImportRef.current
    if (!current) return
    updateProjectImport(() => null)
    const picked = [...current.selection.picked.entries()]
    const missing = mergeMissingAssets(
      current.file.missingAssets,
      missingAssetsForUnpicked(current.items, current.selection),
    )
    void finishProjectImport(current.file, picked, missing).catch(reportProjectImportFailure)
  }

  /** 读取选中的文件（必要时转码）、落盘，然后打开工程（缺失素材保留为占位）。 */
  const finishProjectImport = async (
    file: ProjectFile,
    picked: [string, File][],
    initialMissing: MissingAsset[],
  ): Promise<void> => {
    setError(null)
    setLoading(true)
    setLoadingLabel(null)
    const urlMap = new Map<string, string>()
    const extraAssets: MediaAsset[] = []
    const missing = [...initialMissing]
    for (const [id, pickedFile] of picked) {
      const meta = file.assets.find((asset) => asset.id === id)
      if (!meta) continue
      try {
        const asset = await readAssetFile(pickedFile, {
          allowTranscode: true,
          onTranscodeStatus: (message) => setLoadingLabel(message),
          onTranscodeProgress: (progress) =>
            setLoadingLabel(`正在转码 H.264 MP4… ${Math.round(progress)}%`),
        })
        // 按 asset.id 匹配：同一个素材在多条轨道/片段上复用时共用一份新 URL。
        importedUrlsRef.current.push(asset.url)
        extraAssets.push(asset)
        urlMap.set(meta.url, asset.url)
      } catch (error) {
        missing.push(missingAssetFromDraft(meta))
        console.warn(`[FrameCut] 无法读取工程素材：${meta.name}`, error)
      }
    }
    setLoading(false)
    setLoadingLabel(null)

    // 工程文件里只有素材元信息：重新选好的素材必须立刻写进 IndexedDB，
    // 否则刷新后 restoreDraft 找不到 Blob，会把素材和引用它的片段一起丢掉。
    await persistImportedAssets(extraAssets, { notify: store.getState().notify })

    const result = applyProjectToStore(store, {
      project: file.project,
      urlMap,
      extraAssets,
      // 跳过 / 读不出来的素材保留为占位片段（不再悄悄删掉）。
      missingAssets: mergeMissingAssets(missing),
      sourceUrl: file.sourceUrl,
      playhead: file.playhead,
      projectName: projectNameFromSource(file.assets[0]?.name ?? file.missingAssets?.[0]?.name ?? null),
    })
    if (Number.isFinite(file.timelineZoom)) store.getState().setTimelineZoom(file.timelineZoom)
    setError(null)
    if (result.missingCount > 0) {
      store
        .getState()
        .notify(
          `已载入工程；${result.missingCount} 个素材缺失，相关片段以占位显示（重新导入工程可补素材）`,
          'warning',
        )
    } else if (result.removedClips > 0) {
      store
        .getState()
        .notify(
          `已载入工程；${result.removedClips} 个片段因为缺少素材被移除`,
          'warning',
        )
    } else {
      store.getState().notify('已载入工程文件', 'success')
    }
  }

  /** 解析完工程文件后：有本地素材先弹「缺失素材」对话框，否则直接打开。 */
  const startProjectImport = (file: ProjectFile): void => {
    const knownMissing = new Set(mergeMissingAssets(file.missingAssets).map((item) => item.url))
    // 只对「工程真正引用到」的本地素材要求重新选择；没进时间轴的素材本来就会丢弃。
    const referenced = projectMediaUrls(file.project)
    const items = file.assets
      .filter((asset) => isLocalAsset(asset))
      .filter((asset) => referenced.has(asset.url))
      .filter((asset) => !knownMissing.has(asset.url))
    if (items.length === 0) {
      void finishProjectImport(file, [], mergeMissingAssets(file.missingAssets)).catch(
        reportProjectImportFailure,
      )
      return
    }
    setError(null)
    updateProjectImport(() => ({ file, items, selection: emptyMissingAssetsSelection() }))
  }

  const handleProjectFileInput = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const parsed = parseProjectFile(await file.text())
      startProjectImport(parsed)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setError(`工程导入失败：${message}`)
      store.getState().notify('工程文件无法读取', 'warning')
    }
  }

  const missingAssetRows: MissingAssetRow[] = projectImport
    ? projectImport.items.map((item) => {
        const pickedFile = projectImport.selection.picked.get(item.id)
        return {
          id: item.id,
          name: item.name,
          kind: assetKindOf(item),
          duration: item.duration,
          references: countClipReferences(projectImport.file.project, item.url),
          pickedName: pickedFile?.name,
          skipped: !pickedFile && projectImport.selection.skipped.has(item.id),
        }
      })
    : []
  const missingAssetSummary = projectImport
    ? missingSelectionSummary(projectImport.items, projectImport.selection)
    : { picked: 0, skipped: 0, pending: 0 }

  return (
    <EditorStoreProvider store={store}>
      <div className={className ? `framecut-host ${className}` : 'framecut-host'}>
        <EditorShell
          loading={loading}
          error={error}
          onPickFile={pickFile}
          onImportFiles={(files) => void importFiles(files)}
          onNewProject={newProject}
          onImportSubtitles={pickSubtitles}
          onExport={onExport}
          onExportProject={exportProjectFile}
          onImportProject={pickProjectFile}
          loadingLabel={loadingLabel}
          onCancel={onCancel}
          transcribeProvider={transcribeProvider}
          theme={resolvedTheme}
          themePreference={themePreference}
          onSelectTheme={selectTheme}
          overlay={
            projectImport ? (
              <MissingAssetsDialog
                rows={missingAssetRows}
                pending={missingAssetSummary.pending}
                onPick={(id) => void pickMissingAsset(id)}
                onPickMany={() => void pickMissingAsset()}
                onSkip={skipProjectAsset}
                onSkipAll={skipAllAndOpenProject}
                onConfirm={confirmProjectImport}
                onCancel={cancelProjectImport}
              />
            ) : null
          }
          onOpenProjects={
            libraryEnabled
              ? () => {
                  setLibraryOpen(true)
                  void refreshLibrary()
                }
              : undefined
          }
          onNewProjectShortcut={libraryEnabled ? newProject : undefined}
          projectLibrary={
            libraryEnabled && libraryOpen
              ? {
                  records: libraryRecords,
                  loading: libraryLoading,
                  onOpen: (record) => void openProjectRecord(record),
                  onDelete: (record) => void deleteProjectRecord(record),
                  onRename: (record, name) => void renameProjectRecord(record, name),
                  onCreate: newProject,
                  onImport: pickFile,
                  onDismiss: () => setLibraryOpen(false),
                }
              : null
          }
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="video/*,audio/*,image/jpeg,image/png,image/webp,image/gif,.jpg,.jpeg,.png,.webp,.gif,.mp4,.m4v,.webm,.mov,.ogv,.mkv,.mp3,.wav,.m4a,.aac,.flac"
          className="hidden-file-input"
          tabIndex={-1}
          onChange={handleFileInput}
        />
        <input
          ref={subtitleInputRef}
          type="file"
          accept=".srt,.vtt,text/vtt,text/plain"
          className="hidden-file-input"
          tabIndex={-1}
          onChange={handleSubtitleInput}
        />
        {/* 工程文件（.framecut.json）导入 */}
        <input
          ref={projectFileInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden-file-input"
          data-project-file-input="true"
          tabIndex={-1}
          onChange={handleProjectFileInput}
        />
        {/* 缺失素材对话框里「选择文件 / 一次多选」共用的选择框（监听在 pickFilesWithCancel 里） */}
        <input
          ref={assetPickInputRef}
          type="file"
          className="hidden-file-input"
          data-project-asset-input="true"
          tabIndex={-1}
        />
      </div>
    </EditorStoreProvider>
  )
}