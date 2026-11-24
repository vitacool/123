import { describe, expect, it } from 'vitest'
import { createUpdateCaptionTrackStyleCommand } from '../src/editor/core/commands'
import { HistoryStack } from '../src/editor/core/history'
import { createEmptyProject } from '../src/editor/core/operations'
import {
  addTextClipToProject,
  addTextTrackToProject,
  captionStyleForTrack,
  deriveCaptionStyle,
  resolveCaptionStyle,
  updateCaptionClipStyleInProject,
  updateCaptionStyleInProject,
} from '../src/editor/core/text'
import type { CaptionStyle, Project, TextClip } from '../src/editor/core/types'

function clip(overrides: Partial<TextClip> = {}): TextClip {
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

function captionProject(): Project {
  let project = createEmptyProject()
  project = addTextTrackToProject(project, 'cap', 'caption')
  project = addTextClipToProject(project, 'cap', clip({ id: 'c1' }))!
  project = addTextClipToProject(project, 'cap', clip({ id: 'c2' }))!
  return project
}

describe('resolveCaptionStyle', () => {
  it('取值顺序：clip.styleOverride > track.captionStyle > clip 默认值', () => {
    const base = clip({ color: '#ffffff', fontSize: 0.055 })

    // 只有默认值
    expect(resolveCaptionStyle(base, undefined).color).toBe('#ffffff')

    // group 覆盖默认值
    const group: CaptionStyle = { color: '#ffd23f' }
    expect(resolveCaptionStyle(base, group).color).toBe('#ffd23f')

    // override 覆盖 group
    const override = clip({ color: '#ffffff', styleOverride: { color: '#ff0000' } })
    expect(resolveCaptionStyle(override, group).color).toBe('#ff0000')

    // 未覆盖的字段继续从 group / 默认值取
    expect(resolveCaptionStyle(base, { fontSize: 0.06 }).fontSize).toBe(0.06)
  })

  it('行距/字距/斜体同样按 override > group > clip 取值', () => {
    const base = clip({ lineHeight: 1.4, letterSpacing: 0.05, italic: true })
    expect(resolveCaptionStyle(base, undefined).lineHeight).toBe(1.4)
    expect(resolveCaptionStyle(base, undefined).letterSpacing).toBe(0.05)
    expect(resolveCaptionStyle(base, undefined).italic).toBe(true)
    // group 覆盖 clip
    expect(resolveCaptionStyle(base, { lineHeight: 1.8 }).lineHeight).toBe(1.8)
    // override 覆盖 group
    const override = clip({ styleOverride: { letterSpacing: 0.2, italic: false } })
    const resolved = resolveCaptionStyle(override, { letterSpacing: 0.1, italic: true })
    expect(resolved.letterSpacing).toBe(0.2)
    expect(resolved.italic).toBe(false)
  })
})

describe('caption track group style mutations', () => {
  it('updateCaptionStyleInProject 写入组样式并清空所有单条覆盖', () => {
    let project = captionProject()
    // 先给 c1 加一条单条覆盖
    project = updateCaptionClipStyleInProject(project, 'cap', 'c1', { color: '#ff0000' })!
    project = updateCaptionStyleInProject(project, 'cap', { color: '#ffd23f' })!

    const track = project.textTracks![0]
    expect(track.captionStyle).toEqual({ color: '#ffd23f' })
    expect(track.clips.every((c) => c.styleOverride === undefined)).toBe(true)
  })

  it('updateCaptionClipStyleInProject 只改当前这一条的覆盖值', () => {
    const project = updateCaptionClipStyleInProject(
      captionProject(),
      'cap',
      'c1',
      { fontSize: 0.08 },
    )!
    const track = project.textTracks![0]
    const c1 = track.clips.find((c) => c.id === 'c1')!
    const c2 = track.clips.find((c) => c.id === 'c2')!
    expect(c1.styleOverride).toEqual({ fontSize: 0.08 })
    expect(c2.styleOverride).toBeUndefined()
  })
})

describe('旧草稿兼容', () => {
  it('没有 captionStyle 时从第一条字幕反推', () => {
    const project = captionProject()
    const track = project.textTracks![0]
    const style = captionStyleForTrack(track)!
    expect(style.fontSize).toBe(0.055)
    expect(style.color).toBe('#ffffff')
    expect(style.y).toBe(0.86)
  })

  it('有 captionStyle 时直接返回组样式', () => {
    let project = captionProject()
    project = updateCaptionStyleInProject(project, 'cap', { bold: true })!
    const track = project.textTracks![0]
    expect(captionStyleForTrack(track)?.bold).toBe(true)
  })

  it('deriveCaptionStyle 读取单条字幕的所有可视字段', () => {
    const derived = deriveCaptionStyle(clip({ fontSize: 0.1, x: 0.3, bold: true }))
    expect(derived).toMatchObject({ fontSize: 0.1, x: 0.3, bold: true })
  })
})

describe('group style command', () => {
  it('一次命令即可撤销恢复', () => {
    const before = captionProject()
    const history = new HistoryStack(before)
    const result = history.execute(
      createUpdateCaptionTrackStyleCommand('cap', { color: '#ffd23f' }, '修改字幕样式'),
    )
    expect(result.changed).toBe(true)
    const undone = history.undo()
    expect(undone?.before).toEqual(before)
  })
})