import { describe, expect, it } from 'vitest'
import {
  addTextClipToProject,
  addTextTrackToProject,
  captionFontSize,
  cueToCaptionClip,
  cueToTextClip,
  findTextClipLocation,
  getTextActionAvailability,
  moveTextClipInProject,
  parseSubtitleText,
  resizeTextClipInProject,
  splitTextClipInProject,
  textProjectEnd,
} from '../src/editor/core/text'
import { getProjectEnd } from '../src/editor/core/timeline'
import { createInitialProject } from '../src/editor/core/operations'

function projectWithText() {
  const base = createInitialProject({ url: 'blob:video', duration: 10 }, 'clip-a')
  const withTrack = addTextTrackToProject(base, 'text-track')
  return addTextClipToProject(withTrack, 'text-track', {
    id: 'text-a',
    text: 'Hello',
    start: 1,
    end: 5,
    x: 0.5,
    y: 0.82,
    fontSize: 0.06,
    color: '#ffffff',
    background: 'rgba(0, 0, 0, 0.55)',
    align: 'center',
    bold: true,
  })!
}

describe('subtitle parsing', () => {
  it('parses SRT with BOM, commas and inline tags', () => {
    const srt = '\uFEFF1\n00:00:01,000 --> 00:00:03,500\n<b>第一行</b>\n第二行\n\n2\n00:00:04,000 --> 00:00:06,000\nHello'
    const cues = parseSubtitleText(srt)
    expect(cues).toHaveLength(2)
    expect(cues[0].start).toBe(1)
    expect(cues[0].end).toBe(3.5)
    expect(cues[0].text).toBe('第一行\n第二行')
    expect(cues[1].start).toBe(4)
  })

  it('parses WebVTT with dot milliseconds and cue ids', () => {
    const vtt = 'WEBVTT\n\ncue-1\n00:00:02.250 --> 00:00:04.000\n字幕'
    const cues = parseSubtitleText(vtt)
    expect(cues).toHaveLength(1)
    expect(cues[0].start).toBe(2.25)
    expect(cues[0].text).toBe('字幕')
  })

  it('converts cues to styled clips', () => {
    const clip = cueToTextClip({ start: 1, end: 2, text: 'Hi' }, 'id')
    expect(clip.start).toBe(1)
    expect(clip.end).toBe(2)
    expect(clip.y).toBe(0.86)
    expect(clip.align).toBe('center')
  })

  it('builds smart captions in the JianYing default style', () => {
    const clip = cueToCaptionClip({ start: 1, end: 2, text: 'Hi' }, 'id', '9:16')
    expect(clip.bold).toBe(false)
    expect(clip.color).toBe('#ffffff')
    expect(clip.background).toBe('transparent')
    expect(clip.strokeColor).toBe('#000000')
    expect(clip.strokeWidth).toBeGreaterThan(0)
    expect(clip.y).toBe(0.86)
    expect(clip.align).toBe('center')
  })

  it('uses a smaller caption font for portrait aspect ratios', () => {
    expect(captionFontSize('9:16')).toBeLessThan(captionFontSize('16:9'))
    expect(captionFontSize('3:4')).toBeLessThan(captionFontSize('16:9'))
  })
})

describe('text clip editing', () => {
  it('adds, moves, trims and splits text clips', () => {
    const project = projectWithText()
    expect(findTextClipLocation(project, 'text-a')?.track.id).toBe('text-track')
    expect(textProjectEnd(project)).toBe(5)
    expect(getProjectEnd(project)).toBe(10)

    const moved = moveTextClipInProject(project, 'text-track', 'text-a', 2)!
    expect(moved.textTracks![0].clips[0].start).toBe(2)
    expect(moved.textTracks![0].clips[0].end).toBe(6)

    const trimmed = resizeTextClipInProject(moved, 'text-track', 'text-a', 'right', -1)!
    expect(trimmed.textTracks![0].clips[0].end).toBe(5)

    expect(getTextActionAvailability(project, 'text-a', 3).canSplit).toBe(true)
    expect(getTextActionAvailability(project, 'text-a', 1).canSplit).toBe(false)
    const split = splitTextClipInProject(project, 'text-track', 'text-a', 3, 'text-b')!
    const [left, right] = split.textTracks![0].clips
    expect(left.end).toBe(3)
    expect(right.start).toBe(3)
    expect(right.text).toBe('Hello')
  })
})