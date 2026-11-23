import { getOutputDimensions } from './core/aspect'
import { buildCoverJpeg } from './core/cover'
import { projectMediaUrls, pruneProjectUrls, remapProjectUrls } from './core/draft'
import { normalizeProject } from './core/normalizeProject'
import { getProjectEnd } from './core/timeline'
import { frameCaptureSize } from './core/frameCompose'
import type { MediaAsset, Project } from './core/types'
import type { ExportRange } from './core/exportRange'
import type { FrameCutTheme } from './core/theme'
import { createId } from './core/ids'
import { projectNameFromSource } from './core/projectLibrary'
import { remoteName, readAssetFile } from './services/assetReader'
import { persistImportedAssets } from './services/draftStore'
import { captureFrameBlob, frameCaptureWarning } from './services/frameCapture'
import { exportProject, terminateFFmpegRuntime } from './services/ffmpegExporter'
import type { ExportFormat } from './services/ffmpegExporter'
import type { EditorStore } from './store/editorStore'

/**
 * 宿主拿到的编辑器控制句柄：`<VideoEditor onReady={(api) => ...} />`。
 * 所有方法都是同步取当前 store 状态，不持有过期快照。
 */
export interface FrameCutApi {
  /** 当前工程（只读快照，每次调用都取最新）。 */
  getProject(): Project
  /**
   * 清空当前工程并载入指定工程。
   * `assets` 用于给工程里引用的素材提供文件；按「文件名 → URL 尾部文件名」匹配，
   * 数量与顺序完全一致时按顺序兜底。没有提供文件的本地素材会被剔除。
   */
  loadProject(project: Project, assets?: File[]): Promise<void>
  /**
   * 无界面导出：走与导出对话框相同的管线；默认 MP4，可传 format 导出仅音频。
   * `range` 只导出时间轴上的一段入点 / 出点区间；不传则导出整条时间轴。
   */
  export(options?: { format?: ExportFormat; range?: ExportRange | null }): Promise<Blob>
  /** 当前封面图（JPG）；没有封面时返回 null。 */
  getCover(): Promise<Blob | null>
  /**
   * 把指定时刻（默认当前播放头）的画面导出成 PNG。
   * 尺寸取导出设置分辨率；素材缺失 / seek 失败时给出 warning 提示并按可用内容出图。
   */
  captureFrame(time?: number): Promise<Blob>
  /** 播放头定位（秒，自动夹到工程范围内）。 */
  seek(time: number): void
  play(): void
  pause(): void
  /** 宿主卸载编辑器时调用：释放 FFmpeg 运行时与本次 API 创建的 object URL。 */
  destroy(): void
  /** 当前界面主题偏好（light / dark / system）。 */
  getTheme(): FrameCutTheme
  /**
   * 设置界面主题偏好。受控模式（传了 theme prop）下这只是一次「请求」：
   * 编辑器会调用宿主的 onThemeChange，由宿主决定是否真的改变。
   */
  setTheme(theme: FrameCutTheme): void
}

export interface FrameCutApiOptions {
  store: EditorStore
  /** 覆盖 File → MediaAsset 的读取实现（默认用内置探测 + HEVC 转码）。 */
  readAsset?: (file: File) => Promise<MediaAsset>
  /** 主题读写代理：由 VideoEditor 提供（受控/非受控差异在组件内部处理）。 */
  theme?: {
    get(): FrameCutTheme
    set(theme: FrameCutTheme): void
  }
}

export interface ApplyProjectInput {
  project: Project
  /** 旧 URL → 新 URL（本地素材重新选择后重映射）。 */
  urlMap?: Map<string, string>
  /** 随工程一起载入的新素材（已探测完成）。 */
  extraAssets?: MediaAsset[]
  /** 工程原来的主素材 URL（会被 urlMap 翻译）。 */
  sourceUrl?: string | null
  playhead?: number
  /** 新项目的显示名；缺省取主素材名。 */
  projectName?: string
}

export interface ApplyProjectResult {
  /** 因为素材缺失被剔除的片段数。 */
  removedClips: number
  /** 实际载入的素材数。 */
  assetCount: number
}

const isLocalUrl = (url: string): boolean =>
  url.startsWith('blob:') || url.startsWith('data:')

