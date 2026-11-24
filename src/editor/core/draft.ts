import type {
  AudioClip,
  CanvasBackground,
  Clip,
  Project,
  ReverseAssetOrigin,
  TextClip,
} from './types'
import { normalizeColor } from './color'
import { normalizeMask } from './mask'
import { normalizeSpeedCurve, normalizeSpeedSegments } from './speed'
import { normalizeChromaKey } from './chromaKey'
import { normalizeCover } from './cover'
import { clampExportRange, type ExportRange } from './exportRange'
import { TEXT_SHADOW_DEFAULTS } from './text'

/** 背景图 URL 跟随 blob 重建一起重映射。 */
function remapBackground(
  background: CanvasBackground | undefined,
  urlMap: Map<string, string>,
): CanvasBackground | undefined {
  if (background?.type !== 'image' || !background.imageUrl) return background
  const next = urlMap.get(background.imageUrl)
  return next ? { ...background, imageUrl: next } : background
}

/** Rewrites media URLs after restoring object URLs from IndexedDB. */
export function remapProjectUrls(project: Project, urlMap: Map<string, string>): Project {
  const remapClip = (clip: Clip): Clip => {
    const next = urlMap.get(clip.sourceUrl)
    const background = remapBackground(clip.background, urlMap)
    if (!next && background === clip.background) return clip
    return {
      ...clip,
      ...(next ? { sourceUrl: next } : {}),
      ...(background !== clip.background ? { background } : {}),
    }
  }
  const remapAudio = (clip: AudioClip): AudioClip => {
    const next = urlMap.get(clip.sourceUrl)
    return next ? { ...clip, sourceUrl: next } : clip
  }
  const remapTextClip = (clip: TextClip): TextClip => {
    if (!clip.link?.sourceUrl) return clip
    const next = urlMap.get(clip.link.sourceUrl)
    return next ? { ...clip, link: { ...clip.link, sourceUrl: next } } : clip
  }
  return {
    ...project,
    ...(remapBackground(project.canvasBackground, urlMap) !== project.canvasBackground
      ? { canvasBackground: remapBackground(project.canvasBackground, urlMap) }
      : {}),
    clips: project.clips.map(remapClip),
    overlayTracks: (project.overlayTracks ?? []).map((track) => ({
      ...track,
      clips: track.clips.map(remapClip),
    })),
    audioTracks: (project.audioTracks ?? []).map((track) => ({
      ...track,
      clips: track.clips.map(remapAudio),
    })),
    textTracks: (project.textTracks ?? []).map((track) => ({
      ...track,
      clips: track.clips.map(remapTextClip),
    })),
  }
}

/**
 * Drops clips whose media could not be restored. Empty overlay/audio/text
 * tracks are removed as well so the timeline does not show dead lanes. Caption
 * clips linked to a missing asset are dropped too.
 *
 * `keepUrls` 用来**保留占位片段**：导入工程时用户跳过、或本地已经没有 Blob 的素材，
 * 其片段不再删除，而是留在时间轴上以「素材已移除」的占位形式显示（预览跳过、
 * 导出用背景占位，见 frameCompose / exportPlan）。默认不传 = 旧行为（剔除）。
 */
