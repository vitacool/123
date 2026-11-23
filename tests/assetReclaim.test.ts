import { beforeEach, describe, expect, it, vi } from 'vitest'
import { assetsReferencedBy } from '../src/editor/core/assets'
import { HistoryStack } from '../src/editor/core/history'
import { HISTORY_LIMIT } from '../src/editor/core/constants'
import { createEditorStore } from '../src/editor/store/editorStore'
import { createInitialProject } from '../src/editor/core/operations'
import type { MediaAsset, SourceInfo } from '../src/editor/core/types'

/**
 * 素材删除的「延迟回收」：
 * - 删除素材后先标记 pending、素材库隐藏，但**不** revoke / 删 blob；
 * - 撤销把片段带回来时，素材也回到素材库（不再出现「撤销后是坏片段」）；
 * - 只有当历史栈（past + present + future）里再没有任何引用时才真正回收；
 * - 切项目 / 卸载走强制回收。
 */

// draftStore 的真实实现在 node 里会碰 IndexedDB；这里只把「删 blob」这一个函数换成间谍。
const draftMocks = vi.hoisted(() => ({ deleteMediaBlobIfUnreferenced: vi.fn(async () => true) }))
vi.mock('../src/editor/services/draftStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/editor/services/draftStore')>()
  return { ...actual, deleteMediaBlobIfUnreferenced: draftMocks.deleteMediaBlobIfUnreferenced }
})

const SOURCE: SourceInfo = {
  url: 'blob:u1',
  name: 'clip.mp4',
  size: 1024,
  duration: 10,
  width: 640,
  height: 360,
}

const extraAsset = (id: string, url: string): MediaAsset => ({
  id,
  url,
  name: `${id}.mp4`,
  size: 1024,
  duration: 10,
  width: 640,
  height: 360,
  kind: 'video',
})

/** 一个已加载主素材（含 1 个片段）的 store。 */
const makeStore = () => {
  const store = createEditorStore()
  store.getState().loadSource(SOURCE)
  return store
}

let revoked: string[] = []

beforeEach(() => {
  draftMocks.deleteMediaBlobIfUnreferenced.mockClear()
  revoked = []
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
    revoked.push(url)
  })
})

describe('删除素材 → 撤销：不回收、素材回库', () => {
  it('删除后立刻是「待回收」：不 revoke、不删 blob、素材库隐藏', () => {
    const store = makeStore()
    const assetId = store.getState().assets[0].id
    store.getState().removeAsset(assetId, { removeClips: true })

    const state = store.getState()
    expect(state.project.clips).toHaveLength(0)
    expect(state.assets).toHaveLength(0)
    // 关键：源还在（否则撤销回来的片段就是坏片段）
    expect(revoked).toEqual([])
    expect(draftMocks.deleteMediaBlobIfUnreferenced).not.toHaveBeenCalled()
    // 历史里还有引用 → 仍挂在待回收
    expect(Object.keys(state.pendingReclaim)).toEqual([assetId])
  })

  it('Ctrl+Z：片段和素材都回来了，且从未被回收', () => {
    const store = makeStore()
    const assetId = store.getState().assets[0].id
    store.getState().removeAsset(assetId, { removeClips: true })
    store.getState().undo()

    const state = store.getState()
    expect(state.project.clips).toHaveLength(1)
    expect(state.assets).toHaveLength(1)
    expect(state.assets[0].url).toBe(SOURCE.url)
    // 撤销后片段的源仍然有效（这正是修复点）
    expect(state.project.clips[0].sourceUrl).toBe(SOURCE.url)
    expect(revoked).toEqual([])
    expect(draftMocks.deleteMediaBlobIfUnreferenced).not.toHaveBeenCalled()
    expect(state.pendingReclaim).toEqual({})
  })

  /**
   * 真实踩坑路径：先删片段（此刻素材变成「没人引用」）→ 再从素材库删素材
   * → 撤销片段删除。删除素材时观察到的引数是 0，但用户并没有「让素材离开库」的
   * 明确意图，撤销把片段带回来之后素材必须一起回来，否则时间轴上是一段黑帧。
   */
  it('先删片段、再删素材（删除时已无引用），撤销片段删除后素材也回库', () => {
    const store = makeStore()
    const assetId = store.getState().assets[0].id
    store.getState().deleteSelectedClip()
    expect(store.getState().project.clips).toHaveLength(0)

    // 素材库此时没有任何引用，UI 会直接移除（removeClips:false，无确认框）
    store.getState().removeAsset(assetId, { removeClips: false })
    expect(store.getState().assets).toHaveLength(0)
    // 片段删除仍在撤销历史里 → 不能立刻回收
    expect(revoked).toEqual([])

    store.getState().undo()
    const state = store.getState()
    expect(state.project.clips).toHaveLength(1)
    // 关键：素材必须回库，且源仍然有效
    expect(state.assets).toHaveLength(1)
    expect(state.assets[0].url).toBe(SOURCE.url)
    expect(state.project.clips[0].sourceUrl).toBe(SOURCE.url)
    expect(revoked).toEqual([])
    expect(state.pendingReclaim).toEqual({})
  })
})

