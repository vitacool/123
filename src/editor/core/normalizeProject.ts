import type {
  AudioClip,
  AudioTrack,
  Clip,
  Marker,
  OverlayTrack,
  Project,
  TextClip,
  TextTrack,
} from './types'
import {
  normalizeProjectChromaKeys,
  normalizeProjectColors,
  normalizeProjectCover,
  normalizeProjectExportQuality,
  normalizeProjectMasks,
  normalizeProjectSpeedSegments,
  normalizeProjectTextStyles,
  migrateCaptionLinks,
} from './draft'
import { normalizeDraftExportRange } from './draft'
import type { CropRect, Point } from './types'

/**
 * 工程数据的**唯一**归一化入口。
 *
 * 为什么要有这个文件：归一化链原来写了两份（宿主 API 加载工程、从草稿恢复），
 * 两处的函数列表还不一致——`api.ts` 少了 `migrateCaptionLinks`，于是通过宿主 API
 * 载入的工程里，智能字幕的 `link.assetId` 不会被迁移（字幕错位/丢失）。
 * 现在两条路径都只调 `normalizeProject()`，差异不可能再出现。
 *
 * 它做三件事，顺序固定：
 * 1. **版本迁移**：`schemaVersion` 缺失按 1 处理，按 `MIGRATIONS` 逐级升到当前版本；
 * 2. **结构校验**：字段缺失填默认值，非法值（如 `sourceStart >= sourceEnd`）修正并记警告；
 * 3. **渐进式字段归一化**：调既有的 per-aspect normalizer（颜色/文字/抠像/蒙版/变速/封面/画质）。
 */

/** 工程 schema 版本（与草稿快照版本独立：一个是工程结构，一个是快照外壳）。 */
export const PROJECT_SCHEMA_VERSION = 2

export type NormalizeWarningCode =
  | 'clip-dropped'
  | 'clip-repaired'
  | 'track-repaired'
  | 'marker-dropped'
  | 'project-repaired'
  | 'migration-applied'
  | 'unknown-version'

export interface NormalizeWarning {
  code: NormalizeWarningCode
  message: string
  /** 出问题的实体 id（片段/轨道/标记），便于定位。 */
  id?: string
}

export interface NormalizeProjectResult {
  project: Project
  warnings: NormalizeWarning[]
  /** 输入声明的版本（缺失时按 1 处理）。 */
  fromVersion: number
}

type Raw = Record<string, unknown>

const isObject = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const finite = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

const str = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.length > 0 ? value : fallback

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

const FULL_CROP: CropRect = { x: 0, y: 0, w: 1, h: 1 }
const ZERO_POINT: Point = { x: 0, y: 0 }

// ---------------------------------------------------------------- 迁移表

/**
 * 版本迁移：key = 起始版本，值 = 升到 key+1 的变换。
 *
 * 迁移只做**结构**层的改动（补字段 / 改名 / 拆合），字段级取值修复交给下面的校验，
 * 这样迁移表保持小而可读，新增一个版本只需要加一条。
 */
const MIGRATIONS: Record<number, (project: Raw, warn: (warning: NormalizeWarning) => void) => Raw> = {
  /**
   * 1 → 2：早期工程没有 `type` 与 `markers`。
   * - 没有 `type` 的片段一律当视频（当时只有视频片段）；
   * - 没有 `markers` 时补空数组（渲染层会直接 `map` 它）。
   */
  1: (project, warn) => {
    const next: Raw = { ...project }
    if (!Array.isArray(next.markers)) next.markers = []
    if (Array.isArray(next.clips)) {
      next.clips = next.clips.map((clip) => {
        if (!isObject(clip)) return clip
        if (typeof clip.type === 'string') return clip
        return { ...clip, type: 'video' }
      })
    }
    warn({
      code: 'migration-applied',
      message: '工程结构已从 v1 升级到 v2（补 type / markers）',
    })
    return next
  },
}

/** 按版本顺序执行迁移；输入版本高于当前版本时不做任何迁移（宁可只校验）。 */
function migrate(raw: Raw, fromVersion: number, warn: (warning: NormalizeWarning) => void): Raw {
  let project = raw
  for (let version = fromVersion; version < PROJECT_SCHEMA_VERSION; version += 1) {
    const step = MIGRATIONS[version]
    if (!step) break
    project = step(project, warn)
  }
  return project
}

// ---------------------------------------------------------------- 结构校验

function normalizeCrop(value: unknown): CropRect {
  if (!isObject(value)) return { ...FULL_CROP }
  const w = clampNumber(finite(value.w, 1), 0.01, 1)
  const h = clampNumber(finite(value.h, 1), 0.01, 1)
  return {
    x: clampNumber(finite(value.x, 0), 0, Math.max(0, 1 - w)),
    y: clampNumber(finite(value.y, 0), 0, Math.max(0, 1 - h)),
    w,
    h,
  }
}

