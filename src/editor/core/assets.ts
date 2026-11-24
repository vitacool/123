import type { Clip, MediaAsset, Project, ReverseAssetOrigin } from './types'

/**
 * 素材与片段之间的引用关系判断（素材库、时间轴、预览、导出共用同一套规则）。
 *
 * 片段通过 `clip.sourceUrl` 间接引用素材（asset.url）；字幕片段的
 * `link.assetId` 记录的是素材 id。素材被从素材库移除后，这些引用就变成
 * 「素材缺失」，UI 需要显示占位而不是静默画错素材。
 */

/** 素材文件名归一化：去扩展名与 HEVC 代理后缀，忽略大小写与空白。 */
function duplicateKey(name: string): string {
  return (name ?? '')
    .replace(/\.[^.]+$/, '')
    .replace(/-(h264|h265|hevc)$/i, '')
    .trim()
    .toLowerCase()
}

/**
 * 判断一次导入是否与素材库里已有素材重复（同名 + 同大小）。
 * 用于在读取/转码**之前**跳过，避免同一文件反复导入把 IndexedDB 配额翻倍。
 * 注：HEVC 代理的 `size` 是转码后的体积，与原文件不同，这类素材不在判重范围。
 */
export function findDuplicateAsset(
  file: { name: string; size: number },
  assets: readonly MediaAsset[],
): MediaAsset | undefined {
  const key = duplicateKey(file.name)
  return assets.find(
    (asset) => asset.size === file.size && duplicateKey(asset.name) === key,
  )
}

/** 素材库排序方式：导入顺序 / 名称 / 时长（长→短）/ 大小（大→小）。 */
export type AssetSortMode = 'added' | 'name' | 'duration' | 'size'

export const ASSET_SORT_OPTIONS: readonly { value: AssetSortMode; label: string }[] = [
  { value: 'added', label: '导入顺序' },
  { value: 'name', label: '名称' },
  { value: 'duration', label: '时长（长→短）' },
  { value: 'size', label: '大小（大→小）' },
]

/** 返回排序后的副本；added 保持原顺序（稳定）。 */
export function sortAssets(
  assets: readonly MediaAsset[],
  mode: AssetSortMode,
): MediaAsset[] {
  const copy = [...assets]
  if (mode === 'added') return copy
  if (mode === 'name') {
    return copy.sort((left, right) =>
      left.name.localeCompare(right.name, 'zh-Hans-CN', {
        numeric: true,
        sensitivity: 'base',
      }),
    )
  }
  const value = (asset: MediaAsset): number =>
    mode === 'duration' ? asset.duration : asset.size
  return copy.sort((left, right) => value(right) - value(left))
}

export const ASSET_FOLDER_MAX_LENGTH = 40

/** 文件夹名归一化：去首尾空白、压缩空白、限长；空串表示未分类。 */
export function normalizeAssetFolder(name: unknown): string {
  if (typeof name !== 'string') return ''
  return name.replace(/\s+/g, ' ').trim().slice(0, ASSET_FOLDER_MAX_LENGTH)
}

/** 素材库里出现过的文件夹名（去重、按中文/数字排序）。 */
export function listAssetFolders(assets: readonly MediaAsset[]): string[] {
  const names = new Set<string>()
  for (const asset of assets) {
    const folder = normalizeAssetFolder(asset.folder)
    if (folder) names.add(folder)
  }
  return [...names].sort((left, right) =>
    left.localeCompare(right, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }),
  )
}

/**
 * 按文件夹筛选：`null` 表示全部；空串表示未分类；其余按归一化后的名字精确匹配。
 */
export function filterAssetsByFolder(
  assets: readonly MediaAsset[],
  folder: string | null,
): MediaAsset[] {
  if (folder === null) return [...assets]
  const target = normalizeAssetFolder(folder)
  return assets.filter((asset) => normalizeAssetFolder(asset.folder) === target)
}

