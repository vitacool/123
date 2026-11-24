import type { DraftAsset, DraftSettings, DraftSnapshot, MissingAsset } from './core/draft'
import { normalizeMissingAssets } from './core/draft'
import type { Project } from './core/types'

/** 工程文件（`.framecut.json`）的格式标记。 */
export const PROJECT_FILE_KIND = 'framecut-project'
export const PROJECT_FILE_VERSION = 1

/**
 * 工程文件 = 草稿快照（DraftSnapshot）的元数据部分。
 * 资产只保留元信息（不含 Blob）：本地素材需要用户在导入时重新选择文件。
 */
export interface ProjectFile {
  kind: typeof PROJECT_FILE_KIND
  version: typeof PROJECT_FILE_VERSION
  /** 生成时间（毫秒）。 */
  exportedAt: number
  project: Project
  assets: DraftAsset[]
  /**
   * 工程引用、但导出时本机就没有 Blob 的素材（占位片段）。
   * 导入时这些素材不会再次要求选择，片段直接以占位形式打开。
   */
  missingAssets?: MissingAsset[]
  sourceUrl: string | null
  timelineZoom: number
  timelineSettings: DraftSettings
  playhead: number
}

export interface ProjectFileSource {
  project: Project
  assets: DraftAsset[]
  missingAssets?: MissingAsset[]
  sourceUrl: string | null
  timelineZoom: number
  timelineSettings: DraftSettings
  playhead: number
}

/** 判断一个资产是否指向本机会话里的素材（blob:/data: 或标记了 local）。 */
export function isLocalAsset(asset: Pick<DraftAsset, 'url' | 'local'>): boolean {
  return asset.local === true || asset.url.startsWith('blob:') || asset.url.startsWith('data:')
}

/** 工程文件最多认多少个素材条目：防止畸形 JSON 把导入流程拖死。 */
export const MAX_PROJECT_FILE_ASSETS = 2000

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * 逐项校验工程文件里的 `assets`（**不可信输入**）。
 *
 * 为什么必须校验：以前是 `data.assets as DraftAsset[]` 直接转型。文件被手工改过、
 * 或由别的工具生成时，`{ id: 42 }` / `url: null` 这样的条目会一路传到
 * `isLocalAsset` 的 `asset.url.startsWith(...)` 上抛 TypeError —— 用户看到的是
 * 「工程导入失败：Cannot read properties of null」，整个工程打不开，而不是
 * 「某个素材缺失、以占位显示」。这里照 `normalizeMissingAssets` 的口径逐项清洗：
 * 缺 id/url 的条目直接丢弃（引用它的片段会变成占位），其余字段夹到合法范围。
 */