function normalizePoint(value: unknown): Point {
  if (!isObject(value)) return { ...ZERO_POINT }
  return { x: finite(value.x, 0), y: finite(value.y, 0) }
}

/**
 * 校验一个片段。
 * 返回 null 表示这条片段必须丢弃（没有 id / 没有素材 URL / 时长非法且无法修复）。
 */
function normalizeClip(raw: unknown, warn: (warning: NormalizeWarning) => void): Clip | null {
  if (!isObject(raw)) {
    warn({ code: 'clip-dropped', message: '片段不是对象，已丢弃' })
    return null
  }
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (!id) {
    warn({ code: 'clip-dropped', message: '片段缺少 id，已丢弃' })
    return null
  }
  const sourceUrl = typeof raw.sourceUrl === 'string' ? raw.sourceUrl : ''
  if (!sourceUrl) {
    warn({ code: 'clip-dropped', message: `片段 ${id} 缺少 sourceUrl，已丢弃`, id })
    return null
  }

  const type: Clip['type'] =
    raw.type === 'freeze' || raw.type === 'image' ? raw.type : 'video'

  let sourceStart = finite(raw.sourceStart, 0)
  let sourceEnd = finite(raw.sourceEnd, 0)
  let repaired = false

  if (sourceStart < 0) {
    sourceStart = 0
    repaired = true
  }
  // 非法区间（起点 >= 终点）无法推断原意：给一个 1 秒的最小时长而不是丢片段，
  // 这样用户至少还能在时间轴上看到并删除它（丢片段会让人以为工程坏了）。
  if (!(sourceEnd > sourceStart)) {
    sourceEnd = sourceStart + 1
    repaired = true
  }
  if (repaired) {
    warn({
      code: 'clip-repaired',
      message: `片段 ${id} 的源区间非法，已修正为 ${sourceStart.toFixed(2)}–${sourceEnd.toFixed(2)}`,
      id,
    })
  }

  const clip: Clip = {
    id,
    sourceUrl,
    sourceStart,
    sourceEnd,
    type,
    rotation: finite(raw.rotation, 0),
    flipH: bool(raw.flipH, false),
    flipV: bool(raw.flipV, false),
    crop: normalizeCrop(raw.crop),
    scale: clampNumber(finite(raw.scale, 1), 0.01, 20),
    position: normalizePoint(raw.position),
  }

  const gapBefore = finite(raw.gapBefore, 0)
  if (gapBefore > 0) clip.gapBefore = gapBefore
  if (typeof raw.freezeFrameTime === 'number' && Number.isFinite(raw.freezeFrameTime)) {
    clip.freezeFrameTime = raw.freezeFrameTime
  }
  if (typeof raw.volume === 'number') clip.volume = clampNumber(finite(raw.volume, 1), 0, 2)
  if (typeof raw.fadeIn === 'number') clip.fadeIn = Math.max(0, finite(raw.fadeIn, 0))
  if (typeof raw.fadeOut === 'number') clip.fadeOut = Math.max(0, finite(raw.fadeOut, 0))
  if (typeof raw.speed === 'number' || typeof raw.keepPitch === 'boolean') {
    clip.speed = clampNumber(finite(raw.speed, 1), 0.1, 10)
    clip.keepPitch = bool(raw.keepPitch, true)
  }
  if (typeof raw.opacity === 'number') clip.opacity = clampNumber(finite(raw.opacity, 1), 0, 1)
  if (typeof raw.blendMode === 'string') clip.blendMode = raw.blendMode as Clip['blendMode']
  if (Array.isArray(raw.speedSegments)) clip.speedSegments = raw.speedSegments as Clip['speedSegments']
  if (Array.isArray(raw.speedCurve)) clip.speedCurve = raw.speedCurve as Clip['speedCurve']
  if (isObject(raw.transitionOut)) clip.transitionOut = raw.transitionOut as unknown as Clip['transitionOut']
  if (isObject(raw.background)) clip.background = raw.background as unknown as Clip['background']
  if (isObject(raw.anim)) clip.anim = raw.anim as Clip['anim']
  if (isObject(raw.mask)) clip.mask = raw.mask as unknown as Clip['mask']
  if (isObject(raw.chromaKey)) clip.chromaKey = raw.chromaKey as unknown as Clip['chromaKey']
  if (isObject(raw.color)) clip.color = raw.color as Clip['color']
  return clip
}

