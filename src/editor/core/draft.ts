import type { AudioClip, CanvasBackground, Clip, Project, TextClip } from './types'

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
 */
export function pruneProjectUrls(project: Project, available: Set<string>): Project {
  /** 背景图丢失时退回黑场，避免指向已失效的 blob URL。 */
  const pruneBackground = (
    background: CanvasBackground | undefined,
  ): CanvasBackground | undefined => {
    if (background?.type !== 'image' || !background.imageUrl) return background
    return available.has(background.imageUrl) ? background : { type: 'black' }
  }
  const keepClip = (clip: Clip) => available.has(clip.sourceUrl)
  const pruneClipBackground = (clip: Clip): Clip => {
    if (clip.background?.type !== 'image') return clip
    const background = pruneBackground(clip.background)
    return background === clip.background ? clip : { ...clip, background }
  }
  const keepAudio = (clip: AudioClip) => available.has(clip.sourceUrl)
  const keepTextClip = (clip: TextClip): boolean => {
    const url = clip.link?.sourceUrl
    if (url === undefined) return true
    return available.has(url)
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
  /** True when the original media was stored as a Blob in IndexedDB. */
  local?: boolean
}

export interface DraftSettings {
  mainTrackMagnet: boolean
  autoSnap: boolean
  linkage: boolean
  previewAxis: boolean
  captionFollow: boolean
}

export interface DraftSnapshot {
  version: 1
  project: Project
  assets: DraftAsset[]
  sourceUrl: string | null
  timelineZoom: number
  timelineSettings: DraftSettings
  playhead: number
  updatedAt: number
}