const countClips = (project: Project): number =>
  project.clips.length +
  (project.overlayTracks ?? []).reduce((total, track) => total + track.clips.length, 0) +
  (project.audioTracks ?? []).reduce((total, track) => total + track.clips.length, 0)

/**
 * 把一份工程（可能带重新选择后的本地素材）写进 store：
 * 重映射 URL → 剔除缺失素材的片段 → 只保留被工程引用的素材 → hydrate。
 */
export function applyProjectToStore(
  store: EditorStore,
  input: ApplyProjectInput,
): ApplyProjectResult {
  const state = store.getState()
  const urlMap = input.urlMap ?? new Map<string, string>()
  // 工程文件/宿主传入的 project 可能缺字段或来自旧版本：走**唯一**的归一化入口
  // （含智能字幕 link 迁移 —— 这条链原来在这里漏了 migrateCaptionLinks）。
  const assetIdByUrl = new Map(
    [...state.assets, ...(input.extraAssets ?? [])].map((asset) => [asset.url, asset.id]),
  )
  const { project: sourceProject, warnings } = normalizeProject(input.project, { assetIdByUrl })
  for (const warning of warnings) console.warn('[FrameCut] 工程归一化：', warning.message)
  const projectUrls = projectMediaUrls(sourceProject)

  // 可用 URL：重映射后的新 URL + 仍然是远程（非 blob/data）的 URL + 当前会话里已经拿着 Blob 的素材。
  const available = new Set<string>()
  for (const url of projectUrls) {
    const mapped = urlMap.get(url)
    if (mapped) {
      available.add(mapped)
      continue
    }
    if (!isLocalUrl(url)) available.add(url)
  }
  // 已有素材（含本次新读进来的）在本会话里都还活着，即便 URL 是 blob: 也可用。
  for (const asset of [...state.assets, ...(input.extraAssets ?? [])]) {
    available.add(asset.url)
  }

  const remapped = remapProjectUrls(sourceProject, urlMap)
  const project = pruneProjectUrls(remapped, available)
  const removedClips = Math.max(0, countClips(remapped) - countClips(project))

  // 只保留这份工程真正用到的素材，避免把上一份工程的素材带进来。
  const usedUrls = projectMediaUrls(project)
  const byUrl = new Map<string, MediaAsset>()
  for (const asset of [...state.assets, ...(input.extraAssets ?? [])]) {
    if (usedUrls.has(asset.url)) byUrl.set(asset.url, asset)
  }
  const assets = [...byUrl.values()]

  const wantedSource = input.sourceUrl ? urlMap.get(input.sourceUrl) ?? input.sourceUrl : null
  const source =
    (wantedSource ? assets.find((asset) => asset.url === wantedSource) : null) ??
    assets.find((asset) => asset.kind !== 'audio') ??
    assets[0] ??
    null

  // 载入一份工程 = 新建一个项目（而不是覆盖当前项目）：
  // 先把当前项目保存到 IndexedDB，再用新的项目 id / 名字接管会话。
  state.adoptProject(
    createId('project'),
    input.projectName ?? projectNameFromSource(source?.name ?? assets[0]?.name),
  )
  state.hydrateDraft({
    project,
    assets,
    source,
    timelineZoom: state.timelineZoom,
    timelineSettings: {
      mainTrackMagnet: state.timelineSettings.mainTrackMagnet,
      autoSnap: state.timelineSettings.autoSnap,
      linkage: state.timelineSettings.linkage,
      previewAxis: state.timelineSettings.previewAxis,
      captionFollow: state.captionFollow,
      // 换工程时保留当前导出区间（hydrateDraft 会按新时长夹取）。
      exportRange: state.exportRange,
    },
    playhead: Math.max(0, input.playhead ?? 0),
  })

  return { removedClips, assetCount: assets.length }
}

/** 把宿主给的文件按工程里引用的素材 URL 依次配上去（文件名优先，数量一致时按顺序）。 */
export function matchFilesToProjectUrls(
  project: Project,
  files: File[],
): { url: string; file: File }[] {
  const urls = [...projectMediaUrls(project)]
  // 本地 URL 优先配对，远程 URL 一般不需要重新提供文件。
  const localUrls = urls.filter(isLocalUrl)
  const targets = localUrls.length > 0 ? localUrls : urls
  const remaining = [...files]
  const pairs: { url: string; file: File }[] = []

  for (let index = 0; index < targets.length; index += 1) {
    if (remaining.length === 0) break
    const url = targets[index]
    const name = remoteName(url)
    const byName = remaining.findIndex((file) => file.name === name)
    let pickIndex = byName
    if (pickIndex < 0 && remaining.length === targets.length - index) pickIndex = 0
    if (pickIndex < 0) continue
    const [file] = remaining.splice(pickIndex, 1)
    pairs.push({ url, file })
  }
  return pairs
}