export function pruneProjectUrls(
  project: Project,
  available: Set<string>,
  options: { keepUrls?: Iterable<string> } = {},
): Project {
  const kept = new Set(options.keepUrls ?? [])
  /** 素材可用，或调用方明确要求保留（占位片段）。 */
  const retained = (url: string): boolean => available.has(url) || kept.has(url)
  /** 背景图丢失时退回黑场，避免指向已失效的 blob URL。 */
  const pruneBackground = (
    background: CanvasBackground | undefined,
  ): CanvasBackground | undefined => {
    if (background?.type !== 'image' || !background.imageUrl) return background
    return available.has(background.imageUrl) ? background : { type: 'black' }
  }
  const keepClip = (clip: Clip) => retained(clip.sourceUrl)
  const pruneClipBackground = (clip: Clip): Clip => {
    if (clip.background?.type !== 'image') return clip
    const background = pruneBackground(clip.background)
    return background === clip.background ? clip : { ...clip, background }
  }
  const keepAudio = (clip: AudioClip) => retained(clip.sourceUrl)
  const keepTextClip = (clip: TextClip): boolean => {
    const url = clip.link?.sourceUrl
    if (url === undefined) return true
    return retained(url)
  }
  const overlayTracks = (project.overlayTracks ?? [])
    .map((track) => ({ ...track, clips: track.clips.filter(keepClip).map(pruneClipBackground) }))
    .filter((track) => track.clips.length > 0)
  const audioTracks = (project.audioTracks ?? [])
    .map((track) => ({ ...track, clips: track.clips.filter(keepAudio) }))
    .filter((track) => track.clips.length > 0)
  const textTracks = (project.textTracks ?? [])
    .map((track) => ({ ...track, clips: track.clips.filter(keepTextClip) }))
    .filter((track) => track.clips.length > 0)
  return {
    ...project,
    ...(project.canvasBackground
      ? { canvasBackground: pruneBackground(project.canvasBackground) }
      : {}),
    clips: project.clips.filter(keepClip).map(pruneClipBackground),
    overlayTracks,
    audioTracks,
    textTracks,
  }
}

/**
 * 调色归一化：草稿读取入口统一调用一次，把旧草稿缺失的 color 补成四个 0。
 * 已经归一化过的片段保持对象引用不变（不产生无意义的重新渲染）。
 */
export function normalizeProjectColors(project: Project): Project {
  const normalizeClip = (clip: Clip): Clip => {
    const color = normalizeColor(clip.color)
    const existing = clip.color
    if (
      existing &&
      existing.brightness === color.brightness &&
      existing.contrast === color.contrast &&
      existing.saturation === color.saturation &&
      existing.temperature === color.temperature
    ) {
      return clip
    }
    return { ...clip, color }
  }

  const clips = project.clips.map(normalizeClip)
  let changed = clips.some((clip, index) => clip !== project.clips[index])

  let overlayTracks = project.overlayTracks
  if (overlayTracks) {
    overlayTracks = overlayTracks.map((track) => {
      const nextClips = track.clips.map(normalizeClip)
      if (nextClips.every((clip, index) => clip === track.clips[index])) return track
      changed = true
      return { ...track, clips: nextClips }
    })
  }
  if (!changed) return project
  return { ...project, clips, ...(overlayTracks ? { overlayTracks } : {}) }
}

/**
 * 导出质量归一化：旧草稿没有 loudness 字段时补 `off`，非法值也回退 `off`。
 * 已经是合法设置时保持对象引用不变。
 */
export function normalizeProjectExportQuality(project: Project): Project {
  const quality = project.exportQuality
  const loudness =
    quality.loudness === 'platform' || quality.loudness === 'broadcast'
      ? quality.loudness
      : 'off'
  if (quality.loudness === loudness) return project
  return { ...project, exportQuality: { ...quality, loudness } }
}

/**
 * 文字阴影归一化：旧草稿没有 shadow* 字段时补成「关闭、无模糊、无偏移」。
 * 只补 TextClip 自身字段；组样式/单条覆盖保持缺省，让 resolveCaptionStyle
 * 的继承规则继续生效。已经归一化过的片段保持对象引用不变。
 */
export function normalizeProjectTextStyles(project: Project): Project {
  const tracks = project.textTracks
  if (!tracks || tracks.length === 0) return project
  const finiteOr = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback
  let changed = false
  const nextTracks = tracks.map((track) => {
    let trackChanged = false
    const clips = track.clips.map((clip) => {
      const rawColor = clip.shadowColor
      const shadowColor =
        typeof rawColor === 'string' && rawColor.trim().length > 0
          ? rawColor.trim()
          : TEXT_SHADOW_DEFAULTS.shadowColor
      const shadowBlur = Math.max(
        0,
        finiteOr(clip.shadowBlur, TEXT_SHADOW_DEFAULTS.shadowBlur),
      )
      const shadowOffsetX = finiteOr(
        clip.shadowOffsetX,
        TEXT_SHADOW_DEFAULTS.shadowOffsetX,
      )
      const shadowOffsetY = finiteOr(
        clip.shadowOffsetY,
        TEXT_SHADOW_DEFAULTS.shadowOffsetY,
      )
      if (
        clip.shadowColor === shadowColor &&
        clip.shadowBlur === shadowBlur &&
        clip.shadowOffsetX === shadowOffsetX &&
        clip.shadowOffsetY === shadowOffsetY
      ) {
        return clip
      }
      trackChanged = true
      return { ...clip, shadowColor, shadowBlur, shadowOffsetX, shadowOffsetY }
    })
    if (!trackChanged) return track
    changed = true
    return { ...track, clips }
  })
  return changed ? { ...project, textTracks: nextTracks } : project
}

