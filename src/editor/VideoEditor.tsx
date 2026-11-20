import { useEffect, useRef, useState } from 'react'
import type {
  ChangeEvent,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { MAX_RECOMMENDED_FILE_BYTES } from './core/constants'
import { getProjectEnd } from './core/timeline'
import type { MediaAsset, Project, SourceInfo } from './core/types'
import { createEditorStore } from './store/editorStore'
import type { EditorStore } from './store/editorStore'
import { EditorStoreProvider, useEditorStore, useEditorStoreApi } from './store/EditorProvider'
import {
  createFrameCutApi,
  applyProjectToStore,
  type FrameCutApi,
} from './api'
import {
  countLocalAssets,
  createProjectFile,
  downloadProjectFile,
  isLocalAsset,
  parseProjectFile,
  type ProjectFile,
} from './projectFile'
import {
  captureThumbnail,
  isSupportedMedia,
  readAssetFile,
  remoteName,
  waitForVideoMetadata,
} from './services/assetReader'
import { configureFFmpegAssets } from './services/ffmpegExporter'
import { parseSubtitleText } from './core/text'
import type { TranscribeProvider } from './services/asr/types'
import {
  clearDraft,
  loadDraftSnapshot,
  restoreDraft,
  saveDraft,
  saveMediaBlob,
  toDraftAsset,
  toDraftSnapshot,
} from './services/draftStore'
import { TopBar } from './components/TopBar'
import { ContextMenu } from './components/ContextMenu'
import { Preview } from './components/Preview'
import { MediaLibrary } from './components/MediaLibrary'
import { CanvasBackgroundPanel } from './components/CanvasBackgroundPanel'
import { CoverPanel } from './components/CoverPanel'
import { PropertiesPanel } from './components/PropertiesPanel'
import { Toolbar } from './components/Toolbar'
import { Timeline } from './components/Timeline'
import { ExportDialog } from './components/ExportDialog'
import { AutoCaptionDialog } from './components/AutoCaptionDialog'
import { Toast } from './components/Toast'
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
}

/** 草稿保存失败提示的全局去重时间戳（30s 内只提示一次，批量导入不刷屏）。 */
let lastDraftSaveErrorAt = 0