export function normalizeProjectFileAssets(input: unknown): DraftAsset[] {
  if (!Array.isArray(input)) return []
  const result: DraftAsset[] = []
  const seen = new Set<string>()
  for (const item of input) {
    if (result.length >= MAX_PROJECT_FILE_ASSETS) break
    if (!item || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    if (typeof raw.id !== 'string' || raw.id.length === 0) continue
    if (typeof raw.url !== 'string' || raw.url.length === 0) continue
    if (seen.has(raw.id)) continue
    seen.add(raw.id)
    const kind =
      raw.kind === 'video' || raw.kind === 'audio' || raw.kind === 'image' ? raw.kind : undefined
    const reversed = raw.reversedFrom as Record<string, unknown> | undefined
    const reversedFrom =
      reversed && typeof reversed === 'object' &&
      Number.isFinite(finiteOr(reversed.start, Number.NaN)) &&
      Number.isFinite(finiteOr(reversed.end, Number.NaN))
        ? {
            ...(typeof reversed.assetId === 'string' ? { assetId: reversed.assetId } : {}),
            ...(typeof reversed.sourceUrl === 'string' ? { sourceUrl: reversed.sourceUrl } : {}),
            start: finiteOr(reversed.start, 0),
            end: finiteOr(reversed.end, 0),
          }
        : undefined
    result.push({
      id: raw.id,
      url: raw.url,
      name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : raw.url,
      size: Math.max(0, finiteOr(raw.size, 0)),
      duration: Math.max(0, finiteOr(raw.duration, 0)),
      width: Math.max(0, finiteOr(raw.width, 0)),
      height: Math.max(0, finiteOr(raw.height, 0)),
      ...(kind ? { kind } : {}),
      ...(typeof raw.hasAudio === 'boolean' ? { hasAudio: raw.hasAudio } : {}),
      ...(typeof raw.thumbnail === 'string' && raw.thumbnail.length > 0
        ? { thumbnail: raw.thumbnail }
        : {}),
      ...(typeof raw.local === 'boolean' ? { local: raw.local } : {}),
      ...(reversedFrom ? { reversedFrom } : {}),
    })
  }
  return result
}

export function countLocalAssets(file: Pick<ProjectFile, 'assets'>): number {
  return file.assets.filter((asset) => isLocalAsset(asset)).length
}

export function createProjectFile(source: ProjectFileSource): ProjectFile {
  return {
    kind: PROJECT_FILE_KIND,
    version: PROJECT_FILE_VERSION,
    exportedAt: Date.now(),
    project: source.project,
    assets: source.assets,
    ...(source.missingAssets && source.missingAssets.length > 0
      ? { missingAssets: source.missingAssets }
      : {}),
    sourceUrl: source.sourceUrl,
    timelineZoom: source.timelineZoom,
    timelineSettings: source.timelineSettings,
    playhead: source.playhead,
  }
}

/** 由 DraftSnapshot 生成工程文件（草稿与工程文件共用同一份元数据结构）。 */
export function projectFileFromSnapshot(snapshot: DraftSnapshot): ProjectFile {
  return createProjectFile({
    project: snapshot.project,
    assets: snapshot.assets,
    missingAssets: snapshot.missingAssets,
    sourceUrl: snapshot.sourceUrl,
    timelineZoom: snapshot.timelineZoom,
    timelineSettings: snapshot.timelineSettings,
    playhead: snapshot.playhead,
  })
}

export function serializeProjectFile(file: ProjectFile): string {
  return JSON.stringify(file, null, 2)
}

/** 解析并校验工程文件；不是 FrameCut 工程文件时抛出可读的错误。 */
export function parseProjectFile(text: string): ProjectFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('不是有效的 JSON 文件。')
  }
  if (!raw || typeof raw !== 'object') throw new Error('工程文件内容为空。')
  const data = raw as Partial<ProjectFile> & { project?: unknown }
  if (data.kind !== PROJECT_FILE_KIND) {
    throw new Error('这不是 FrameCut 工程文件（缺少 kind 标记）。')
  }
  /**
   * 版本只在「比当前更新」时拒绝，老版本一律放行。
   *
   * 原来用的是 `data.version !== PROJECT_FILE_VERSION`：一旦版本号上调，
   * 所有**历史工程文件**（以及被手工/第三方工具写成字符串 "1" 的文件）会立刻
   * 报「版本不受支持」，而 project 内部本来就有 normalizeProject 的 migrate()
   * （schemaVersion），根本轮不到执行。这里只挡未来版本，并把 version 归一成数字。
   */
  const version = typeof data.version === 'number' ? data.version : Number(data.version)
  if (!Number.isFinite(version) || version < 1) {
    throw new Error(`工程文件版本号无效：${String(data.version)}。`)
  }
  if (version > PROJECT_FILE_VERSION) {
    throw new Error(
      `工程文件由更新版本的 FrameCut 导出（v${version}，当前支持 v${PROJECT_FILE_VERSION}）。`,
    )
  }
  if (!data.project || typeof data.project !== 'object') {
    throw new Error('工程文件缺少 project 数据。')
  }
  const project = data.project as Project
  if (!Array.isArray(project.clips)) {
    throw new Error('工程文件的 project.clips 结构不正确。')
  }
  return {
    kind: PROJECT_FILE_KIND,
    version: PROJECT_FILE_VERSION,
    exportedAt: typeof data.exportedAt === 'number' ? data.exportedAt : Date.now(),
    project,
    assets: normalizeProjectFileAssets(data.assets),
    missingAssets: normalizeMissingAssets(data.missingAssets),
    sourceUrl: typeof data.sourceUrl === 'string' ? data.sourceUrl : null,
    timelineZoom: typeof data.timelineZoom === 'number' ? data.timelineZoom : 92,
    timelineSettings: {
      mainTrackMagnet: data.timelineSettings?.mainTrackMagnet ?? true,
      autoSnap: data.timelineSettings?.autoSnap ?? true,
      linkage: data.timelineSettings?.linkage ?? true,
      previewAxis: data.timelineSettings?.previewAxis ?? true,
      captionFollow: data.timelineSettings?.captionFollow ?? true,
    },
    playhead: typeof data.playhead === 'number' ? data.playhead : 0,
  }
}

/** 由素材名/工程名推导导出的文件名。 */
export function projectFileName(baseName?: string | null): string {
  const base = (baseName ?? '')
    .replace(/\.[^.]+$/, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .trim()
    .slice(0, 64)
  return `${base || 'framecut'}.framecut.json`
}

/** 浏览器下载一个工程文件（不在宿主环境时由编辑器内部调用）。 */
export function downloadProjectFile(file: ProjectFile, baseName?: string | null): void {
  const blob = new Blob([serializeProjectFile(file)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = projectFileName(baseName)
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1500)
}