function normalizeClips(
  raw: unknown,
  warn: (warning: NormalizeWarning) => void,
  label: string,
): Clip[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) {
      warn({ code: 'project-repaired', message: `${label}不是数组，已按空处理` })
    }
    return []
  }
  const clips: Clip[] = []
  for (const item of raw) {
    const clip = normalizeClip(item, warn)
    if (clip) clips.push(clip)
  }
  return clips
}

function normalizeOverlayTracks(
  raw: unknown,
  warn: (warning: NormalizeWarning) => void,
): OverlayTrack[] {
  if (!Array.isArray(raw)) return []
  const tracks: OverlayTrack[] = []
  raw.forEach((item, index) => {
    if (!isObject(item)) {
      warn({ code: 'track-repaired', message: `叠加轨 #${index + 1} 不是对象，已丢弃` })
      return
    }
    const id = str(item.id, `overlay-${index + 1}`)
    tracks.push({
      id,
      name: str(item.name, `叠加轨 ${index + 1}`),
      muted: bool(item.muted, false),
      hidden: bool(item.hidden, false),
      enabled: bool(item.enabled, true),
      locked: bool(item.locked, false),
      solo: bool(item.solo, false),
      clips: normalizeClips(item.clips, warn, `叠加轨 ${id} 的片段列表`),
    })
  })
  return tracks
}

