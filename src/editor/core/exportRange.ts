/**
 * 导出区间（入点 / 出点）：只在最终合成后的视频 / 音频流上裁一段，
 * 不修改任何片段，因此转场、叠加轨、字幕层的相对位置都天然正确。
 */

/** 时间轴上的导出区间，单位为秒。 */
export interface ExportRange {
  start: number
  end: number
}

/** 区间长度小于该值视为无效（0.1 秒）。 */
export const EXPORT_RANGE_MIN_DURATION = 0.1

/** 区间时长（秒）；非有限值或负长度按 0 处理，保留 4 位小数与 FFmpeg 参数一致。 */
export function exportRangeDuration(range: ExportRange): number {
  const length = range.end - range.start
  if (!Number.isFinite(length) || length <= 0) return 0
  return Math.round(length * 10000) / 10000
}

/**
 * 把区间夹到 `[0, duration]`：
 * - 旧草稿没有这个字段（null / undefined）→ null（导出全部）；
 * - 工程变短后越界 → 夹回有效范围；
 * - 夹取后长度不足 0.1 秒 → null（视为未设置）；
 * - 已经落在有效范围内时保持对象引用不变。
 */
export function clampExportRange(
  range: ExportRange | null | undefined,
  duration: number,
): ExportRange | null {
  if (!range) return null
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) return null
  const total = Number.isFinite(duration) ? Math.max(0, duration) : 0
  const start = Math.min(Math.max(range.start, 0), total)
  const end = Math.min(Math.max(range.end, 0), total)
  if (end - start + 1e-9 < EXPORT_RANGE_MIN_DURATION) return null
  if (start === range.start && end === range.end) return range
  return { start, end }
}