/** 旧草稿/工程文件里的封面字段做一次归一化（不合法就当没有封面）。 */
/**
 * 蒙版归一化：旧草稿没有 mask 字段时保持 undefined（没有蒙版）；
 * 有字段时把形状/比例/角度/羽化夹到合法范围，非法值回落默认。
 * 已合法的蒙版保持对象引用不变（避免无意义的重新渲染）。
 */
/**
 * 抠像归一化：旧草稿没有 chromaKey 字段时保持 undefined（不抠像）；
 * 有字段时夹取 similarity / blend / spill 并把颜色规范成 #rrggbb。
 * 已合法的参数保持对象引用不变（避免无意义的重新渲染）。
 */
export function normalizeProjectChromaKeys(project: Project): Project {
  const normalizeClip = (clip: Clip): Clip => {
    if (clip.chromaKey === undefined) return clip
    const key = normalizeChromaKey(clip.chromaKey)
    if (!key) {
      const next = { ...clip }
      delete next.chromaKey
      return next
    }
    const same =
      clip.chromaKey.color === key.color &&
      clip.chromaKey.similarity === key.similarity &&
      clip.chromaKey.blend === key.blend &&
      clip.chromaKey.spill === key.spill
    return same ? clip : { ...clip, chromaKey: key }
  }

  const clips = project.clips.map(normalizeClip)
  let changed = clips.some((clip, index) => clip !== project.clips[index])

  let overlayTracks = project.overlayTracks
  if (overlayTracks) {
    overlayTracks = overlayTracks.map((track) => {
      const nextClips = track.clips.map(normalizeClip)
      if (nextClips.every((clip, index) => clip === track.clips[index])) return track
      changed = true
      return { ...track, clips: nextClips }
    })
  }
  if (!changed) return project
  return { ...project, clips, ...(overlayTracks ? { overlayTracks } : {}) }
}

export function normalizeProjectMasks(project: Project): Project {
  const normalizeClip = (clip: Clip): Clip => {
    if (clip.mask === undefined) return clip
    const mask = normalizeMask(clip.mask)
    if (!mask) {
      const next = { ...clip }
      delete next.mask
      return next
    }
    const same =
      clip.mask.shape === mask.shape &&
      clip.mask.x === mask.x &&
      clip.mask.y === mask.y &&
      clip.mask.width === mask.width &&
      clip.mask.height === mask.height &&
      clip.mask.rotation === mask.rotation &&
      (clip.mask.roundness ?? 0) === (mask.roundness ?? 0) &&
      clip.mask.feather === mask.feather &&
      clip.mask.invert === mask.invert
    return same ? clip : { ...clip, mask }
  }

  const clips = project.clips.map(normalizeClip)
  let changed = clips.some((clip, index) => clip !== project.clips[index])

  let overlayTracks = project.overlayTracks
  if (overlayTracks) {
    overlayTracks = overlayTracks.map((track) => {
      const nextClips = track.clips.map(normalizeClip)
      if (nextClips.every((clip, index) => clip === track.clips[index])) return track
      changed = true
      return { ...track, clips: nextClips }
    })
  }
  if (!changed) return project
  return { ...project, clips, ...(overlayTracks ? { overlayTracks } : {}) }
}

/**
 * 变速分段 / 平滑曲线的归一化：
 * - 非法段表（不足 2 段、段速越界、`at` 不递增）被夹取或清空；
 * - `speedCurve` 同样夹取（曲线本身在 segmentPlan 里采样，这里只保证数据干净）；
 * - 已经合法的对象保持引用不变（避免无意义的重新渲染）。
 */