/** 素材库使用情况筛选。 */
export type AssetUsageFilter = 'all' | 'used' | 'unused'

export const ASSET_USAGE_OPTIONS: readonly { value: AssetUsageFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'used', label: '已使用' },
  { value: 'unused', label: '未使用' },
]

/** 按「是否被工程引用」筛选；未使用判定复用 unusedAssets（含倒放原素材链）。 */
export function filterAssetsByUsage(
  assets: readonly MediaAsset[],
  project: Project,
  usage: AssetUsageFilter,
  /** 计算引用关系用的全量素材库；缺省等于 assets。 */
  catalog: readonly MediaAsset[] = assets,
): MediaAsset[] {
  if (usage === 'all') return [...assets]
  const unusedIds = new Set(unusedAssets(project, catalog).map((asset) => asset.id))
  return assets.filter((asset) =>
    usage === 'unused' ? unusedIds.has(asset.id) : !unusedIds.has(asset.id),
  )
}

/** 当前素材库里的 url 集合。 */
export function assetUrlSet(assets: readonly MediaAsset[]): Set<string> {
  return new Set(assets.map((asset) => asset.url))
}

/** 片段的素材是否已不在素材库里（→ 时间轴显示「素材已移除」）。 */
export function isClipAssetMissing(urls: ReadonlySet<string>, clip: Pick<Clip, 'sourceUrl'>): boolean {
  return !urls.has(clip.sourceUrl)
}

/** 素材被多少个片段引用（主轨 + 叠加轨 + 音频轨 + 字幕 link）。 */
export function countAssetReferences(project: Project, asset: { id: string; url: string }): number {
  let count = 0
  for (const clip of project.clips) if (clip.sourceUrl === asset.url) count += 1
  for (const track of project.overlayTracks ?? []) {
    for (const clip of track.clips) if (clip.sourceUrl === asset.url) count += 1
  }
  for (const track of project.audioTracks ?? []) {
    for (const clip of track.clips) if (clip.sourceUrl === asset.url) count += 1
  }
  for (const track of project.textTracks ?? []) {
    for (const clip of track.clips) if (clip.link?.assetId === asset.id) count += 1
  }
  return count
}

/** 工程里是否还有任何片段引用该素材。 */
export function isAssetReferenced(project: Project, asset: { id: string; url: string }): boolean {
  return countAssetReferences(project, asset) > 0
}

/**
 * 这些工程快照里是否**任意一个**仍在引用该素材。
 *
 * 用于素材的「延迟回收」：历史栈里的 past / present / future 都是撤销/重做可能
 * 回到的状态，只要其中还有引用，就不能 revoke objectURL / 删 blob，否则撤销回来
 * 的片段会指向已经失效的源。
 */
export function assetsReferencedBy(
  projects: readonly Project[],
  asset: { id: string; url: string },
): boolean {
  return projects.some((project) => isAssetReferenced(project, asset))
}

/** 未被任何片段引用的素材（用于「清理未使用」）。 */
export function unusedAssets<T extends { id: string; url: string; reversedFrom?: ReverseAssetOrigin }>(
  project: Project,
  assets: readonly T[],
): T[] {
  const usedUrls = new Set<string>()
  const usedAssetIds = new Set<string>()
  const note = (url: string): void => {
    usedUrls.add(url)
  }
  for (const clip of project.clips) note(clip.sourceUrl)
  for (const track of project.overlayTracks ?? []) for (const clip of track.clips) note(clip.sourceUrl)
  for (const track of project.audioTracks ?? []) for (const clip of track.clips) note(clip.sourceUrl)
  for (const track of project.textTracks ?? []) {
    for (const clip of track.clips) {
      if (clip.link?.assetId) usedAssetIds.add(clip.link.assetId)
      if (clip.link?.sourceUrl) note(clip.link.sourceUrl)
    }
  }
  // 倒放素材的「原素材」也算已使用：删掉它就没法恢复正放了。
  // 反复迭代到不动点，覆盖「倒放的倒放」这类链式引用。
  let changed = true
  while (changed) {
    changed = false
    for (const asset of assets) {
      if (!asset.reversedFrom) continue
      const inUse = usedUrls.has(asset.url) || usedAssetIds.has(asset.id)
      if (!inUse) continue
      const origin = asset.reversedFrom
      if (origin.assetId && !usedAssetIds.has(origin.assetId)) {
        usedAssetIds.add(origin.assetId)
        changed = true
      }
      if (origin.sourceUrl && !usedUrls.has(origin.sourceUrl)) {
        usedUrls.add(origin.sourceUrl)
        changed = true
      }
    }
  }
  return assets.filter((asset) => !usedUrls.has(asset.url) && !usedAssetIds.has(asset.id))
}

