/** 时间轴可视时间窗口（秒）。overscan 让边缘片段提前渲染，滚动时不闪白。 */
export interface TimelineTimeWindow {
  start: number
  end: number
}

export function timelineWindow(
  scrollLeft: number,
  viewportWidth: number,
  pixelsPerSecond: number,
  pad: number,
  overscanPx = viewportWidth,
): TimelineTimeWindow {
  const pps = Number.isFinite(pixelsPerSecond) && pixelsPerSecond > 0 ? pixelsPerSecond : 1
  const scroll = Number.isFinite(scrollLeft) ? Math.max(0, scrollLeft) : 0
  const viewport = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 0
  const left = Number.isFinite(pad) ? pad : 0
  const overscan = Number.isFinite(overscanPx) ? Math.max(0, overscanPx) : 0
  const start = Math.max(0, (scroll - left - overscan) / pps)
  const end = Math.max(0, (scroll + viewport - left + overscan) / pps)
  return { start: Math.min(start, end), end: Math.max(start, end) }
}

/** 片段区间与窗口有交集（闭区间；贴边片段也会渲染，避免接缝闪断）。 */
export function isSegmentVisible(
  segment: { start: number; end: number },
  window: TimelineTimeWindow,
): boolean {
  return segment.end >= window.start && segment.start <= window.end
}