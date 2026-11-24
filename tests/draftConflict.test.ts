import { describe, expect, it } from 'vitest'
import { isSameProjectOpenMessage } from '../src/editor/core/draftConflict'
import { createEditorStore } from '../src/editor/store/editorStore'

describe('多标签页同项目冲突消息', () => {
  it('同项目 → true', () => {
    expect(isSameProjectOpenMessage({ type: 'open', projectId: 'p1', at: 1 }, 'p1')).toBe(true)
  })

  it('不同项目 / 无当前项目 / 脏数据 → false', () => {
    expect(isSameProjectOpenMessage({ type: 'open', projectId: 'p2', at: 1 }, 'p1')).toBe(false)
    expect(isSameProjectOpenMessage({ type: 'open', projectId: 'p1', at: 1 }, null)).toBe(false)
    expect(isSameProjectOpenMessage(null, 'p1')).toBe(false)
    expect(isSameProjectOpenMessage('open', 'p1')).toBe(false)
    expect(isSameProjectOpenMessage({ type: 'close', projectId: 'p1' }, 'p1')).toBe(false)
  })
})

describe('draftSaveLocked：第二标签页停止自动保存', () => {
  it('默认关闭，可显式开/关（顶栏据此显示「另一页正在编辑」）', () => {
    const store = createEditorStore()
    expect(store.getState().draftSaveLocked).toBe(false)
    store.getState().setDraftSaveLocked(true)
    expect(store.getState().draftSaveLocked).toBe(true)
    store.getState().setDraftSaveLocked(false)
    expect(store.getState().draftSaveLocked).toBe(false)
  })
})