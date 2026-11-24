import { describe, expect, it, vi } from 'vitest'
import { createFrameCutApi } from '../src/editor/api'
import { createEmptyProject } from '../src/editor/core/operations'
import { createEditorStore } from '../src/editor/store/editorStore'

// 项目数已达上限（20）。只替换读计数与落盘，保留其它草稿能力。
vi.mock('../src/editor/services/draftStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/editor/services/draftStore')>()
  return {
    ...actual,
    countProjectRecords: vi.fn(async () => 20),
    persistImportedAssets: vi.fn(async () => ({ saved: 0, failed: 0 })),
  }
})

describe('项目上限：会新建项目的入口必须提前拦住', () => {
  it('宿主 loadProject 达上限时拒绝并给出可执行提示', async () => {
    const store = createEditorStore()
    const api = createFrameCutApi({ store })
    await expect(api.loadProject(createEmptyProject())).rejects.toThrow('上限')
    expect(store.getState().toast?.message).toContain('上限')
    expect(store.getState().toast?.kind).toBe('warning')
  })
})