export function createFrameCutApi({
  store,
  readAsset,
  theme: themeController,
}: FrameCutApiOptions): FrameCutApi {
  /** 本次 API 会话创建的 object URL，destroy 时统一释放。 */
  const ownedUrls: string[] = []
  const reader = readAsset ?? ((file: File) => readAssetFile(file))

  return {
    getProject: () => store.getState().project,

    loadProject: async (project, files = []) => {
      const pairs = matchFilesToProjectUrls(project, files)
      const urlMap = new Map<string, string>()
      const extraAssets: MediaAsset[] = []
      for (const pair of pairs) {
        const asset = await reader(pair.file)
        ownedUrls.push(asset.url)
        extraAssets.push(asset)
        urlMap.set(pair.url, asset.url)
      }
      // 重新选择出来的素材 Blob 必须立刻落盘：工程本身只有元信息，
      // 否则刷新后 restoreDraft 找不到素材，会把这些片段全部剔除。
      await persistImportedAssets(extraAssets, { notify: store.getState().notify })
      const result = applyProjectToStore(store, {
        project,
        urlMap,
        extraAssets,
        playhead: 0,
      })
      if (result.removedClips > 0) {
        store
          .getState()
          .notify(`有 ${result.removedClips} 个片段缺少素材，已从工程中移除`, 'warning')
      }
    },

    export: async (options = {}) => {
      const format = options.format ?? 'mp4'
      const range = options.range ?? null
      const state = store.getState()
      const source =
        state.source ??
        state.assets.find((asset) =>
          format === 'mp4' ? asset.kind !== 'audio' : true,
        ) ??
        null
      if (!source) throw new Error('当前工程没有可导出的素材。')
      if (countClips(state.project) === 0) throw new Error('时间轴为空，无法导出。')
      const result = await exportProject(state.project, source, state.assets, {}, { format, range })
      return result.blob
    },

getCover: async () => {
      const state = store.getState()
      const cover = state.project.cover
      if (!cover) return null
      const source =
        state.source ?? state.assets.find((asset) => asset.kind !== 'audio') ?? null
      const { width, height } = getOutputDimensions(
        state.project.aspectRatio,
        state.project.exportQuality.resolution,
        source ?? { width: 1920, height: 1080 },
      )
      return buildCoverJpeg(width, height, cover)
    },

    captureFrame: async (time) => {
      const state = store.getState()
      const total = Math.max(0, getProjectEnd(state.project))
      const at = Math.max(0, Math.min(time ?? state.playhead, total))
      const size = frameCaptureSize(state.project, state.source ?? state.assets[0] ?? null)
      const result = await captureFrameBlob({
        project: state.project,
        assets: state.assets,
        time: at,
        width: size.width,
        height: size.height,
      })
      // 素材缺失 / 解码失败：汇总成一条 warning，仍然返回可用部分合成的图。
      const warning = frameCaptureWarning(result.failures)
      if (warning) state.notify(`当前帧有部分画面缺失：${warning}`, 'warning')
      if (!result.blob) throw new Error('当前帧导出失败。')
      return result.blob
    },

    seek: (time) => {
      store.getState().setPlayhead(time)
    },

    play: () => {
      store.getState().setPlaying(true)
    },

    pause: () => {
      store.getState().setPlaying(false)
    },

    destroy: () => {
      terminateFFmpegRuntime()
      // 宿主卸载编辑器：历史栈随之消失，待回收素材立即回收，避免 blob/URL 泄漏。
      store.getState().disposePendingAssets()
      for (const url of ownedUrls) URL.revokeObjectURL(url)
      ownedUrls.length = 0
    },

    getTheme: () => themeController?.get() ?? store.getState().theme,

    setTheme: (theme) => {
      // 有代理时走代理（受控模式下由宿主决定），否则直接改 store。
      if (themeController) themeController.set(theme)
      else store.getState().setTheme(theme)
    },
  }
}