/** 草稿写入 IndexedDB 失败时给出可见提示（配额不足是最常见原因）。 */
function reportDraftSaveFailure(
  notify: (message: string, kind?: 'info' | 'success' | 'warning' | 'error') => void,
): void {
  const now = Date.now()
  if (now - lastDraftSaveErrorAt < 30_000) return
  lastDraftSaveErrorAt = now
  notify('草稿保存失败，可能是浏览器存储空间不足', 'warning')
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
}: EditorShellProps) {
  const [autoCaptionOpen, setAutoCaptionOpen] = useState(false)
  const [backgroundOpen, setBackgroundOpen] = useState(false)
  const [projectMenu, setProjectMenu] = useState<{ x: number; y: number } | null>(null)
  const store = useEditorStoreApi()
  const source = useEditorStore((state) => state.source)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [dragActive, setDragActive] = useState(false)

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    if (source) rootRef.current?.focus({ preventScroll: true })
  }, [source?.url])

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
      className="framecut-root"
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
        <MediaLibrary
        onImport={onPickFile}
        onNewProject={onNewProject}
        onImportSubtitles={onImportSubtitles}
        onAutoCaption={() => setAutoCaptionOpen(true)}
        onCanvasBackground={() => setBackgroundOpen(true)}
      />
        <Preview onPickFile={onPickFile} loading={loading} error={error} loadingLabel={loadingLabel} />
        {/* 右栏常驻：避免未选中时预览区被 306px 的宽度跳变挤动 */}
        <PropertiesPanel />
      </div>
      <Toolbar />
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
          ]}
        />
      )}
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
      <Toast />
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
}: VideoEditorProps) {
  // 宿主可注入 store（多实例/外部订阅）；未注入时编辑器自建一个。
  const [internalStore] = useState(() => createEditorStore())
  const store = injectedStore ?? internalStore
  const [activeVideo, setActiveVideo] = useState<File | string | null>(initialVideo)
  const [loading, setLoading] = useState(Boolean(initialVideo))
  const [loadingLabel, setLoadingLabel] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const subtitleInputRef = useRef<HTMLInputElement | null>(null)
  const projectFileInputRef = useRef<HTMLInputElement | null>(null)
  const assetPickInputRef = useRef<HTMLInputElement | null>(null)
  const assetPickResolverRef = useRef<((files: File[]) => void) | null>(null)
  const importedUrlsRef = useRef<string[]>([])
  const restoringRef = useRef(true)
  // 宿主回调放进 ref：内联箭头函数不应导致重新订阅/重复触发 onReady。
  const onReadyRef = useRef(onReady)
  const onProjectChangeRef = useRef(onProjectChange)
  const apiRef = useRef<FrameCutApi | null>(null)

  useEffect(() => {
    onReadyRef.current = onReady
  }, [onReady])

  useEffect(() => {
    onProjectChangeRef.current = onProjectChange
  }, [onProjectChange])

  // store 就绪后创建控制句柄并交给宿主（只调用一次）。
  useEffect(() => {
    const api = createFrameCutApi({ store })
    apiRef.current = api
    onReadyRef.current?.(api)
    return () => {
      apiRef.current = null
    }
  }, [store])

  useEffect(() => {
    return () => {
      for (const url of importedUrlsRef.current) URL.revokeObjectURL(url)
      importedUrlsRef.current = []
    }
  }, [])

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
        const snapshot = await loadDraftSnapshot()
        if (!snapshot || cancelled) return
        const restored = await restoreDraft(snapshot)
        if (!restored || cancelled) return
        restoringRef.current = true
        store.getState().hydrateDraft(restored)
        for (const asset of restored.assets) {
          if (asset.url.startsWith('blob:')) importedUrlsRef.current.push(asset.url)
        }
        store.getState().notify('已恢复上次草稿', 'info')
      } catch {
        // A corrupt draft should never block a fresh editor.
      } finally {
        if (!cancelled) restoringRef.current = false
      }
    })()
    return () => {
      cancelled = true
    }
  }, [initialVideo, store])

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
      if (
        state.project === previous.project &&
        state.assets === previous.assets &&
        state.source === previous.source &&
        state.timelineZoom === previous.timelineZoom &&
        state.timelineSettings === previous.timelineSettings &&
        state.captionFollow === previous.captionFollow
      ) {
        return
      }
      window.clearTimeout(draftTimer)
      draftTimer = window.setTimeout(() => {
        void saveDraft(toDraftSnapshot(state)).catch(() => undefined)
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
      for (const asset of imported) {
        if (asset.file) {
          void saveMediaBlob(asset.id, asset.file).catch(() =>
            reportDraftSaveFailure(store.getState().notify),
          )
        }
      }
      store.getState().addAssets(imported)
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
    if (!window.confirm('清除当前草稿并新建项目？未导出的编辑会丢失。')) return
    store.getState().clearSource()
    void clearDraft().catch(() => undefined)
    setActiveVideo(null)
    setError(null)
    setLoadingLabel(null)
    for (const url of importedUrlsRef.current) URL.revokeObjectURL(url)
    importedUrlsRef.current = []
  }

  // ---------------------------------------------------------------- 工程文件导入/导出
  const buildProjectFile = (): ProjectFile => {
    const state = store.getState()
    return createProjectFile({
      project: state.project,
      // 只保留素材元信息（DraftAsset 本身不含 Blob）。
      assets: state.assets.map(toDraftAsset),
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

  /** 导入时为「每个本地素材」弹一次文件选择，按 asset.id 匹配（cancel 则跳过该素材）。 */
  const pickAssetFile = (meta: { id: string; name: string; kind?: string }): Promise<File[]> =>
    new Promise((resolve) => {
      const input = assetPickInputRef.current
      if (!input) {
        resolve([])
        return
      }
      input.accept =
        meta.kind === 'audio'
          ? 'audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac'
          : meta.kind === 'image'
            ? 'image/*,.jpg,.jpeg,.png,.webp,.gif'
            : 'video/*,audio/*,image/*'
      input.dataset.assetId = meta.id
      input.value = ''
      assetPickResolverRef.current = resolve
      store.getState().notify(`请选择工程需要的素材「${meta.name}」`, 'info')
      input.click()
    })

  const handleAssetPickInput = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    const resolve = assetPickResolverRef.current
    assetPickResolverRef.current = null
    resolve?.(files)
  }

  const importProjectFile = async (file: ProjectFile) => {
    const localAssets = file.assets.filter((asset) => isLocalAsset(asset))
    const urlMap = new Map<string, string>()
    const extraAssets: MediaAsset[] = []
    let cancelledAssets = 0

    for (const meta of localAssets) {
      const [picked] = await pickAssetFile(meta)
      if (!picked) {
        cancelledAssets += 1
        continue
      }
      try {
        const asset = await readAssetFile(picked, {
          allowTranscode: true,
          onTranscodeStatus: (message) => setLoadingLabel(message),
          onTranscodeProgress: (progress) =>
            setLoadingLabel(`正在转码 H.264 MP4… ${Math.round(progress)}%`),
        })
        // 按 asset.id 匹配：同一个素材在多条轨道/片段上复用时共用一份新 URL。
        importedUrlsRef.current.push(asset.url)
        extraAssets.push(asset)
        urlMap.set(meta.url, asset.url)
      } catch {
        cancelledAssets += 1
      }
    }
    setLoadingLabel(null)

    const result = applyProjectToStore(store, {
      project: file.project,
      urlMap,
      extraAssets,
      sourceUrl: file.sourceUrl,
      playhead: file.playhead,
    })
    if (Number.isFinite(file.timelineZoom)) store.getState().setTimelineZoom(file.timelineZoom)

    if (result.assetCount === 0) {
      setError('工程里引用的素材都还没有提供，时间线为空。请重新提供素材后再导入。')
      store.getState().notify('工程没有可用素材', 'warning')
      return
    }
    setError(null)
    if (result.removedClips > 0) {
      store
        .getState()
        .notify(
          `已载入工程；${result.removedClips} 个片段因为缺少素材被移除${
            cancelledAssets > 0 ? `（${cancelledAssets} 个素材未提供）` : ''
          }`,
          'warning',
        )
    } else {
      store.getState().notify('已载入工程文件', 'success')
    }
  }

  const handleProjectFileInput = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const parsed = parseProjectFile(await file.text())
      await importProjectFile(parsed)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setError(`工程导入失败：${message}`)
      store.getState().notify('工程文件无法读取', 'warning')
    }
  }

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
        {/* 导入工程时为每个本地素材弹一次选择（按 asset.id 匹配） */}
        <input
          ref={assetPickInputRef}
          type="file"
          className="hidden-file-input"
          data-project-asset-input="true"
          tabIndex={-1}
          onChange={handleAssetPickInput}
        />
      </div>
    </EditorStoreProvider>
  )
}