/** 素材库里有哪些倒放素材是从这个素材倒放出来的（删原素材后它们无法恢复正放）。 */
export function reversedDependents<T extends { reversedFrom?: ReverseAssetOrigin }>(
  assets: readonly T[],
  asset: { id: string; url: string },
): T[] {
  return assets.filter((item) => {
    const origin = item.reversedFrom
    if (!origin) return false
    if (origin.assetId) return origin.assetId === asset.id
    return origin.sourceUrl === asset.url
  })
}
// ===================== 分类与搜索（素材库三个 Tab / 搜索共用） =====================

/** 素材分类（视频 / 图片 / 音频）。 */
export type AssetKind = 'video' | 'image' | 'audio'

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif']

/** 取路径/文件名的扩展名（小写，不含点）。 */
function extensionOf(value: string | undefined): string {
  if (!value) return ''
  const clean = value.split('?')[0].split('#')[0]
  const dot = clean.lastIndexOf('.')
  if (dot < 0 || dot === clean.length - 1) return ''
  return clean.slice(dot + 1).toLowerCase()
}

/**
 * 素材分类的唯一判定入口：三个 Tab、搜索角标、拖拽落点都走它。
 *
 * 优先用 `asset.kind`；旧草稿（以及手改的工程文件）可能没有这个字段
 * （`SourceInfo.kind` 本身是可选的，toDraftAsset / restoreDraft 都是原样拷贝），
 * 按以下顺序兜底：
 *   1) 宽高都为 0 → 音频（音频文件探测不到画面尺寸）
 *   2) url 或 name 的扩展名命中图片格式 → 图片
 *   3) 其余 → 视频
 */
export function assetKindOf(
  asset: Pick<MediaAsset, 'kind' | 'width' | 'height' | 'url' | 'name'>,
): AssetKind {
  const kind = asset.kind
  if (kind === 'video' || kind === 'image' || kind === 'audio') return kind
  if ((asset.width ?? 0) === 0 && (asset.height ?? 0) === 0) return 'audio'
  const byName = extensionOf(asset.name)
  const byUrl = extensionOf(asset.url)
  if (IMAGE_EXTENSIONS.includes(byName) || IMAGE_EXTENSIONS.includes(byUrl)) return 'image'
  return 'video'
}

/** 分类的中文标签。 */
export const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  video: '视频',
  image: '图片',
  audio: '音频',
}

/** 按分类统计素材数量（保持导入顺序，仅做计数）。 */
export function countAssetKinds(assets: readonly MediaAsset[]): Record<AssetKind, number> {
  const counts: Record<AssetKind, number> = { video: 0, image: 0, audio: 0 }
  for (const asset of assets) counts[assetKindOf(asset)] += 1
  return counts
}

/** 搜索匹配：对 name 做大小写不敏感的 includes；空查询视为无搜索。 */
export function matchesAssetName(asset: Pick<MediaAsset, 'name'>, query: string): boolean {
  const keyword = query.trim().toLowerCase()
  if (keyword.length === 0) return true
  return asset.name.toLowerCase().includes(keyword)
}
