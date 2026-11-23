import type { Project } from './types'
import { findSegmentAt, getTimeline } from './timeline'
import { audioClipDuration } from './audio'
import { textClipDuration } from './text'
/**
 * 多选与批量操作的纯逻辑：选择集合运算、区间/框选、批量移动的偏移规划。
 * 不依赖 React 与 store，便于单测。
 */

/** 去重并保持首次出现的顺序。 */
export function normalizeSelection(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const id of ids) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}

/** Ctrl/⌘ 点击：已在集合中则移除，否则追加。 */
export function toggleSelection(ids: readonly string[], id: string): string[] {
  const current = normalizeSelection(ids)
  if (current.includes(id)) return current.filter((item) => item !== id)
  return [...current, id]
}

/**
 * Shift 点击：以锚点（主选中）为起点，按有序列表做闭区间选择。
 * 锚点缺失或不在列表里时，退化为只选目标项。
 */
export function rangeSelection(
  orderedIds: readonly string[],
  anchorId: string | null,
  targetId: string,
): string[] {
  const from = anchorId ? orderedIds.indexOf(anchorId) : -1
  const to = orderedIds.indexOf(targetId)
  if (to < 0) return [targetId]
  if (from < 0) return [targetId]
  const [start, end] = from <= to ? [from, to] : [to, from]
  return normalizeSelection(orderedIds.slice(start, end + 1))
}

/** 派生的“主选中”：优先 preferred，其次集合第一项；空集合为 null。 */
export function primaryOf(ids: readonly string[], preferred?: string | null): string | null {
  if (preferred && ids.includes(preferred)) return preferred
  return ids.length > 0 ? ids[0] : null
}

/** 时间轴上的可框选条目。 */
export interface SelectableSpan {
  id: string
  /** 轨道标识（主轨可用固定串），不同轨道的条目一起框选时按时间区间匹配。 */
  trackId: string
  start: number
  end: number
}

export interface SelectRect {
  start: number
  end: number
  /** 参与框选的轨道集合；为空表示所有轨道。 */
  trackIds?: readonly string[]
}

/** 框选：返回与时间矩形有交集的条目 id（保持输入顺序）。 */
export function idsInRect(
  spans: readonly SelectableSpan[],
  rect: SelectRect,
): string[] {
  const from = Math.min(rect.start, rect.end)
  const to = Math.max(rect.start, rect.end)
  const tracks = rect.trackIds && rect.trackIds.length > 0 ? new Set(rect.trackIds) : null
  const ids: string[] = []
  for (const span of spans) {
    if (tracks && !tracks.has(span.trackId)) continue
    // 半开区间相交：[max(start), min(end)) 非空。
    if (Math.max(span.start, from) < Math.min(span.end, to)) ids.push(span.id)
  }
  return ids
}

/** 批量拖动的一项。 */
export interface MoveSpanItem {
  id: string
  start: number
  duration: number
}

export interface PlannedMove {
  id: string
  /** 相对原位置的偏移（秒，已按 0 边界整体收敛）。 */
  delta: number
}

/**
 * 批量拖动：整体平移 delta，保持相对位置；任何一项越过 0 时统一收敛，
 * 保证相对距离不变。
 */
export function planBatchMove(
  items: readonly MoveSpanItem[],
  delta: number,
  trackStart = 0,
): PlannedMove[] {
  if (items.length === 0) return []
  const minStart = Math.min(...items.map((item) => item.start))
  const actualDelta = Math.max(delta, trackStart - minStart)
  return items.map((item) => ({ id: item.id, delta: actualDelta }))
}

/**
 * 顺序轨（主轨/叠加轨）里选中项形成的连续段起点 id。
 * 移动这些「段头」的 gapBefore 即可整体平移整个段（段内片段是顺序相接的）。
 */
export function contiguousRunHeads(
  orderedIds: readonly string[],
  selectedIds: readonly string[],
): string[] {
  const selected = new Set(selectedIds)
  const heads: string[] = []
  orderedIds.forEach((id, index) => {
    if (!selected.has(id)) return
    const previous = orderedIds[index - 1]
    if (index === 0 || !previous || !selected.has(previous)) heads.push(id)
  })
  return heads
}
/** 可被选中的片段 id（主轨 / 叠加轨 / 音频轨 / 字幕轨，按显示顺序）。 */
export function selectableOrder(project: Project): string[] {
  const ids: string[] = []
  for (const segment of getTimeline(project.clips)) ids.push(segment.clip.id)
  for (const track of project.overlayTracks ?? []) {
    for (const segment of getTimeline(track.clips)) ids.push(segment.clip.id)
  }
  for (const track of project.audioTracks ?? []) {
    for (const clip of track.clips) ids.push(clip.id)
  }
  for (const track of project.textTracks ?? []) {
    for (const clip of track.clips) ids.push(clip.id)
  }
  return ids
}

/**
 * 撤销/重做后「该选中谁」的兜底：先取播放头所在位置的片段，再退到第一个可选项。
 *
 * 为什么需要：分割 / 插入定格 / 粘贴 这类命令声明的 `selectionAfter` 是**新生成的 id**，
 * 撤销回到旧快照后它必然不存在。此时若沿用「当前选中」或直接清空，用户会看到
 * 「片段没高亮 → Delete / 分割 / 裁剪全部静默失效」，而没有任何提示。
 *
 * 这里刻意只做「就近选择」而不改工程数据：选区是会话态，撤销后重新定位到播放头
 * 所在片段，最符合用户「我刚在剪这里」的心智。
 */
export function selectionFallbackId(project: Project, time: number): string | null {
  const base = findSegmentAt(project.clips, time)
  if (base) return base.clip.id
  for (const track of project.overlayTracks ?? []) {
    const segment = findSegmentAt(track.clips, time)
    if (segment) return segment.clip.id
  }
  // 音频/字幕不是顺序轨：用各自的时间区间判断（与时间轴上画的位置一致）。
  for (const track of project.audioTracks ?? []) {
    for (const clip of track.clips) {
      if (time >= clip.start && time < clip.start + audioClipDuration(clip)) return clip.id
    }
  }
  for (const track of project.textTracks ?? []) {
    for (const clip of track.clips) {
      if (time >= clip.start && time < clip.start + textClipDuration(clip)) return clip.id
    }
  }
  return selectableOrder(project)[0] ?? null
}
