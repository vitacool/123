import type { DraftAsset, DraftSnapshot } from './draft'
import { getProjectEnd } from './timeline'

/**
 * 「最近项目」库：核心纯逻辑。
 *
 * 数据层（services/draftStore）按 `id` 存多条记录：
 * `{ id, name, updatedAt, thumbnail?, snapshot }`。这里只做与存储无关的计算：
 * 旧版单草稿的迁移映射、项目名 / 缩略图推导、排序、数量上限、
 * 以及「哪些 media blob 还被引用」（多项目共享 blob 的删除判定）。
 */

/** 最多保存多少个项目：超过后提示用户清理，不自动删除。 */
export const PROJECT_LIMIT = 20

/** 未命名项目的默认名。 */
export const DEFAULT_PROJECT_NAME = '未命名项目'

/** IndexedDB 里的一条项目记录。 */
export interface DraftProjectRecord {
  id: string
  name: string
  /** 最后保存时间（毫秒）。 */
  updatedAt: number
  /** 列表用的缩略图（小尺寸 dataURL，取自主素材）。 */
  thumbnail?: string
  snapshot: DraftSnapshot
}

/** 项目名清洗：去掉非法字符与首尾空白，空值回退默认名（不剥扩展名）。 */
export function normalizeProjectName(name: string | null | undefined): string {
  const cleaned = (name ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .trim()
    .slice(0, 64)
  return cleaned || DEFAULT_PROJECT_NAME
}

/** 由主素材名推导默认项目名（去掉扩展名再清洗）。 */
export function projectNameFromSource(name: string | null | undefined): string {
  return normalizeProjectName((name ?? '').replace(/\.[^.]+$/, ''))
}

/** 快照里的「主素材」：creator 记录的 sourceUrl 命中优先，其次第一个非音频素材。 */
export function primarySnapshotAsset(snapshot: DraftSnapshot): DraftAsset | undefined {
  const assets = snapshot.assets ?? []
  if (snapshot.sourceUrl) {
    const matched = assets.find((asset) => asset.url === snapshot.sourceUrl)
    if (matched) return matched
  }
  return assets.find((asset) => asset.kind !== 'audio') ?? assets[0]
}

/** 列表缩略图：主素材的缩略图（不复制封面，避免体积翻倍）。 */
export function projectThumbnail(snapshot: DraftSnapshot): string | undefined {
  return primarySnapshotAsset(snapshot)?.thumbnail
}

export interface ProjectSnapshotSummary {
  /** 四类轨道的片段总数。 */
  clipCount: number
  /** 时间轴总时长（秒，含空隙）。 */
  duration: number
  assetCount: number
  missingCount: number
}

/** 从快照算「最近项目」卡片上的派生信息（纯计算，不读 Blob）。 */
export function summarizeProjectSnapshot(snapshot: DraftSnapshot): ProjectSnapshotSummary {
  const project = snapshot.project
  const clipCount =
    (project.clips?.length ?? 0) +
    (project.overlayTracks ?? []).reduce((total, track) => total + track.clips.length, 0) +
    (project.audioTracks ?? []).reduce((total, track) => total + track.clips.length, 0) +
    (project.textTracks ?? []).reduce((total, track) => total + track.clips.length, 0)
  return {
    clipCount,
    duration: getProjectEnd(project),
    assetCount: snapshot.assets?.length ?? 0,
    missingCount: snapshot.missingAssets?.length ?? 0,
  }
}

/**
 * 把 v1 的单草稿（key = 'current'）迁成一条项目记录。
 * 只做纯映射：id 与时间由调用方给出，快照内容原样保留（归一化在 restore 时进行）。
 */
export function legacyProjectRecord(
  snapshot: DraftSnapshot,
  id: string,
  now = Date.now(),
): DraftProjectRecord {
  const updatedAt =
    typeof snapshot.updatedAt === 'number' && Number.isFinite(snapshot.updatedAt)
      ? snapshot.updatedAt
      : now
  return {
    id,
    name: projectNameFromSource(primarySnapshotAsset(snapshot)?.name),
    updatedAt,
    thumbnail: projectThumbnail(snapshot),
    snapshot,
  }
}

/** 最近更新的排前面（updatedAt 相同按 id 稳定排序）。 */
export function sortProjectRecords(
  records: readonly DraftProjectRecord[],
): DraftProjectRecord[] {
  return [...records].sort(
    (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
  )
}

/** 是否已达项目数量上限（达到后新增项目要提示清理）。 */
export function projectLimitReached(count: number): boolean {
  return Number.isFinite(count) && count >= PROJECT_LIMIT
}

/** 该快照是否需要在 IndexedDB 里保存媒体 blob（本地素材）。 */
export function snapshotNeedsLocalMedia(snapshot: DraftSnapshot): boolean {
  return (snapshot.assets ?? []).some(
    (asset) => asset.local === true || asset.url.startsWith('blob:'),
  )
}

/** 快照引用的本地素材 id（= media store 的 key）。 */
export function localMediaIds(snapshot: DraftSnapshot): string[] {
  return (snapshot.assets ?? [])
    .filter((asset) => asset.local === true || asset.url.startsWith('blob:'))
    .map((asset) => asset.id)
}

/**
 * 所有项目仍然引用的 media id 并集。
 * `exceptProjectId` 用于「当前项目」：它在内存里可能已被改动，
 * 存储里的快照是旧的，判定时要排除它、改用调用方给的实时引用集合。
 */
export function collectReferencedMediaIds(
  records: readonly DraftProjectRecord[],
  options: { exceptProjectId?: string | null } = {},
): Set<string> {
  const referenced = new Set<string>()
  for (const record of records) {
    if (options.exceptProjectId && record.id === options.exceptProjectId) continue
    for (const id of localMediaIds(record.snapshot)) referenced.add(id)
  }
  return referenced
}

/** 可以安全删除的 blob：存在于 media store、但已没有任何项目引用。 */
export function mediaIdsToDelete(
  storedIds: Iterable<string>,
  referenced: ReadonlySet<string>,
): string[] {
  const removable: string[] = []
  for (const id of storedIds) {
    if (!referenced.has(id)) removable.push(id)
  }
  return removable
}

const pad = (value: number): string => String(value).padStart(2, '0')

/**
 * 列表里的「更新时间」：刚刚 / N 分钟前 / 今天 HH:MM / 昨天 HH:MM / YYYY-MM-DD。
 * 不用 toLocaleString，保证不同环境输出一致、可单测。
 */
export function formatProjectUpdatedAt(updatedAt: number, now = Date.now()): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '—'
  const delta = Math.max(0, now - updatedAt)
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`

  const then = new Date(updatedAt)
  const today = new Date(now)
  const clock = `${pad(then.getHours())}:${pad(then.getMinutes())}`
  const sameDay =
    then.getFullYear() === today.getFullYear() &&
    then.getMonth() === today.getMonth() &&
    then.getDate() === today.getDate()
  if (sameDay) return `今天 ${clock}`

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const sameYesterday =
    then.getFullYear() === yesterday.getFullYear() &&
    then.getMonth() === yesterday.getMonth() &&
    then.getDate() === yesterday.getDate()
  if (sameYesterday) return `昨天 ${clock}`

  return `${then.getFullYear()}-${pad(then.getMonth() + 1)}-${pad(then.getDate())}`
}