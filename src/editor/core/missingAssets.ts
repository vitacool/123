import type { Project } from './types'
import type { DraftAsset, MissingAsset } from './draft'

/**
 * 「缺失素材」选择状态（纯逻辑，可在 node 环境单测）。
 *
 * 导入工程时用户可能跳过部分素材：这些素材的片段保留为占位（见 pruneProjectUrls
 * 的 keepUrls），所以既需要记住「哪些已经选了文件」，也需要记住「哪些明确跳过」，
 * 才能把选择结果换算成 MissingAsset 元信息。
 */
export interface MissingAssetsSelection {
  /** 素材 id → 用户选中的文件。 */
  picked: Map<string, File>
  /** 用户明确跳过的素材 id（点「跳过」或取消选择框）。 */
  skipped: Set<string>
}

/** 文件名归一化：去代理后缀、去扩展名、去首尾空白、小写（用于自动匹配）。 */
export function normalizeAssetName(name: string): string {
  return (name ?? '')
    .replace(/\.[^.]+$/, '')
    // HEVC 等素材导入时会生成「原名-h264.mp4」代理并把它当作 asset.name 持久化。
    // 匹配时剥掉这个后缀，用户一次多选原文件（旅行.mov）才不会被判成「已忽略」。
    .replace(/-(h264|h265|hevc)$/i, '')
    .trim()
    .toLowerCase()
}

/** 把一个工程文件里的素材元信息转成「缺失素材」记录（占位片段持久化用）。 */
export function missingAssetFromDraft(asset: DraftAsset): MissingAsset {
  return {
    url: asset.url,
    name: asset.name,
    ...(asset.kind ? { kind: asset.kind } : {}),
    ...(Number.isFinite(asset.duration) ? { duration: asset.duration } : {}),
  }
}

/** 按 url 合并缺失素材列表（后出现的补全/覆盖前面的元信息）。 */
export function mergeMissingAssets(...lists: (readonly MissingAsset[] | undefined)[]): MissingAsset[] {
  const byUrl = new Map<string, MissingAsset>()
  for (const list of lists) {
    for (const item of list ?? []) {
      if (!item?.url) continue
      byUrl.set(item.url, { ...byUrl.get(item.url), ...item })
    }
  }
  return [...byUrl.values()]
}

/** 工程里有多少条片段（主轨 / 叠加 / 音频 / 链接到该素材的字幕）引用这个 url。 */
export function countClipReferences(project: Project, url: string): number {
  let count = 0
  for (const clip of project.clips) if (clip.sourceUrl === url) count += 1
  for (const track of project.overlayTracks ?? []) {
    for (const clip of track.clips) if (clip.sourceUrl === url) count += 1
  }
  for (const track of project.audioTracks ?? []) {
    for (const clip of track.clips) if (clip.sourceUrl === url) count += 1
  }
  for (const track of project.textTracks ?? []) {
    for (const clip of track.clips) if (clip.link?.sourceUrl === url) count += 1
  }
  return count
}

/**
 * 把一次文件选择的文件按文件名分配到待选素材。
 *
 * 规则（与对话框提示一致）：
 * 1. 文件名去扩展名后不区分大小写匹配；
 * 2. 同名素材按顺序分配；
 * 3. 只选了 1 个文件、且该行仍待选时，即使名字不同也绑定到该行（重命名场景）；
 * 4. 匹配不上的文件原样返回，由调用方提示「已忽略」。
 */
export function matchPickedFiles(
  pendingItems: readonly Pick<DraftAsset, 'id' | 'name'>[],
  files: readonly File[],
  targetId?: string,
): { assignments: Map<string, File>; unmatched: File[] } {
  const assignments = new Map<string, File>()
  const assigned = new Set<string>()
  const idsByName = new Map<string, string[]>()
  for (const item of pendingItems) {
    const key = normalizeAssetName(item.name)
    const queue = idsByName.get(key) ?? []
    queue.push(item.id)
    idsByName.set(key, queue)
  }
  const unmatched: File[] = []
  const targetPending = pendingItems.some((item) => item.id === targetId)
  for (const file of files) {
    const queue = idsByName.get(normalizeAssetName(file.name)) ?? []
    const next = queue.find((id) => !assigned.has(id))
    if (next) {
      assignments.set(next, file)
      assigned.add(next)
      continue
    }
    // 唯一文件 + 明确的目标行：允许文件名不一致（用户手动选的这一行）。
    if (files.length === 1 && targetId && targetPending && !assigned.has(targetId)) {
      assignments.set(targetId, file)
      assigned.add(targetId)
      continue
    }
    unmatched.push(file)
  }
  return { assignments, unmatched }
}