describe('历史不再引用 → 真正回收', () => {
  it('删除后撤销窗口被历史挤出（新命令覆盖）→ revoke + 删 blob', () => {
    const store = makeStore()
    const assetId = store.getState().assets[0].id
    store.getState().removeAsset(assetId, { removeClips: true })
    expect(revoked).toEqual([])

    // 删除片段那条命令的 before 快照一直留在 past 里（那是撤销要找回来的状态），
    // 所以这里用新命令把它挤出历史（超过 HISTORY_LIMIT），历史就不再引用该素材。
    for (let index = 0; index < HISTORY_LIMIT + 2; index += 1) {
      store.getState().execute({
        label: `noop ${index}`,
        execute: (project) => ({
          ...project,
          markers: [{ id: `m${index}`, time: 0, color: '#fff', note: '' }],
        }),
      })
    }

    expect(revoked).toEqual([SOURCE.url])
    expect(draftMocks.deleteMediaBlobIfUnreferenced).toHaveBeenCalledWith(
      assetId,
      expect.objectContaining({ exceptProjectId: expect.anything() }),
    )
    expect(store.getState().pendingReclaim).toEqual({})
  })

  it('未被任何片段引用的素材：删除当刻就回收（保持原有体验）', () => {
    const store = makeStore()
    store.getState().addAssets([extraAsset('extra', 'blob:extra')])
    revoked = []
    draftMocks.deleteMediaBlobIfUnreferenced.mockClear()

    store.getState().removeAsset('extra', { removeClips: false })

    // 它从没被任何片段引用过 → 历史栈里也没有引用 → 立即回收
    expect(revoked).toEqual(['blob:extra'])
    expect(draftMocks.deleteMediaBlobIfUnreferenced).toHaveBeenCalledTimes(1)
    expect(store.getState().pendingReclaim).toEqual({})
  })
})

describe('仅从素材库移除（片段保留）', () => {
  it('片段继续引用 → 不回收、也不自动恢复素材', () => {
    const store = makeStore()
    const assetId = store.getState().assets[0].id
    store.getState().removeAsset(assetId, { removeClips: false })

    const state = store.getState()
    expect(state.project.clips).toHaveLength(1)
    expect(state.assets).toHaveLength(0) // 用户就是想让它在素材库里消失
    expect(Object.keys(state.pendingReclaim)).toEqual([assetId])
    expect(revoked).toEqual([])
    expect(draftMocks.deleteMediaBlobIfUnreferenced).not.toHaveBeenCalled()
  })
})

describe('关闭 / 切换项目：强制回收', () => {
  it('disposePendingAssets 立即回收全部待回收素材', () => {
    const store = makeStore()
    const assetId = store.getState().assets[0].id
    store.getState().removeAsset(assetId, { removeClips: true })
    expect(revoked).toEqual([])

    store.getState().disposePendingAssets()
    expect(revoked).toEqual([SOURCE.url])
    expect(draftMocks.deleteMediaBlobIfUnreferenced).toHaveBeenCalledTimes(1)
    expect(store.getState().pendingReclaim).toEqual({})
  })

  it('clearSource（关闭项目）也会强制回收', () => {
    const store = makeStore()
    const assetId = store.getState().assets[0].id
    store.getState().removeAsset(assetId, { removeClips: true })
    store.getState().clearSource()
    expect(revoked).toEqual([SOURCE.url])
    expect(store.getState().pendingReclaim).toEqual({})
  })
})

describe('HistoryStack.snapshots / assetsReferencedBy', () => {
  it('snapshots 覆盖 past.before + present + future.after', () => {
    const base = createInitialProject({ url: 'u', duration: 10 }, 'c1')
    const stack = new HistoryStack(base)
    const withMarker = { ...base, markers: [{ id: 'm1', time: 1, color: '#fff', note: '' }] }
    stack.execute({ label: 'add marker', execute: () => withMarker })
    expect(stack.snapshots()).toHaveLength(2)

    stack.undo()
    // undo 后：past 空、present = before、future 一项（after）
    const afterUndo = stack.snapshots()
    expect(afterUndo).toHaveLength(2)
    expect(afterUndo[0]).toBe(base)
    expect(afterUndo[afterUndo.length - 1]).toBe(withMarker)
  })

  it('assetsReferencedBy：任意一个快照仍引用就算被引用', () => {
    const asset = { id: 'a1', url: 'blob:u1' }
    const project = createInitialProject({ url: 'blob:u1', duration: 10 }, 'c1')
    const empty = { ...project, clips: [] }
    expect(assetsReferencedBy([empty], asset)).toBe(false)
    expect(assetsReferencedBy([empty, project], asset)).toBe(true)
    expect(assetsReferencedBy([], asset)).toBe(false)
  })
})