function normalizeAudioClip(raw: unknown, warn: (warning: NormalizeWarning) => void): AudioClip | null {
  if (!isObject(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id : ''
  const sourceUrl = typeof raw.sourceUrl === 'string' ? raw.sourceUrl : ''
  if (!id || !sourceUrl) {
    warn({ code: 'clip-dropped', message: '音频片段缺少 id 或 sourceUrl，已丢弃', id: id || undefined })
    return null
  }
  let sourceStart = Math.max(0, finite(raw.sourceStart, 0))
  let sourceEnd = finite(raw.sourceEnd, 0)
  if (!(sourceEnd > sourceStart)) {
    sourceEnd = sourceStart + 1
    warn({ code: 'clip-repaired', message: `音频片段 ${id} 的源区间非法，已修正`, id })
  }
  return {
    id,
    sourceUrl,
    sourceStart,
    sourceEnd,
    start: Math.max(0, finite(raw.start, 0)),
    volume: clampNumber(finite(raw.volume, 1), 0, 2),
    fadeIn: Math.max(0, finite(raw.fadeIn, 0)),
    fadeOut: Math.max(0, finite(raw.fadeOut, 0)),
    ...(isObject(raw.anim) ? { anim: raw.anim as AudioClip['anim'] } : {}),
  } as AudioClip
}

function normalizeAudioTracks(
  raw: unknown,
  warn: (warning: NormalizeWarning) => void,
): AudioTrack[] {
  if (!Array.isArray(raw)) return []
  const tracks: AudioTrack[] = []
  raw.forEach((item, index) => {
    if (!isObject(item)) return
    const id = str(item.id, `audio-${index + 1}`)
    const clips: AudioClip[] = []
    if (Array.isArray(item.clips)) {
      for (const clip of item.clips) {
        const normalized = normalizeAudioClip(clip, warn)
        if (normalized) clips.push(normalized)
      }
    }
    tracks.push({
      id,
      name: str(item.name, `音频轨 ${index + 1}`),
      muted: bool(item.muted, false),
      hidden: bool(item.hidden, false),
      enabled: bool(item.enabled, true),
      locked: bool(item.locked, false),
      solo: bool(item.solo, false),
      volume: clampNumber(finite(item.volume, 1), 0, 2),
      clips,
    })
  })
  return tracks
}

function normalizeTextClip(raw: unknown, warn: (warning: NormalizeWarning) => void): TextClip | null {
  if (!isObject(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (!id) return null
  let start = Math.max(0, finite(raw.start, 0))
  let end = finite(raw.end, 0)
  if (!(end > start)) {
    end = start + 1
    warn({ code: 'clip-repaired', message: `字幕片段 ${id} 的时间区间非法，已修正`, id })
  }
  return {
    ...(raw as unknown as TextClip),
    id,
    start,
    end,
  } as TextClip
}

function normalizeTextTracks(
  raw: unknown,
  warn: (warning: NormalizeWarning) => void,
): TextTrack[] {
  if (!Array.isArray(raw)) return []
  const tracks: TextTrack[] = []
  raw.forEach((item, index) => {
    if (!isObject(item)) return
    const id = str(item.id, `text-${index + 1}`)
    const clips: TextClip[] = []
    if (Array.isArray(item.clips)) {
      for (const clip of item.clips) {
        const normalized = normalizeTextClip(clip, warn)
        if (normalized) clips.push(normalized)
      }
    }
    tracks.push({
      ...(item as unknown as TextTrack),
      id,
      name: str(item.name, `字幕轨 ${index + 1}`),
      clips,
    })
  })
  return tracks
}

function normalizeMarkers(raw: unknown, warn: (warning: NormalizeWarning) => void): Marker[] {
  if (!Array.isArray(raw)) return []
  const markers: Marker[] = []
  for (const item of raw) {
    if (!isObject(item)) {
      warn({ code: 'marker-dropped', message: '标记不是对象，已丢弃' })
      continue
    }
    const id = typeof item.id === 'string' ? item.id : ''
    const time = finite(item.time, Number.NaN)
    if (!id || !Number.isFinite(time) || time < 0) {
      warn({ code: 'marker-dropped', message: '标记缺少 id 或时间非法，已丢弃', id: id || undefined })
      continue
    }
    markers.push({
      id,
      time,
      color: str(item.color, '#ffd166'),
      note: typeof item.note === 'string' ? item.note : '',
    })
  }
  return markers
}

/** 校验 + 修复一个可能来自旧版本/外部系统的工程对象。 */
export function normalizeProject(
  input: unknown,
  options: { assetIdByUrl?: Map<string, string> } = {},
): NormalizeProjectResult {
  const warnings: NormalizeWarning[] = []
  const warn = (warning: NormalizeWarning): void => {
    warnings.push(warning)
  }

  if (!isObject(input)) {
    warn({ code: 'project-repaired', message: '工程不是对象，已重置为空工程' })
    return {
      project: {
        aspectRatio: '16:9',
        clips: [],
        markers: [],
        exportQuality: { resolution: '480p', fps: 30, loudness: 'off' },
        overlayTracks: [],
        audioTracks: [],
        textTracks: [],
      } as Project,
      warnings,
      fromVersion: 1,
    }
  }

  const declared = finite(input.schemaVersion, 1)
  const fromVersion = Math.max(1, Math.floor(declared))
  if (typeof input.schemaVersion === 'number' && fromVersion > PROJECT_SCHEMA_VERSION) {
    warn({
      code: 'unknown-version',
      message: `工程 schema 版本 ${fromVersion} 高于当前支持的 ${PROJECT_SCHEMA_VERSION}，仅做校验`,
    })
  }

  const migrated = migrate(input, fromVersion, warn)

  // 先做结构校验（补齐缺省、剔除非法），再交给既有的 per-aspect normalizer。
  const structural: Project = {
    aspectRatio: str(migrated.aspectRatio, '16:9') as Project['aspectRatio'],
    clips: normalizeClips(migrated.clips, warn, '主轨片段列表'),
    overlayTracks: normalizeOverlayTracks(migrated.overlayTracks, warn),
    audioTracks: normalizeAudioTracks(migrated.audioTracks, warn),
    textTracks: normalizeTextTracks(migrated.textTracks, warn),
    mainTrack: isObject(migrated.mainTrack) ? (migrated.mainTrack as Project['mainTrack']) : undefined,
    markers: normalizeMarkers(migrated.markers, warn),
    exportQuality: isObject(migrated.exportQuality)
      ? (migrated.exportQuality as unknown as Project['exportQuality'])
      : ({} as Project['exportQuality']),
    ...(isObject(migrated.canvasBackground)
      ? { canvasBackground: migrated.canvasBackground as unknown as Project['canvasBackground'] }
      : {}),
    ...(isObject(migrated.cover) ? { cover: migrated.cover as unknown as Project['cover'] } : {}),
  }

  let project: Project = normalizeProjectExportQuality(
    normalizeProjectTextStyles(
      normalizeProjectSpeedSegments(
        normalizeProjectCover(
          normalizeProjectChromaKeys(
            normalizeProjectMasks(normalizeProjectColors(structural)),
          ),
        ),
      ),
    ),
  )

  // 智能字幕 link 迁移：把 link.assetId 补成素材 id（宿主 API 路径曾经漏掉这一步）。
  if (options.assetIdByUrl) {
    project = migrateCaptionLinks(project, options.assetIdByUrl)
  }

  return { project, warnings, fromVersion }
}

/**
 * 只关心工程本身的便捷封装（忽略警告）。
 * 需要记录日志/上报时用 `normalizeProject()` 拿 warnings。
 */
export function normalizeProjectQuiet(input: unknown, assetIdByUrl?: Map<string, string>): Project {
  return normalizeProject(input, assetIdByUrl ? { assetIdByUrl } : {}).project
}

/** 导出区间归一化（转出，避免调用方重复从 draft.ts 引入）。 */
export { normalizeDraftExportRange }