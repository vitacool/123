import { describe, expect, it } from 'vitest'
import { mergeSourceIntervals } from '../src/editor/core/asrIntervals'

describe('mergeSourceIntervals', () => {
  it('merges overlapping slices', () => {
    expect(
      mergeSourceIntervals(
        [
          { start: 0, end: 5 },
          { start: 3, end: 8 },
        ],
        { gapToleranceSeconds: 1, padSeconds: 0 },
      ),
    ).toEqual([{ start: 0, end: 8 }])
  })

  it('merges slices within the gap tolerance and splits beyond it', () => {
    const merged = mergeSourceIntervals(
      [
        { start: 0, end: 2 },
        { start: 2.5, end: 4 },
      ],
      { gapToleranceSeconds: 1, padSeconds: 0 },
    )
    expect(merged).toEqual([{ start: 0, end: 4 }])

    const split = mergeSourceIntervals(
      [
        { start: 0, end: 2 },
        { start: 4, end: 6 },
      ],
      { gapToleranceSeconds: 1, padSeconds: 0 },
    )
    expect(split).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 6 },
    ])
  })

  it('pads every interval on both ends and clamps to zero', () => {
    expect(
      mergeSourceIntervals([{ start: 1, end: 3 }], {
        gapToleranceSeconds: 1,
        padSeconds: 0.5,
      }),
    ).toEqual([{ start: 0.5, end: 3.5 }])
  })

  it('sorts unsorted input and drops empty slices', () => {
    expect(
      mergeSourceIntervals(
        [
          { start: 5, end: 6 },
          { start: 0, end: 1 },
          { start: 2, end: 2 },
        ],
        { gapToleranceSeconds: 1, padSeconds: 0 },
      ),
    ).toEqual([
      { start: 0, end: 1 },
      { start: 5, end: 6 },
    ])
  })

  it('returns an empty list for empty input', () => {
    expect(mergeSourceIntervals([])).toEqual([])
  })
})