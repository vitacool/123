import type { Clip, MediaAsset, Project } from './types'

/**
 * 素材与片段之间的引用关系判断（素材库、时间轴、预览、导出共用同一套规则）。
 *
 * 片段通过 `clip.sourceUrl` 间接引用素材（asset.url）；字幕片段的
 * `link.assetId` 记录的是素材 id。素材被从素材库移除后，这些引用就变成
 * 「素材缺失」，UI 需要显示占位而不是静默画错素材。
 */

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

/** 未被任何片段引用的素材（用于「清理未使用」）。 */
export function unusedAssets<T extends { id: string; url: string }>(
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
  return assets.filter((asset) => !usedUrls.has(asset.url) && !usedAssetIds.has(asset.id))
}