export function normalizeProjectSpeedSegments(project: Project): Project {
  const normalizeClip = (clip: Clip): Clip => {
    const segments = normalizeSpeedSegments(clip.speedSegments)
    const curve = normalizeSpeedCurve(clip.speedCurve)
    let next = clip
    if (segments) {
      const same =
        Array.isArray(clip.speedSegments) &&
        clip.speedSegments.length === segments.length &&
        clip.speedSegments.every(
          (item, index) =>
            item.at === segments[index].at && item.speed === segments[index].speed,
        )
      if (!same) next = { ...next, speedSegments: segments }
    } else if (clip.speedSegments !== undefined) {
      // 只有 1 段或全部非法 → 视为「没有分段」，走单一 speed。
      next = { ...next }
      delete next.speedSegments
    }
    if (curve) {
      const sameCurve =
        Array.isArray(clip.speedCurve) &&
        clip.speedCurve.length === curve.length &&
        clip.speedCurve.every(
          (item, index) => item.at === curve[index].at && item.speed === curve[index].speed,
        )
      if (!sameCurve) next = { ...next, speedCurve: curve }
    } else if (clip.speedCurve !== undefined) {
      next = next === clip ? { ...clip } : next
      delete next.speedCurve
    }
    return next
  }

  const clips = project.clips.map(normalizeClip)
  let changed = clips.some((clip, index) => clip !== project.clips[index])

  let overlayTracks = project.overlayTracks
  if (overlayTracks) {
    overlayTracks = overlayTracks.map((track) => {
      const nextClips = track.clips.map(normalizeClip)
      if (nextClips.every((clip, index) => clip === track.clips[index])) return track
      changed = true
      return { ...track, clips: nextClips }
    })
  }
  if (!changed) return project
  return { ...project, clips, ...(overlayTracks ? { overlayTracks } : {}) }
}

export function normalizeProjectCover(project: Project): Project {
  const cover = normalizeCover(project.cover)
  const current = project.cover
  if (!cover) {
    if (!current) return project
    const { cover: _omit, ...rest } = project
    return rest
  }
  const same =
    current !== undefined &&
    current.dataUrl === cover.dataUrl &&
    current.mode === cover.mode &&
    current.source?.kind === cover.source.kind &&
    (cover.source.kind === 'frame'
      ? (current.source as { time?: number }).time === cover.source.time
      : (current.source as { name?: string }).name === cover.source.name)
  return same ? project : { ...project, cover }
}

/** 收集工程里所有媒体 URL（含背景图），供草稿保存 Blob / 重载重建。 */
export function projectMediaUrls(project: Project): Set<string> {
  const urls = new Set<string>()
  const addBackground = (background: CanvasBackground | undefined): void => {
    if (background?.type === 'image' && background.imageUrl) urls.add(background.imageUrl)
  }
  addBackground(project.canvasBackground)
  for (const clip of project.clips) {
    urls.add(clip.sourceUrl)
    addBackground(clip.background)
  }
  for (const track of project.overlayTracks ?? []) {
    for (const clip of track.clips) {
      urls.add(clip.sourceUrl)
      addBackground(clip.background)
    }
  }
  for (const track of project.audioTracks ?? []) {
    for (const clip of track.clips) urls.add(clip.sourceUrl)
  }
  for (const track of project.textTracks ?? []) {
    for (const clip of track.clips) {
      if (clip.link?.sourceUrl) urls.add(clip.link.sourceUrl)
    }
  }
  return urls
}

/** 旧草稿：把 link.sourceUrl 迁移成稳定的 asset id。 */
export function migrateCaptionLinks(
  project: Project,
  assetIdByUrl: Map<string, string>,
): Project {
  const migrate = (clip: TextClip): TextClip => {
    if (!clip.link || clip.link.assetId) return clip
    const assetId = clip.link.sourceUrl
      ? assetIdByUrl.get(clip.link.sourceUrl)
      : undefined
    return { ...clip, link: { ...clip.link, assetId } }
  }
  return {
    ...project,
    textTracks: (project.textTracks ?? []).map((track) => ({
      ...track,
      clips: track.clips.map(migrate),
    })),
  }
}

export type DraftAssetKind = 'video' | 'audio' | 'image'

