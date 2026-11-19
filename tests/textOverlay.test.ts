import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '../src/editor/core/operations'
import {
  buildTextOverlayTimeline,
  type TextOverlayInterval,
} from '../src/editor/core/textOverlay'
import type { Project, TextClip, TextTrack } from '../src/editor/core/types'

function textClip(id: string, start: number, end: number): TextClip {
  return {
    id,
    text: id,
    start,
    end,
    x: 0.5,
    y: 0.86,
    fontSize: 0.05,
    color: '#ffffff',
    background: 'transparent',
    align: 'center',
    bold: false,
  }
}

function textTrack(
  id: string,
  clips: TextClip[],
  overrides: Partial<TextTrack> = {},
): TextTrack {
  return { id, name: id, muted: false, hidden: false, clips, ...overrides }
}

function projectWith(...tracks: TextTrack[]): Project {
  return { ...createEmptyProject(), textTracks: tracks }
}

function shape(intervals: TextOverlayInterval[]): [number, number, string[]][] {
  return intervals.map((interval) => [
    interval.start,
    interval.end,
    interval.clips.map((clip) => clip.id),
  ])
}

describe('buildTextOverlayTimeline', () => {
  it('merges overlapping clips into shared intervals', () => {
    const project = projectWith(
      textTrack('t1', [textClip('a', 1, 4)]),
      textTrack('t2', [textClip('b', 3, 6)]),
    )
    expect(shape(buildTextOverlayTimeline(project))).toEqual([
      [0, 1, []],
      [1, 3, ['a']],
      [3, 4, ['a', 'b']],
      [4, 6, ['b']],
    ])
  })

  it('keeps adjacent clips as separate intervals', () => {
    const project = projectWith(
      textTrack('t1', [textClip('a', 0, 2), textClip('b', 2, 4)]),
    )
    expect(shape(buildTextOverlayTimeline(project))).toEqual([
      [0, 2, ['a']],
      [2, 4, ['b']],
    ])
  })

  it('fills gaps with empty intervals up to the requested duration', () => {
    const project = projectWith(textTrack('t1', [textClip('a', 2, 3), textClip('b', 5, 6)]))
    expect(shape(buildTextOverlayTimeline(project, { duration: 8 }))).toEqual([
      [0, 2, []],
      [2, 3, ['a']],
      [3, 5, []],
      [5, 6, ['b']],
      [6, 8, []],
    ])
  })

  it('ignores clips on hidden or disabled tracks', () => {
    const project = projectWith(
      textTrack('visible', [textClip('a', 0, 2)]),
      textTrack('hidden', [textClip('b', 0, 5)], { hidden: true }),
      textTrack('disabled', [textClip('c', 0, 5)], { enabled: false }),
    )
    expect(shape(buildTextOverlayTimeline(project))).toEqual([[0, 2, ['a']]])
  })

  it('returns an empty timeline when nothing is visible', () => {
    const hidden = projectWith(textTrack('hidden', [textClip('a', 0, 5)], { hidden: true }))
    expect(buildTextOverlayTimeline(hidden)).toEqual([])
    expect(buildTextOverlayTimeline(createEmptyProject(), { duration: 10 })).toEqual([])
  })

  it('skips zero-length clips and clips entirely past the duration bound', () => {
    const project = projectWith(
      textTrack('t1', [textClip('a', 2, 2), textClip('b', 3, 4), textClip('c', 9, 11)]),
    )
    expect(shape(buildTextOverlayTimeline(project, { duration: 6 }))).toEqual([
      [0, 3, []],
      [3, 4, ['b']],
      [4, 6, []],
    ])
  })

  it('handles 300 two-second captions with linear, time-accurate intervals', () => {
    const clips: TextClip[] = []
    for (let index = 0; index < 300; index += 1) {
      clips.push(textClip(`cap-${index}`, index * 2, index * 2 + 2))
    }
    const project = projectWith(textTrack('captions', clips))
    const intervals = buildTextOverlayTimeline(project, { duration: 600 })

    expect(intervals).toHaveLength(300)
    intervals.forEach((interval, index) => {
      expect(interval.start).toBe(index * 2)
      expect(interval.end).toBe(index * 2 + 2)
      // Adjacent captions never overlap, so every interval holds exactly one clip.
      expect(interval.clips.map((clip) => clip.id)).toEqual([`cap-${index}`])
    })
    expect(intervals[intervals.length - 1].end).toBe(600)
  })
})