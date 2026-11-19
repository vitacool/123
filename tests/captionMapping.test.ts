import { describe, expect, it } from 'vitest'
import {
  createClip,
  createEmptyProject,
  createInitialProject,
  splitProjectAt,
  trimProjectRight,
} from '../src/editor/core/operations'
import { mapWordsToTimeline, type TimelineWord } from '../src/editor/core/captionMapping'
import type { AsrWord } from '../src/editor/core/asr'
import type { AudioTrack, Clip, OverlayTrack, Project } from '../src/editor/core/types'

function word(text: string, start: number, end: number): AsrWord {
  return { text, start, end }
}

function ids(words: TimelineWord[]): string[] {
  return words.map((item) => item.text)
}

function videoClip(sourceUrl: string, start: number, end: number, overrides: Partial<Clip> = {}): Clip {
  return createClip(sourceUrl, start, end, overrides)
}

function projectWithClips(clips: Clip[]): Project {
  return { ...createEmptyProject(), clips }
}

describe('mapWordsToTimeline — main track', () => {
  it('maps a split clip into the correct timeline halves', () => {
    const split = splitProjectAt(
      createInitialProject({ url: 'src-a', duration: 8 }, 'clip-a'),
      'clip-a',
      4,
      'clip-b',
    )!
    const mapped = mapWordsToTimeline(split, {
      'src-a': [word('一', 0.5, 1), word('二', 6, 7)],
    })
    expect(ids(mapped)).toEqual(['一', '二'])
    expect(mapped[0]).toMatchObject({ start: 0.5, end: 1, source: { clipId: 'clip-a', trackKind: 'main' } })
    expect(mapped[1]).toMatchObject({ start: 6, end: 7, source: { clipId: 'clip-b', trackKind: 'main' } })
  })

  it('drops words whose midpoint falls outside a trimmed range', () => {
    const trimmed = trimProjectRight(
      createInitialProject({ url: 'src-a', duration: 10 }, 'clip-a'),
      'clip-a',
      8,
    )!
    const mapped = mapWordsToTimeline(trimmed, {
      'src-a': [word('内在', 0.5, 1), word('外', 9, 10)],
    })
    expect(ids(mapped)).toEqual(['内在'])
  })

  it('honours gapBefore when shifting words onto the timeline', () => {
    const project = projectWithClips([
      videoClip('src-a', 0, 4, { id: 'clip-a', gapBefore: 2 }),
    ])
    const mapped = mapWordsToTimeline(project, {
      'src-a': [word('开头', 0.5, 1)],
    })
    expect(mapped[0]).toMatchObject({ start: 2.5, end: 3 })
  })

  it('reorders words when clips are reordered', () => {
    const forward = projectWithClips([
      videoClip('src-a', 0, 4, { id: 'a' }),
      videoClip('src-b', 0, 4, { id: 'b' }),
    ])
    const backward = projectWithClips([
      videoClip('src-b', 0, 4, { id: 'b' }),
      videoClip('src-a', 0, 4, { id: 'a' }),
    ])
    const words = {
      'src-a': [word('甲', 0.5, 1)],
      'src-b': [word('乙', 0.5, 1)],
    }
    expect(ids(mapWordsToTimeline(forward, words))).toEqual(['甲', '乙'])
    expect(ids(mapWordsToTimeline(backward, words))).toEqual(['乙', '甲'])
  })

  it('skips freeze clips', () => {
    const project = projectWithClips([
      videoClip('src-a', 0, 3, { id: 'head' }),
      videoClip('src-a', 3, 5, { id: 'freeze', type: 'freeze' }),
      videoClip('src-a', 5, 8, { id: 'tail' }),
    ])
    const mapped = mapWordsToTimeline(project, {
      'src-a': [word('头', 1, 2), word('定格', 4, 5), word('尾', 6, 7)],
    })
    expect(ids(mapped)).toEqual(['头', '尾'])
    expect(mapped.every((item) => item.source.clipId !== 'freeze')).toBe(true)
  })

  it('maps several sources to their own clips and ignores unused sources', () => {
    const project = projectWithClips([
      videoClip('src-a', 0, 4, { id: 'a' }),
      videoClip('src-b', 0, 4, { id: 'b' }),
    ])
    const mapped = mapWordsToTimeline(project, {
      'src-a': [word('A', 1, 2)],
      'src-b': [word('B', 1, 2)],
      'src-c': [word('C', 1, 2)],
    })
    expect(ids(mapped)).toEqual(['A', 'B'])
    expect(mapped[0].source.sourceUrl).toBe('src-a')
    expect(mapped[1].source.sourceUrl).toBe('src-b')
  })
})

describe('mapWordsToTimeline — overlay and audio tracks', () => {
  it('maps overlay clips with trackKind overlay', () => {
    const overlay: OverlayTrack = {
      id: 'ov',
      name: '叠加轨',
      muted: false,
      hidden: false,
      clips: [videoClip('src-o', 0, 2, { id: 'ovc' })],
    }
    const project: Project = { ...createEmptyProject(), overlayTracks: [overlay] }
    const mapped = mapWordsToTimeline(
      project,
      {
        'src-o': [word('画中画', 0.5, 1)],
      },
      { includeOverlay: true },
    )
    expect(mapped[0]).toMatchObject({
      start: 0.5,
      source: { sourceUrl: 'src-o', clipId: 'ovc', trackKind: 'overlay' },
    })
  })

  it('maps audio-track clips using start / sourceStart', () => {
    const audio: AudioTrack = {
      id: 'at',
      name: '配音轨',
      muted: false,
      hidden: false,
      volume: 1,
      clips: [
        { id: 'ac', sourceUrl: 'src-a', sourceStart: 2, sourceEnd: 5, start: 10, volume: 1, fadeIn: 0, fadeOut: 0 },
      ],
    }
    const project: Project = { ...createEmptyProject(), audioTracks: [audio] }
    const mapped = mapWordsToTimeline(project, {
      'src-a': [word('旁白', 3, 4), word('范围外', 0.5, 1)],
    })
    expect(ids(mapped)).toEqual(['旁白'])
    // timeline = clip.start + (source - sourceStart) = 10 + (3 - 2) = 11
    expect(mapped[0]).toMatchObject({
      start: 11,
      end: 12,
      source: { clipId: 'ac', trackKind: 'audio' },
    })
  })
})