export interface DraftAsset {
  id: string
  url: string
  name: string
  size: number
  duration: number
  width: number
  height: number
  kind?: DraftAssetKind
  hasAudio?: boolean
  thumbnail?: string
  /** 素材库文件夹；缺省未分类（旧草稿无此字段）。 */
  folder?: string
  /** True when the original media was stored as a Blob in IndexedDB. */
  local?: boolean
  /** 「倒放」素材的来源区间；旧草稿没有该字段。 */
  reversedFrom?: ReverseAssetOrigin
}

/**
 * 工程引用了、但这台机器上没有 Blob 的素材。
 *
 * 记录它是为了**占位片段能跨刷新保留**：导入工程时用户跳过（或读不出来）的素材，
 * 片段继续显示在时间轴上（「素材已移除」），下次保存/恢复草稿时靠这份元信息把
 * 这些片段重新保留下来，而不是被 `pruneProjectUrls` 当作丢失素材删掉。
 */
export interface MissingAsset {
  /** 工程里片段引用的那个 url（通常是导出机器上的 blob: URL）。 */
  url: string
  /** 展示用名称；宿主 API 没有元信息时可能只有 url。 */
  name?: string
  kind?: DraftAssetKind
  /** 原始时长（秒），仅用于对话框展示。 */
  duration?: number
}

