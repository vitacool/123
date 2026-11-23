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
  if (data.version !== PROJECT_FILE_VERSION) {
    throw new Error(`工程文件版本不受支持：${String(data.version)}。`)
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
    assets: Array.isArray(data.assets) ? (data.assets as DraftAsset[]) : [],
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