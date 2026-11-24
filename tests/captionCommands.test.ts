import { describe, expect, it } from 'vitest'
import {
  createImportAutoCaptionsCommand,
  createImportSubtitlesCommand,
  createReplaceAutoCaptionsCommand,
} from '../src/editor/core/commands'
import { HistoryStack } from '../src/editor/core/history'
import { createEmptyProject } from '../src/editor/core/operations'
import {
  addTextClipToProject,
  addTextTrackToProject,
  cueToCaptionClip,
  updateTextTrackInProject,
} from '../src/editor/core/text'
import type { Project, TextClip } from '../src/editor/core/types'

function captionClip(id: string, start: number): TextClip {
  return cueToCaptionClip({ start, end: start + 2, text: `字幕${id}` }, id, '16:9')
}

function projectWithPreviousCaptions(): Project {
  let project = createEmptyProject()
  project = addTextTrackToProject(project, 'caption-old', 'caption')
  project = updateTextTrackInProject(project, 'caption-old', { name: '智能字幕' })!
  project = addTextClipToProject(project, 'caption-old', captionClip('old-1', 0))!
  project = addTextClipToProject(project, 'caption-old', captionClip('old-2', 3))!
  // 另一条 caption 轨：替换时不应被影响。
  project = addTextTrackToProject(project, 'caption-second', 'caption')
  project = addTextClipToProject(project, 'caption-second', captionClip('other', 1))!
  // A manual text track has no `kind`, and must survive the replace command.
  project = addTextTrackToProject(project, 'manual')
  project = addTextClipToProject(project, 'manual', captionClip('manual-1', 1))!
  return project
}

describe('import subtitle commands', () => {
  it('SRT/VTT 导入必须建出 caption 轨，否则字幕列表与「导出 SRT」不可达', () => {
    const before = createEmptyProject()
    const clips = [captionClip('imported-1', 1), captionClip('imported-2', 4)]
    const after = createImportSubtitlesCommand('imported-track', clips, '导入字幕').execute(before)
    const track = (after.textTracks ?? [])[0]
    expect(track, '导入后必须有一条文本轨').toBeTruthy()
    expect(track.kind, '必须是 caption 轨，属性面板才会渲染字幕列表面板').toBe('caption')
    expect(track.name).toBe('导入字幕')
    expect(track.clips).toHaveLength(2)
    expect(track.clips[0].text).toBe('字幕imported-1')
  })
})

describe('auto caption commands', () => {
  it('replace command swaps the target caption track clips, keeps name, leaves other caption/manual tracks', () => {
    const before = projectWithPreviousCaptions()
    const after = createReplaceAutoCaptionsCommand('caption-old', [
      captionClip('new-1', 0),
      captionClip('new-2', 3),
    ]).execute(before)

    const target = after.textTracks!.find((track) => track.id === 'caption-old')!
    expect(target.name).toBe('智能字幕')
    expect(target.clips.map((clip) => clip.id)).toEqual(['new-1', 'new-2'])

    // 其它 caption 轨不受影响
    const second = after.textTracks!.find((track) => track.id === 'caption-second')!
    expect(second.clips.map((clip) => clip.id)).toEqual(['other'])

    const manualTracks = after.textTracks!.filter((track) => track.kind !== 'caption')
    expect(manualTracks).toHaveLength(1)
    expect(manualTracks[0].id).toBe('manual')
    expect(manualTracks[0].clips.map((clip) => clip.id)).toEqual(['manual-1'])
  })

  it('replace command restores the previous state with a single undo', () => {
    const before = projectWithPreviousCaptions()
    const history = new HistoryStack(before)
    const result = history.execute(
      createReplaceAutoCaptionsCommand('caption-new', [captionClip('new-1', 0)]),
    )
    expect(result.changed).toBe(true)
    expect(history.canUndo).toBe(true)

    const undone = history.undo()
    expect(undone?.command.label).toBe('替换智能字幕（1 条）')
    expect(undone?.before).toEqual(before)
    expect(history.canUndo).toBe(false)
  })

  it('import command creates a caption-kind track for the append path', () => {
    const after = createImportAutoCaptionsCommand(
      'caption-1',
      [captionClip('c1', 0)],
      '智能字幕',
    ).execute(createEmptyProject())
    expect(after.textTracks![0].kind).toBe('caption')
  })
})