/** 宽容读取 missingAssets（旧快照 / 手改工程文件可能没有该字段或结构不合法）。 */
export function normalizeMissingAssets(input: unknown): MissingAsset[] {
  if (!Array.isArray(input)) return []
  const result: MissingAsset[] = []
  for (const item of input) {
    if (!item || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    if (typeof raw.url !== 'string' || raw.url.length === 0) continue
    const kind =
      raw.kind === 'video' || raw.kind === 'audio' || raw.kind === 'image' ? raw.kind : undefined
    result.push({
      url: raw.url,
      ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
      ...(kind ? { kind } : {}),
      ...(typeof raw.duration === 'number' && Number.isFinite(raw.duration)
        ? { duration: raw.duration }
        : {}),
    })
  }
  return result
}

export interface DraftSettings {
  mainTrackMagnet: boolean
  autoSnap: boolean
  linkage: boolean
  previewAxis: boolean
  captionFollow: boolean
  /**
   * 导出区间（入点 / 出点，秒）。旧草稿没有该字段时按 null 处理 = 导出全部，
   * 读取时统一走 normalizeDraftExportRange 补齐 / 夹取。
   */
  exportRange?: ExportRange | null
}

/**
 * 导出区间归一化（草稿与工程文件的读取入口统一调用一次）：
 * 缺省为 null；工程时长变短后越界会夹回有效范围；长度不足 0.1 秒视为未设置。
 */
export function normalizeDraftExportRange(
  range: ExportRange | null | undefined,
  duration: number,
): ExportRange | null {
  return clampExportRange(range ?? null, duration)
}

/**
 * 草稿快照的**外壳**版本（与工程结构的 PROJECT_SCHEMA_VERSION 独立）。
 *
 * 1：最初版本（version 字段可能缺失）。
 * 2：坐标系/字段补齐后的版本；读取时统一走 {@link migrateDraftSnapshot}。
 */
export const DRAFT_SCHEMA_VERSION = 2

export interface DraftSnapshot {
  /**
   * 快照版本。**旧数据可能没有这个字段**，所以类型上是 number 且读取时按 1 处理；
   * 写入永远写 DRAFT_SCHEMA_VERSION。
   */
  version: number
  project: Project
  assets: DraftAsset[]
  /**
   * 工程引用、但本地没有 Blob 的素材（占位片段）。旧快照没有这个字段。
   * 恢复时这些 url 的片段会被保留而不是剔除。
   */
  missingAssets?: MissingAsset[]
  sourceUrl: string | null
  timelineZoom: number
  timelineSettings: DraftSettings
  playhead: number
  updatedAt: number
}

/** 迁移时允许的宽松输入（旧版本可能缺一堆字段）。 */
export type RawDraftSnapshot = Record<string, unknown>

export interface DraftSnapshotMigrationResult {
  snapshot: DraftSnapshot
  /** 输入声明的版本（缺失时按 1 处理）。 */
  fromVersion: number
  warnings: string[]
}

const DEFAULT_DRAFT_SETTINGS: DraftSettings = {
  mainTrackMagnet: false,
  autoSnap: true,
  linkage: false,
  previewAxis: true,
  captionFollow: true,
  exportRange: null,
}

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

/**
 * 把任意来源的草稿快照迁移成当前版本。
 *
 * 明确处理「缺字段」这种情况（原来直接读 `snapshot.timelineSettings.mainTrackMagnet`
 * 会抛错，然后被上层 `catch {}` 吞掉 → 用户看到的是"草稿静默恢复失败"）：
 * - `version` 缺失 → 按 1；
 * - `timelineZoom` / `playhead` 缺失或非法 → 0（**不是** NaN）；
 * - `timelineSettings` 缺失 → 全部默认值；
 * - `assets` / `project` 缺失 → 空数组 / 空工程（具体由 normalizeProject 兜底）。
 */
export function migrateDraftSnapshot(input: unknown): DraftSnapshotMigrationResult {
  const warnings: string[] = []
  const raw: RawDraftSnapshot = typeof input === 'object' && input !== null
    ? (input as RawDraftSnapshot)
    : {}

  const declared = numberOr(raw.version, 1)
  const fromVersion = Math.max(1, Math.floor(declared))
  if (typeof raw.version !== 'number') {
    warnings.push('草稿缺少 version 字段，按 v1 处理')
  } else if (fromVersion > DRAFT_SCHEMA_VERSION) {
    warnings.push(`草稿版本 ${fromVersion} 高于当前支持的 ${DRAFT_SCHEMA_VERSION}，尽力读取`)
  }

  const settingsRaw = typeof raw.timelineSettings === 'object' && raw.timelineSettings !== null
    ? (raw.timelineSettings as RawDraftSnapshot)
    : {}
  if (!raw.timelineSettings) warnings.push('草稿缺少 timelineSettings，已填默认值')

  if (typeof raw.timelineZoom !== 'number' || !Number.isFinite(raw.timelineZoom)) {
    if (raw.timelineZoom === undefined) warnings.push('草稿缺少 timelineZoom，已填默认值')
  }
  if (typeof raw.playhead !== 'number' || !Number.isFinite(raw.playhead)) {
    if (raw.playhead === undefined) warnings.push('草稿缺少 playhead，已填默认值')
  }

  const timelineSettings: DraftSettings = {
    mainTrackMagnet:
      typeof settingsRaw.mainTrackMagnet === 'boolean'
        ? settingsRaw.mainTrackMagnet
        : DEFAULT_DRAFT_SETTINGS.mainTrackMagnet,
    autoSnap:
      typeof settingsRaw.autoSnap === 'boolean' ? settingsRaw.autoSnap : DEFAULT_DRAFT_SETTINGS.autoSnap,
    linkage:
      typeof settingsRaw.linkage === 'boolean' ? settingsRaw.linkage : DEFAULT_DRAFT_SETTINGS.linkage,
    previewAxis:
      typeof settingsRaw.previewAxis === 'boolean'
        ? settingsRaw.previewAxis
        : DEFAULT_DRAFT_SETTINGS.previewAxis,
    // 旧草稿没有 captionFollow：默认开启（与界面默认一致）。
    captionFollow:
      typeof settingsRaw.captionFollow === 'boolean'
        ? settingsRaw.captionFollow
        : DEFAULT_DRAFT_SETTINGS.captionFollow,
    exportRange:
      settingsRaw.exportRange === undefined || settingsRaw.exportRange === null
        ? null
        : (settingsRaw.exportRange as ExportRange),
  }

  const snapshot: DraftSnapshot = {
    version: DRAFT_SCHEMA_VERSION,
    project: (raw.project ?? null) as Project,
    assets: Array.isArray(raw.assets) ? (raw.assets as DraftAsset[]) : [],
    missingAssets: normalizeMissingAssets(raw.missingAssets),
    sourceUrl: typeof raw.sourceUrl === 'string' ? raw.sourceUrl : null,
    timelineZoom: numberOr(raw.timelineZoom, 0),
    timelineSettings,
    playhead: Math.max(0, numberOr(raw.playhead, 0)),
    updatedAt: numberOr(raw.updatedAt, Date.now()),
  }

  return { snapshot, fromVersion, warnings }
}