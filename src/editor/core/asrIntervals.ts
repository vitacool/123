/** A half-open source-time range `[start, end)` of a media asset. */
export interface SourceSlice {
  start: number
  end: number
}

export interface MergeSourceIntervalsOptions {
  /** Merge two slices when the gap between them is at most this many seconds. */
  gapToleranceSeconds?: number
  /** Extra padding added to both ends of every merged interval. */
  padSeconds?: number
}

export const DEFAULT_GAP_TOLERANCE_SECONDS = 1
export const DEFAULT_PAD_SECONDS = 0.5

/**
 * Merges a list of source-time slices used by clips into a minimal set of
 * recognition intervals. Adjacent slices (gap ≤ tolerance) collapse into one,
 * and every interval is padded on both ends. The caller chooses which slices
 * to feed in (e.g. skipping freeze clips or disabled tracks).
 */
export function mergeSourceIntervals(
  slices: readonly SourceSlice[],
  options: MergeSourceIntervalsOptions = {},
): SourceSlice[] {
  const gapTolerance = options.gapToleranceSeconds ?? DEFAULT_GAP_TOLERANCE_SECONDS
  const pad = options.padSeconds ?? DEFAULT_PAD_SECONDS

  const valid = slices
    .filter(
      (slice) =>
        Number.isFinite(slice.start) && Number.isFinite(slice.end) && slice.end > slice.start,
    )
    .map((slice) => ({ start: slice.start, end: slice.end }))
    .sort((left, right) => left.start - right.start)

  const merged: SourceSlice[] = []
  for (const slice of valid) {
    const previous = merged[merged.length - 1]
    if (previous && slice.start <= previous.end + gapTolerance) {
      previous.end = Math.max(previous.end, slice.end)
    } else {
      merged.push({ start: slice.start, end: slice.end })
    }
  }

  return merged.map((slice) => ({
    start: Math.max(0, slice.start - pad),
    end: slice.end + pad,
  }))
}