export function emptyMissingAssetsSelection(): MissingAssetsSelection {
  return { picked: new Map(), skipped: new Set() }
}

/** 标记为跳过（同时清掉这一项已选的文件）。取消选择框也走这里。 */
export function skipMissingAsset(
  selection: MissingAssetsSelection,
  id: string,
): MissingAssetsSelection {
  const picked = new Map(selection.picked)
  picked.delete(id)
  const skipped = new Set(selection.skipped)
  skipped.add(id)
  return { picked, skipped }
}

/** 一次把所有待选素材标记为跳过。 */
export function skipAllMissingAssets(
  selection: MissingAssetsSelection,
  ids: readonly string[],
): MissingAssetsSelection {
  const picked = new Map(selection.picked)
  const skipped = new Set(selection.skipped)
  for (const id of ids) {
    picked.delete(id)
    skipped.add(id)
  }
  return { picked, skipped }
}

/** 取消跳过（用户改主意重新选文件时调用）。 */
export function unskipMissingAsset(
  selection: MissingAssetsSelection,
  id: string,
): MissingAssetsSelection {
  if (!selection.skipped.has(id)) return selection
  const skipped = new Set(selection.skipped)
  skipped.delete(id)
  return { picked: selection.picked, skipped }
}

/** 把文件选择结果写入状态（自动匹配到所有待选素材）。 */
export function assignPickedFiles(
  selection: MissingAssetsSelection,
  pendingItems: readonly Pick<DraftAsset, 'id' | 'name'>[],
  files: readonly File[],
  targetId?: string,
): { selection: MissingAssetsSelection; unmatched: File[] } {
  const { assignments, unmatched } = matchPickedFiles(pendingItems, files, targetId)
  if (assignments.size === 0) return { selection, unmatched }
  const picked = new Map(selection.picked)
  const skipped = new Set(selection.skipped)
  for (const [id, file] of assignments) {
    picked.set(id, file)
    skipped.delete(id)
  }
  return { selection: { picked, skipped }, unmatched }
}

/**
 * 处理一次「选择文件」的结果（对话框接线用）：
 * - 取消 + 指定了某一行 → 把该素材标记为跳过（这就是「取消不再挂起、按跳过处理」）；
 * - 取消 + 一次多选 → 状态不变；
 * - 选到文件 → 自动匹配，返回未匹配的文件列表。
 * 返回值里的 `selection` 与入参相同表示「没有变化」（调用方可以跳过状态更新）。
 */
export function applyPickOutcome(
  selection: MissingAssetsSelection,
  pendingItems: readonly Pick<DraftAsset, 'id' | 'name'>[],
  outcome: { files: readonly File[]; cancelled: boolean },
  targetId?: string,
): { selection: MissingAssetsSelection; unmatched: File[] } {
  if (outcome.cancelled) {
    if (!targetId) return { selection, unmatched: [] }
    return { selection: skipMissingAsset(selection, targetId), unmatched: [] }
  }
  if (outcome.files.length === 0) return { selection, unmatched: [] }
  return assignPickedFiles(selection, pendingItems, outcome.files, targetId)
}

/** 选择进度（对话框底部「还差 N 个」用）。 */
export function missingSelectionSummary(
  items: readonly Pick<DraftAsset, 'id'>[],
  selection: MissingAssetsSelection,
): { picked: number; skipped: number; pending: number } {
  let picked = 0
  let skipped = 0
  for (const item of items) {
    if (selection.picked.has(item.id)) picked += 1
    else if (selection.skipped.has(item.id)) skipped += 1
  }
  return { picked, skipped, pending: items.length - picked - skipped }
}

/** 仍未决定（既没选文件也没跳过）的素材。 */
export function pendingMissingAssets<T extends Pick<DraftAsset, 'id'>>(
  items: readonly T[],
  selection: MissingAssetsSelection,
): T[] {
  return items.filter((item) => !selection.picked.has(item.id) && !selection.skipped.has(item.id))
}

/** 把没选到文件的素材换算成占位元信息（打开工程时写入 missingAssets）。 */
export function missingAssetsForUnpicked(
  items: readonly DraftAsset[],
  selection: MissingAssetsSelection,
): MissingAsset[] {
  return items
    .filter((item) => !selection.picked.has(item.id))
    .map(missingAssetFromDraft)
}

/** 只保留工程里仍然引用到的缺失素材（避免占位列表越滚越大）。 */
export function filterReferencedMissingAssets(
  missing: readonly MissingAsset[],
  project: Project,
): MissingAsset[] {
  return mergeMissingAssets(missing).filter((item) => countClipReferences(project, item.url) > 0)
}