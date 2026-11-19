import { describe, expect, it } from 'vitest'
import { mergeRelinkedCaptions } from '../src/editor/core/captionLink'
import {
  mapWordsToTimeline,
  type WordsBySource,
} from '../src/editor/core/captionMapping'
import { createReplaceAutoCaptionsCommand } from '../src/editor/core/commands'
import { createInitialProject } from '../src/editor/core/operations'
import { addTextTrackToProject, addTextClipToProject } from '../src/editor/core/text'
import type { Project, TextClip } from '../src/editor/core/types'

function caption(overrides: Partial<TextClip> = {}): TextClip {
  return {
    id: 'c',
    text: '你好',
    start: 0,
    end: 1,
    x: 0.5,
    y: 0.86,
    fontSize: 0.055,
    color: '#ffffff',
    background: 'transparent',
    align: 'center',
    bold: false,
    strokeColor: '#000000',
    strokeWidth: 0.06,
    ...overrides,
  }
}

describe('修复 B', () => {
  it('【1】mergeRelinkedCaptions：手改过的文字按 clipId+重叠匹配保留，只更新时间和 link', () => {
    const oldClip = caption({
      id: 'old-1',
      text: '我改过的字',
      edited: true,
      start: 3,
      end: 4,
      link: { clipId: 'clip-a', assetId: 'a', sourceUrl: 'u', sourceStart: 3, sourceEnd: 3.9, padStart: 0, padEnd: 0.1 },
    })
    const newClip = caption({
      id: 'new-1',
      text: '识别出的新字',
      start: 8,
      end: 9,
      link: { clipId: 'clip-a', assetId: 'a', sourceUrl: 'u', sourceStart: 3, sourceEnd: 3.9, padStart: 0, padEnd: 0.1 },
    })
    const merged = mergeRelinkedCaptions([oldClip], [newClip])
    expect(merged[0].text).toBe('我改过的字')
    expect(merged[0].edited).toBe(true)
    expect(merged[0].start).toBe(8)
    expect(merged[0].end).toBe(9)
    expect(merged[0].link?.clipId).toBe('clip-a')
  })

  it('【1】createReplaceAutoCaptionsCommand 只替换目标轨，保留 id/name/样式/状态，其他轨不动', () => {
    let project: Project = createInitialProject({ url: 'u', duration: 10 }, 'clip-a')
    project = addTextTrackToProject(project, 'cap1', 'caption')
    project = {
      ...project,
      textTracks: (project.textTracks ?? []).map((t) =>
        t.id === 'cap1'
          ? { ...t, name: '我的字幕', captionStyle: { bold: true }, hidden: true }
          : t,
      ),
    }
    project = addTextClipToProject(project, 'cap1', caption({ id: 'old' }))!
    project = addTextTrackToProject(project, 'cap2', 'caption')
    project = addTextClipToProject(project, 'cap2', caption({ id: 'other' }))!

    const replaced = createReplaceAutoCaptionsCommand('cap1', [
      caption({ id: 'new-a', start: 1, end: 2 }),
    ]).execute(project)

    const track1 = replaced.textTracks!.find((t) => t.id === 'cap1')!
    const track2 = replaced.textTracks!.find((t) => t.id === 'cap2')!
    expect(track1.name).toBe('我的字幕')
    expect(track1.captionStyle).toEqual({ bold: true })
    expect(track1.hidden).toBe(true)
    expect(track1.clips.map((c) => c.id)).toEqual(['new-a'])
    expect(track2.clips.map((c) => c.id)).toEqual(['other'])
  })

  it('【4】mapWordsToTimeline：主轨静音/禁用时不映射主轨', () => {
    const project = createInitialProject({ url: 'u', duration: 10 }, 'clip-a')
    project.mainTrack = { enabled: true, locked: false, hidden: false, muted: true, solo: false }
    const words: WordsBySource = { u: [{ text: '词', start: 0.5, end: 1 }] }
    const mapped = mapWordsToTimeline(project, words, {
      includeMainAudio: false,
      includeOverlay: false,
      includeAudio: false,
    })
    expect(mapped).toEqual([])
  })

  it('【4】mapWordsToTimeline：includeOverlay / includeAudio 控制叠加轨与音频轨', () => {
    let project = createInitialProject({ url: 'u', duration: 10 }, 'clip-a')
    project.overlayTracks = [
      { id: 'ov', name: 'ov', muted: false, hidden: false, clips: [{ ...project.clips[0], id: 'ovc', sourceUrl: 'u' }] },
    ]
    project.audioTracks = [
      { id: 'at', name: 'at', muted: false, hidden: false, volume: 1, clips: [{ id: 'ac', sourceUrl: 'u', sourceStart: 0, sourceEnd: 2, start: 2, volume: 1, fadeIn: 0, fadeOut: 0 }] },
    ]
    const words: WordsBySource = { u: [{ text: '词', start: 0.5, end: 1 }] }
    const overlayOn = mapWordsToTimeline(project, words, { includeMainAudio: true, includeOverlay: true, includeAudio: false })
    const kinds = overlayOn.map((w) => w.source.trackKind)
    expect(kinds).toContain('overlay')

    const audioOn = mapWordsToTimeline(project, words, { includeMainAudio: true, includeOverlay: false, includeAudio: true })
    expect(audioOn.map((w) => w.source.trackKind)).toContain('audio')
  })

  it('【5】词的中点用半开区间 [start, end)，端点词被排除', () => {
    const project = createInitialProject({ url: 'u', duration: 10 }, 'clip-a')
    project.clips[0] = { ...project.clips[0], sourceStart: 0, sourceEnd: 2 }
    // 中点恰好等于 sourceEnd(=2) 的词应被排除（半开区间）。
    const words: WordsBySource = { u: [{ text: '界', start: 1.9, end: 2.1 }] }
    const mapped = mapWordsToTimeline(project, words, { includeMainAudio: true, includeOverlay: false, includeAudio: false })
    expect(mapped).toEqual([])
  })

  it('【5】映射后的词 time 被夹在该片段时间轴范围内', () => {
    const project = createInitialProject({ url: 'u', duration: 10 }, 'clip-a')
    project.clips[0] = { ...project.clips[0], sourceStart: 0, sourceEnd: 2 }
    // 词 end 超过片段 sourceEnd，映射后 end 被夹到片段时间轴 end。
    const words: WordsBySource = { u: [{ text: '尾', start: 0.5, end: 3 }] }
    const mapped = mapWordsToTimeline(project, words, { includeMainAudio: true, includeOverlay: false, includeAudio: false })
    expect(mapped[0].end).toBeLessThanOrEqual(2)
  })
})