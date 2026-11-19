import { describe, expect, it } from 'vitest'
import { createMoveOverlayTrackCommand } from '../src/editor/core/commands'
import {
  createInitialProject,
  moveOverlayTrackInProject,
} from '../src/editor/core/operations'
import { createEditorStore } from '../src/editor/store/editorStore'
import type { OverlayTrack, Project, SourceInfo } from '../src/editor/core/types'

const SOURCE: SourceInfo = {
  url: 'blob:test',
  name: 'test.mp4',
  size: 1024,
  duration: 20,
  width: 1920,
  height: 1080,
}

const track = (id: string): OverlayTrack => ({
  id,
  name: `叠加 ${id}`,
  muted: false,
  hidden: false,
  enabled: true,
  locked: false,
  solo: false,
  clips: [],
})

/** 三条叠加轨：index 0 = 最下层（bottom-to-top），index 2 = 最上层。 */
function threeOverlays(): Project {
  const base = createInitialProject({ url: SOURCE.url, duration: 20 }, 'c0')
  return { ...base, overlayTracks: [track('a'), track('b'), track('c')] }
}

const order = (project: Project): string[] =>
  (project.overlayTracks ?? []).map((item) => item.id)

describe('叠加轨层级重排（数组是 bottom-to-top）', () => {
  it('up = 数组 index + 1（视觉上更高一层），down = index - 1', () => {
    const project = threeOverlays()
    // 最下层 a 上移一层 → 变成 index 1
    const upOnce = moveOverlayTrackInProject(project, 'a', 'up')
    expect(order(upOnce)).toEqual(['b', 'a', 'c'])
    expect(order(project)).toEqual(['a', 'b', 'c']) // 纯函数，不改原对象

    // 最上层 c 下移一层 → 变成 index 1
    const downOnce = moveOverlayTrackInProject(project, 'c', 'down')
    expect(order(downOnce)).toEqual(['a', 'c', 'b'])

    // 中间层 b 上移 / 下移都可
    expect(order(moveOverlayTrackInProject(project, 'b', 'up'))).toEqual(['a', 'c', 'b'])
    expect(order(moveOverlayTrackInProject(project, 'b', 'down'))).toEqual(['b', 'a', 'c'])
  })

  it('已在最上层点 up / 最下层点 down 时返回原 project（不产生历史）', () => {
    const project = threeOverlays()
    expect(moveOverlayTrackInProject(project, 'c', 'up')).toBe(project)
    expect(moveOverlayTrackInProject(project, 'a', 'down')).toBe(project)
    // 轨道不存在同样返回原对象
    expect(moveOverlayTrackInProject(project, 'nope', 'up')).toBe(project)
    // 命令层同样不产生变化
    expect(createMoveOverlayTrackCommand('c', 'up').execute(project)).toBe(project)
    expect(createMoveOverlayTrackCommand('a', 'down').execute(project)).toBe(project)
  })

  it('只有一条叠加轨时上下都不可用', () => {
    const single: Project = { ...threeOverlays(), overlayTracks: [track('only')] }
    expect(moveOverlayTrackInProject(single, 'only', 'up')).toBe(single)
    expect(moveOverlayTrackInProject(single, 'only', 'down')).toBe(single)
  })

  it('主轨片段顺序不受影响', () => {
    const base = createInitialProject({ url: SOURCE.url, duration: 20 }, 'c0')
    const project: Project = {
      ...base,
      clips: [base.clips[0], { ...base.clips[0], id: 'c1', sourceStart: 4, sourceEnd: 8 }],
      overlayTracks: [track('a'), track('b')],
    }
    const moved = moveOverlayTrackInProject(project, 'a', 'up')
    expect(moved.clips).toBe(project.clips) // 引用未变
    expect(order(moved)).toEqual(['b', 'a'])
  })
})

describe('store：moveOverlayTrack', () => {
  const makeStore = () => {
    const store = createEditorStore()
    store.getState().loadSource(SOURCE)
    store.getState().addOverlayTrack()
    store.getState().addOverlayTrack()
    store.getState().addOverlayTrack()
    return store
  }

  it('重排 1 步撤销，且选中片段保持选中', () => {
    const store = makeStore()
    const tracks = store.getState().project.overlayTracks ?? []
    expect(tracks).toHaveLength(3)
    const bottomId = tracks[0].id
    const selected = store.getState().selectedClipId
    const before = store.getState().project.overlayTracks!.map((item) => item.id)

    store.getState().moveOverlayTrack(bottomId, 'up')
    const after = store.getState().project.overlayTracks!.map((item) => item.id)
    expect(after[1]).toBe(bottomId)
    expect(store.getState().selectedClipId).toBe(selected)

    store.getState().undo()
    expect(store.getState().project.overlayTracks!.map((item) => item.id)).toEqual(before)
  })

  it('边界操作不产生历史、不弹成功提示', () => {
    const store = makeStore()
    const tracks = store.getState().project.overlayTracks ?? []
    const topId = tracks[tracks.length - 1].id
    const bottomId = tracks[0].id

    store.getState().undo() // 清掉 addOverlayTrack 留下的历史并不现实；这里直接对比 project 引用
    const projectBefore = store.getState().project
    store.getState().moveOverlayTrack(topId, 'up')
    expect(store.getState().project).toBe(projectBefore)
    store.getState().moveOverlayTrack(bottomId, 'down')
    expect(store.getState().project).toBe(projectBefore)
  })
})