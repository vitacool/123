import { describe, expect, it } from 'vitest'
import { splitCaptionText } from '../src/editor/core/captions'
import { relinkCaptions } from '../src/editor/core/captionLink'
import {
  serializeSrt,
  addTextClipToProject,
  addTextTrackToProject,
  mergeTextCaptionWithPrevious,
  moveTextClipInProject,
} from '../src/editor/core/text'
import { createInitialProject, splitProjectAt } from '../src/editor/core/operations'
import type { Project, TextClip } from '../src/editor/core/types'

function captionClip(overrides: Partial<TextClip> = {}): TextClip {
  return {
    id: 'cap1',
    text: '你好',
    start: 1,
    end: 1.8,
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

function linkedProject(sourceStart = 1, sourceEnd = 1.8): Project {
  let project = createInitialProject({ url: 'src-a', duration: 10 }, 'clip-a')
  project = addTextTrackToProject(project, 'cap', 'caption')
  project = addTextClipToProject(
    project,
    'cap',
    captionClip({
      start: sourceStart,
      end: sourceEnd,
      link: {
        clipId: 'clip-a',
        assetId: 'src-a',
        sourceUrl: 'src-a',
        sourceStart,
        sourceEnd,
        padStart: 0,
        padEnd: 0,
      },
    }),
  )!
  return project
}

function allCaptionClips(project: Project): TextClip[] {
  return (project.textTracks ?? []).flatMap((track) => track.clips)
}

describe('relinkCaptions（字幕跟随片段）', () => {
  it('片段移动：字幕跟着平移', () => {
    const project = linkedProject()
    project.clips[0] = { ...project.clips[0], gapBefore: 3 }
    const relinked = relinkCaptions(project)
    const caption = allCaptionClips(relinked)[0]
    expect(caption.start).toBe(4)
    expect(caption.end).toBe(4.8)
  })

  it('片段裁剪：字幕截短，完全裁掉则标记 linkHidden（不删除）', () => {
    const trimmed = linkedProject()
    trimmed.clips[0] = { ...trimmed.clips[0], sourceEnd: 1.5 }
    const relinked = relinkCaptions(trimmed)
    expect(allCaptionClips(relinked)[0]).toMatchObject({ start: 1, end: 1.5 })

    const hidden = linkedProject()
    hidden.clips[0] = { ...hidden.clips[0], sourceEnd: 0.5 }
    const after = relinkCaptions(hidden)
    expect(allCaptionClips(after)).toHaveLength(1)
    expect(allCaptionClips(after)[0].link?.linkHidden).toBe(true)
  })

  it('片段分割：字幕按 sourceStart 归到右段并更新 clipId', () => {
    const project = linkedProject(6, 6.8)
    const split = splitProjectAt(project, 'clip-a', 5, 'clip-b')!
    const relinked = relinkCaptions(split)
    const caption = allCaptionClips(relinked)[0]
    expect(caption.link?.clipId).toBe('clip-b')
    expect(caption.start).toBe(6)
    expect(caption.end).toBe(6.8)
  })

  it('片段删除：对应字幕一起删除', () => {
    const project = linkedProject()
    project.clips = []
    expect(allCaptionClips(relinkCaptions(project))).toEqual([])
  })

  it('手动拖动过时间的字幕去掉 link（转成普通字幕）', () => {
    const project = linkedProject()
    const moved = moveTextClipInProject(project, 'cap', 'cap1', 5)!
    expect(allCaptionClips(moved)[0].link).toBeUndefined()
  })
})

describe('splitCaptionText（Enter 拆句）', () => {
  it('有词级时间就按最近词边界切时间', () => {
    const clip = captionClip({
      text: '你好世界',
      start: 0,
      end: 2,
      words: [
        { text: '你好', start: 0, end: 1 },
        { text: '世界', start: 1, end: 2 },
      ],
    })
    const parts = splitCaptionText(clip, 2)
    expect(parts.leftText).toBe('你好')
    expect(parts.rightText).toBe('世界')
    expect(parts.leftStart).toBe(0)
    expect(parts.leftEnd).toBe(1)
    expect(parts.rightStart).toBe(1)
    expect(parts.rightEnd).toBe(2)
    expect(parts.leftWords?.map((word) => word.text)).toEqual(['你好'])
    expect(parts.rightWords?.map((word) => word.text)).toEqual(['世界'])
  })

  it('没有词级时间就按字数比例切', () => {
    const clip = captionClip({ text: '你好世界', start: 0, end: 2 })
    const parts = splitCaptionText(clip, 2)
    expect(parts.leftText).toBe('你好')
    expect(parts.rightText).toBe('世界')
    expect(parts.leftEnd).toBeCloseTo(1)
    expect(parts.rightStart).toBeCloseTo(1)
  })
})

describe('serializeSrt', () => {
  it('序列化为标准 SRT', () => {
    const srt = serializeSrt([
      { start: 1, end: 3.5, text: '第一行' },
      { start: 4, end: 6, text: 'Hello\n世界' },
    ])
    expect(srt).toContain('1\n00:00:01,000 --> 00:00:03,500\n第一行')
    expect(srt).toContain('2\n00:00:04,000 --> 00:00:06,000\nHello\n世界')
  })
})

describe('mergeTextCaptionWithPrevious', () => {
  function mergeProject(): Project {
    let project = createInitialProject({ url: 'src-a', duration: 10 }, 'clip-a')
    project = addTextTrackToProject(project, 'cap', 'caption')
    project = addTextClipToProject(
      project,
      'cap',
      { id: 'c1', text: '第一', start: 0, end: 1, x: 0.5, y: 0.86, fontSize: 0.05, color: '#fff', background: 'transparent', align: 'center', bold: false },
    )!
    project = addTextClipToProject(
      project,
      'cap',
      { id: 'c2', text: '第二', start: 1, end: 2, x: 0.5, y: 0.86, fontSize: 0.05, color: '#fff', background: 'transparent', align: 'center', bold: false, edited: true },
    )!
    return project
  }

  it('合并时继承 edited（任一条被手改过，合并结果仍标记为手改）', () => {
    const merged = mergeTextCaptionWithPrevious(mergeProject(), 'cap', 'c2')!
    const track = merged.textTracks!.find((t) => t.id === 'cap')!
    const clip = track.clips.find((c) => c.id === 'c1')!
    expect(clip.text).toBe('第一第二')
    expect(clip.edited).toBe(true)
  })
})