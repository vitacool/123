import { describe, expect, it } from 'vitest'
import { buildCaptionsFromWords } from '../src/editor/core/captions'
import { relinkCaptions } from '../src/editor/core/captionLink'
import {
  addTextClipToProject,
  addTextTrackToProject,
  resizeTextClipInProject,
  splitTextClipInProject,
  trimTextClipAt,
} from '../src/editor/core/text'
import { createInitialProject, splitProjectAt } from '../src/editor/core/operations'
import type { TimelineWord } from '../src/editor/core/captionMapping'
import type { Project, TextClip } from '../src/editor/core/types'

function clip(overrides: Partial<TextClip> = {}): TextClip {
  return {
    id: 'cap1',
    text: '你好',
    start: 1,
    end: 1.9,
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

function linkProject(
  linkOverrides: Partial<NonNullable<TextClip['link']>> = {},
  clipStart = 1,
  clipEnd = 1.9,
): Project {
  let project = createInitialProject({ url: 'src-a', duration: 10 }, 'clip-a')
  project = addTextTrackToProject(project, 'cap', 'caption')
  project = addTextClipToProject(
    project,
    'cap',
    clip({
      id: 'cap1',
      start: clipStart,
      end: clipEnd,
      link: {
        clipId: 'clip-a',
        assetId: 'asset-a',
        sourceUrl: 'src-a',
        sourceStart: 1,
        sourceEnd: 1.8,
        padStart: 0,
        padEnd: 0.1,
        ...linkOverrides,
      },
    }),
  )!
  return project
}

function captions(project: Project): TextClip[] {
  return (project.textTracks ?? []).flatMap((track) => track.clips)
}

const assetMap = new Map<string, string>([['src-a', 'asset-a']])

describe('修复 A：字幕联动数据安全', () => {
  it('【1】URL 重映射（刷新）后字幕按 assetId 匹配，数量与时间不变', () => {
    const project = linkProject()
    // 模拟刷新：clip 的 sourceUrl 变新 blob，但 assetId 稳定。
    project.clips[0] = { ...project.clips[0], sourceUrl: 'new-blob-url' }
    const newAssetMap = new Map<string, string>([['new-blob-url', 'asset-a']])
    const relinked = relinkCaptions(project, newAssetMap)
    expect(captions(relinked)).toHaveLength(1)
    expect(captions(relinked)[0].start).toBe(1)
    expect(captions(relinked)[0].end).toBeCloseTo(1.9, 5)
  })

  it('【2】无关命令后（无变化）字幕 start/end 不变，保留 pad', () => {
    const project = linkProject({ sourceStart: 1, sourceEnd: 1.5, padEnd: 0.4 }, 1, 1.9)
    const relinked = relinkCaptions(project, assetMap)
    expect(captions(relinked)[0]).toMatchObject({ start: 1, end: 1.9 })
  })

  it('【3】resize/trim/split 改时间会去掉 link', () => {
    const base = linkProject()
    const resized = resizeTextClipInProject(base, 'cap', 'cap1', 'right', -0.3)!
    expect(captions(resized)[0].link).toBeUndefined()

    const trimmed = trimTextClipAt(base, 'cap', 'cap1', 1.5, 'right')!
    expect(captions(trimmed)[0].link).toBeUndefined()

    const withWords = linkProject()
    withWords.textTracks![0].clips[0] = {
      ...withWords.textTracks![0].clips[0],
      words: [
        { text: '你', start: 1, end: 1.4 },
        { text: '好', start: 1.4, end: 1.8 },
      ],
    }
    const split = splitTextClipInProject(withWords, 'cap', 'cap1', 1.4, 'cap2')!
    const [left, right] = captions(split)
    expect(left.link).toBeUndefined()
    expect(right.link).toBeUndefined()
    expect(left.words?.map((w) => w.text)).toEqual(['你'])
    expect(right.words?.map((w) => w.text)).toEqual(['好'])
  })

  it('【4】relink 后字幕重新排序', () => {
    const project = linkProject()
    const track = project.textTracks![0]
    // 造乱序
    track.clips = [
      { ...track.clips[0], id: 'cap2', start: 9, end: 10, text: 'B' },
      track.clips[0],
    ]
    const relinked = relinkCaptions(project, assetMap)
    const starts = captions(relinked).map((c) => c.start)
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
  })

  it('【5】分割：sourceStart 落右段，clipId 更新到右段', () => {
    const project = linkProject({ sourceStart: 6, sourceEnd: 6.8 }, 6, 6.9)
    const split = splitProjectAt(project, 'clip-a', 5, 'clip-b')!
    const relinked = relinkCaptions(split, assetMap)
    expect(captions(relinked)[0].link?.clipId).toBe('clip-b')
  })

  it('【6】裁剪到交集为空时标记 linkHidden，拉回后恢复（不删除）', () => {
    const project = linkProject()
    project.clips[0] = { ...project.clips[0], sourceEnd: 0.5 }
    const hidden = relinkCaptions(project, assetMap)
    expect(captions(hidden)).toHaveLength(1)
    expect(captions(hidden)[0].link?.linkHidden).toBe(true)

    project.clips[0] = { ...project.clips[0], sourceEnd: 10 }
    const restored = relinkCaptions({ ...project, textTracks: hidden.textTracks }, assetMap)
    expect(captions(restored)[0].link?.linkHidden).toBe(false)
    expect(captions(restored)[0].start).toBe(1)
    expect(captions(restored)[0].end).toBeCloseTo(1.9, 5)
  })

  it('【7】断句：相邻词 source.clipId 不同时强制断句', () => {
    const words: TimelineWord[] = [
      {
        text: '第一句',
        start: 0,
        end: 1,
        sourceStart: 0,
        sourceEnd: 1,
        source: { sourceUrl: 'src-a', clipId: 'clip-a', trackKind: 'main' },
      },
      {
        text: '第二句',
        start: 1.1,
        end: 2,
        sourceStart: 0.1,
        sourceEnd: 1,
        source: { sourceUrl: 'src-a', clipId: 'clip-b', trackKind: 'main' },
      },
    ]
    const cues = buildCaptionsFromWords(words, { aspectRatio: '16:9' })
    expect(cues).toHaveLength(2)
    expect(cues[0].text).toBe('第一句')
    expect(cues[1].text).toBe('第二句')
  })
})