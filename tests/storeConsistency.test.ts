import { describe, expect, it } from 'vitest'
import { createEditorStore } from '../src/editor/store/editorStore'
import { createEmptyProject, createInitialProject } from '../src/editor/core/operations'
import type { MediaAsset, SourceInfo } from '../src/editor/core/types'

/**
 * store 状态一致性回归：
 *
 * 1. 主轨磁吸 + 撤销：`sync()` 曾经按磁吸把首段 gap 夹成 0，撤销贴齐命令后历史栈
 *    恢复到带空隙的快照、sync 又夹回去 → `store.project` 与 `history.present` 分叉，
 *    表现为「撤销失效」（再撤销/重做以不同底稿计算）。
 * 2. 切换项目（loadSource / hydrateDraft / clearSource）只重置了 selectedClipId，
 *    没有清空 selectedIds → 复制/删除会用到上一个项目的失效 id。
 */

const source = (url: string, name = url): SourceInfo => ({
  url,
  name,
  size: 1024,
  duration: 10,
  width: 640,
  height: 360,
})

const asset = (id: string, url: string): MediaAsset => ({ ...source(url), id, kind: 'video' })

/** 模拟「用户把主轨首段拖到 3s」：产生一个可撤销的 leading gap。 */
const makeLeadingGapCommand = (gap: number) => ({
  label: '拖动首段',
  execute: (project: import('../src/editor/core/types').Project) => ({
    ...project,
    clips: [{ ...project.clips[0], gapBefore: gap }, ...project.clips.slice(1)],
  }),
})

describe('主轨磁吸 + 撤销：store.project 必须与历史一致', () => {
  it('撤销贴齐后首段 gap 恢复原值，且 store 与历史栈不再分叉', () => {
    const store = createEditorStore()
    store.getState().loadSource(source('u1'))

    // 先造出 leading gap（3s），再打开磁吸：磁吸会执行一条「贴齐」命令。
    store.getState().execute(makeLeadingGapCommand(3))
    expect(store.getState().project.clips[0].gapBefore).toBe(3)

    store.getState().toggleTimelineSetting('mainTrackMagnet')
    expect(store.getState().timelineSettings.mainTrackMagnet).toBe(true)
    // 贴齐生效（独立的一步撤销）
    expect(store.getState().project.clips[0].gapBefore).toBe(0)

    // 撤销贴齐：磁吸仍然开着，但快照就是「带空隙」的原状
    store.getState().undo()
    expect(store.getState().project.clips[0].gapBefore).toBe(3)

    // 关键：此后重做必须回到贴齐状态（若 sync 还在夹，这里会立刻又被夹回 0 → 重做"无效"）
    store.getState().redo()
    expect(store.getState().project.clips[0].gapBefore).toBe(0)
    // 再撤销一次仍然恢复空隙（历史底稿没有被 store 悄悄改写）
    store.getState().undo()
    expect(store.getState().project.clips[0].gapBefore).toBe(3)
  })

  it('磁吸开着时，普通编辑命令仍会自动贴齐（语义保留在命令链里）', () => {
    const store = createEditorStore()
    store.getState().loadSource(source('u1'))
    store.getState().toggleTimelineSetting('mainTrackMagnet')
    expect(store.getState().timelineSettings.mainTrackMagnet).toBe(true)

    // 一次会产生 leading gap 的编辑 → 命令链里夹成 0
    store.getState().execute(makeLeadingGapCommand(2))
    expect(store.getState().project.clips[0].gapBefore).toBe(0)

    // 撤销回上一个状态（本来就没有 gap）
    store.getState().undo()
    expect(store.getState().project.clips[0].gapBefore).toBe(0)
  })
})

describe('切换项目必须重置多选集合（selectedIds）', () => {
  it('loadSource：上一个项目的多选不会残留', () => {
    const store = createEditorStore()
    store.getState().loadSource(source('u1'))
    const oldClipId = store.getState().project.clips[0].id
    // 多选里放一个旧项目 id（模拟上一个项目的选择）
    store.getState().selectIds([oldClipId])

    store.getState().loadSource(source('u2'))
    const state = store.getState()
    expect(state.project.clips[0].id).not.toBe(oldClipId)
    expect(state.selectedIds).toEqual([state.project.clips[0].id])
    expect(state.selectedIds).not.toContain(oldClipId)

    // 症状层面：复制不会把旧项目的 id 当成目标（复制到的是新项目自己的片段）
    state.copySelection()
    expect(store.getState().clipboard.count).toBe(1)
  })

  it('hydrateDraft：切到别的草稿后多选集合换成新项目的首个片段', () => {
    const store = createEditorStore()
    store.getState().loadSource(source('u1'))
    const staleId = store.getState().project.clips[0].id
    store.getState().selectIds([staleId])

    const project = createInitialProject(source('u2'), 'draft-clip')
    store.getState().hydrateDraft({
      project,
      assets: [asset('a2', 'u2')],
      source: { ...source('u2'), id: 'a2', kind: 'video' } as MediaAsset,
      timelineZoom: store.getState().timelineZoom,
      timelineSettings: {
        mainTrackMagnet: false,
        autoSnap: true,
        linkage: false,
        previewAxis: true,
        captionFollow: true,
        exportRange: null,
      },
      playhead: 0,
    })

    const state = store.getState()
    expect(state.selectedIds).toEqual(['draft-clip'])
    expect(state.selectedIds).not.toContain(staleId)
  })

  it('clearSource：关掉项目后多选清空', () => {
    const store = createEditorStore()
    store.getState().loadSource(source('u1'))
    store.getState().selectIds([store.getState().project.clips[0].id])

    store.getState().clearSource()
    const state = store.getState()
    expect(state.selectedClipId).toBeNull()
    expect(state.selectedIds).toEqual([])
    // 空工程也不该再被旧选中影响
    expect(state.project).toEqual(createEmptyProject())
  })
})