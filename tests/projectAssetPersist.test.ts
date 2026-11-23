import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { createInitialProject } from '../src/editor/core/operations'
import { createEditorStore } from '../src/editor/store/editorStore'
import { applyProjectToStore, createFrameCutApi } from '../src/editor/api'
import { createProjectFile } from '../src/editor/projectFile'
import type { DraftAsset, DraftSettings, DraftSnapshot } from '../src/editor/core/draft'
import type { MediaAsset, Project } from '../src/editor/core/types'

/**
 * 导入工程后刷新，素材必须还在。
 *
 * 工程文件只带素材元信息（DraftAsset 没有 Blob），重新选择出来的素材 Blob
 * 只在这一刻存在于内存。如果导入路径不把它写进 IndexedDB，刷新后
 * restoreDraft 在 media store 里找不到 blob → 跳过素材 → 剔除对应片段，
 * 用户看到的是「素材全部不可用，片段全部消失」。
 */

type DraftStoreModule = typeof import('../src/editor/services/draftStore')

const ORIGIN_URL = 'blob:origin'
const SOURCE = { url: ORIGIN_URL, duration: 6 }

const SETTINGS: DraftSettings = {
  mainTrackMagnet: false,
  autoSnap: true,
  linkage: false,
  previewAxis: false,
  captionFollow: false,
  exportRange: null,
}

/** 同一份素材铺成两段（模拟工程里有多条片段）。 */
function projectWithTwoClips(): Project {
  const base = createInitialProject(SOURCE, 'clip-1')
  const clip = base.clips[0]
  return { ...base, clips: [clip, { ...clip, id: 'clip-2', sourceStart: 3, sourceEnd: 6 }] }
}

const draftAssetOf = (id: string, url: string): DraftAsset => ({
  id,
  url,
  name: 'clip.mp4',
  size: 4,
  duration: 6,
  width: 320,
  height: 240,
  kind: 'video',
  local: true,
})

const mediaAssetOf = (id: string, file: File, url = URL.createObjectURL(file)): MediaAsset => ({
  id,
  url,
  name: file.name,
  size: file.size,
  duration: 6,
  width: 320,
  height: 240,
  kind: 'video',
  file,
})

/** 假的 readAssetFile：拿到 File 就返回带 Blob 的素材（与真实实现一致）。 */
function fakeReader(id: string) {
  return async (file: File): Promise<MediaAsset> => mediaAssetOf(id, file)
}

/** 模拟刷新：新模块实例（draftStore 缓存了数据库 Promise），IndexedDB 数据仍在。 */
async function reopen(
  snapshot: unknown,
): Promise<{ drafts: DraftStoreModule; restored: Awaited<ReturnType<DraftStoreModule['restoreDraft']>> }> {
  vi.resetModules()
  const drafts = await import('../src/editor/services/draftStore')
  const restored = await drafts.restoreDraft(snapshot)
  return { drafts, restored }
}

/** 落盘当前会话的草稿记录（等价于编辑器的自动保存）。 */
async function saveCurrentDraft(store: ReturnType<typeof createEditorStore>): Promise<DraftSnapshot> {
  const drafts: DraftStoreModule = await import('../src/editor/services/draftStore')
  const record = drafts.buildDraftRecord(store.getState())
  expect(record).not.toBeNull()
  await drafts.saveProjectRecord(record!)
  return record!.snapshot
}

beforeEach(() => {
  // 每个用例一份全新的内存数据库；模块实例也重置（draftStore 缓存了数据库 Promise）。
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  vi.resetModules()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('宿主 API loadProject：素材要落盘', () => {
  it('载入工程并重新打开后，素材与片段都恢复', async () => {
    const store = createEditorStore()
    const api = createFrameCutApi({ store, readAsset: fakeReader('asset-1') })
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'clip.mp4', { type: 'video/mp4' })

    await api.loadProject(projectWithTwoClips(), [file])
    expect(store.getState().assets).toHaveLength(1)
    expect(store.getState().project.clips).toHaveLength(2)

    const snapshot = await saveCurrentDraft(store)
    const { drafts, restored } = await reopen(snapshot)

    expect(restored, '刷新后草稿不应被判定为空工程').not.toBeNull()
    expect(restored!.assets).toHaveLength(1)
    expect(restored!.project.clips.map((clip) => clip.id)).toEqual(['clip-1', 'clip-2'])
    // 素材 Blob 真的在 media store 里（而不是只恢复了元信息）
    expect(await drafts.loadMediaBlob('asset-1')).toBeTruthy()
  })
})

describe('工程文件导入：素材要落盘', () => {
  it('导入 .framecut.json 后重新打开，素材与片段都恢复', async () => {
    const drafts: DraftStoreModule = await import('../src/editor/services/draftStore')
    const store = createEditorStore()
    const projectFile = createProjectFile({
      project: projectWithTwoClips(),
      assets: [draftAssetOf('meta-1', ORIGIN_URL)],
      sourceUrl: ORIGIN_URL,
      timelineZoom: 92,
      timelineSettings: SETTINGS,
      playhead: 0,
    })
    const file = new File([new Uint8Array([9, 9, 9, 9])], 'clip.mp4', { type: 'video/mp4' })

    // 复刻 importProjectFile：逐个重新选择素材 → 读出 MediaAsset → 落盘 → 应用工程
    const asset = await fakeReader('asset-1')(file)
    const urlMap = new Map([[ORIGIN_URL, asset.url]])
    await drafts.persistImportedAssets([asset], { notify: vi.fn() })
    const applied = applyProjectToStore(store, {
      project: projectFile.project,
      urlMap,
      extraAssets: [asset],
      sourceUrl: projectFile.sourceUrl,
      playhead: projectFile.playhead,
    })
    expect(applied.removedClips).toBe(0)
    expect(applied.assetCount).toBe(1)

    const snapshot = await saveCurrentDraft(store)
    const { restored } = await reopen(snapshot)

    expect(restored, '刷新后草稿不应被判定为空工程').not.toBeNull()
    expect(restored!.assets).toHaveLength(1)
    expect(restored!.project.clips.map((clip) => clip.id)).toEqual(['clip-1', 'clip-2'])
  })

  it('VideoEditor 的工程文件导入在应用工程前调用共用落盘函数（防止再次漏写）', () => {
    const source = readFileSync(join(process.cwd(), 'src/editor/VideoEditor.tsx'), 'utf8')
    // 导入流程现在拆成「缺失素材对话框」+ finishProjectImport；落盘必须仍在应用工程之前。
    const start = source.indexOf('const finishProjectImport = async')
    const end = source.indexOf('const startProjectImport =')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const body = source.slice(start, end)
    const persistAt = body.indexOf('persistImportedAssets(')
    const applyAt = body.indexOf('applyProjectToStore(')
    expect(persistAt, '工程文件导入必须调用 persistImportedAssets').toBeGreaterThan(-1)
    // 必须在应用工程之前落盘：应用之后触发的自动保存不能抢在 Blob 之前。
    expect(applyAt).toBeGreaterThan(persistAt)
  })
})

describe('persistImportedAssets：写入语义', () => {
  it('把带 Blob 的素材写进 media store，跳过没有 file 的素材', async () => {
    const drafts: DraftStoreModule = await import('../src/editor/services/draftStore')
    const file = new File([new Uint8Array([1, 2])], 'clip.mp4', { type: 'video/mp4' })
    const withFile = mediaAssetOf('asset-with-file', file)
    const withoutFile: MediaAsset = { ...mediaAssetOf('asset-no-file', file), file: undefined }

    const result = await drafts.persistImportedAssets([withFile, withoutFile], { notify: vi.fn() })

    expect(result).toEqual({ saved: 1, failed: 0 })
    expect(await drafts.loadMediaBlob('asset-with-file')).toBeTruthy()
    expect(await drafts.loadMediaBlob('asset-no-file')).toBeUndefined()
  })

  it('配额不足时提示「素材未能保存，刷新后将丢失」，不能静默吞掉', async () => {
    // 可编程的假 IDB：put 请求直接失败（配额不足 / 存储不可用的时序）。
    const fakeFactory = {
      open: () => {
        const openRequest: Record<string, unknown> = {}
        queueMicrotask(() => {
          const database = {
            objectStoreNames: { contains: () => true },
            close: () => undefined,
            onversionchange: null,
            transaction: () => {
              const transaction: Record<string, unknown> = {
                error: new Error('QuotaExceededError: 存储空间不足'),
                oncomplete: null,
                onabort: null,
                onerror: null,
              }
              transaction.objectStore = () => ({
                put: () => {
                  const putRequest: Record<string, unknown> = {}
                  queueMicrotask(() => {
                    ;(putRequest.onerror as (() => void) | undefined)?.()
                  })
                  return putRequest
                },
              })
              return transaction
            },
          }
          openRequest.result = database
          ;(openRequest.onsuccess as (() => void) | undefined)?.()
        })
        return openRequest
      },
    }
    ;(globalThis as unknown as { indexedDB: unknown }).indexedDB = fakeFactory

    const drafts: DraftStoreModule = await import('../src/editor/services/draftStore')
    const notify = vi.fn()
    const file = new File([new Uint8Array([1, 2])], 'clip.mp4', { type: 'video/mp4' })
    const result = await drafts.persistImportedAssets(
      [mediaAssetOf('asset-1', file, 'blob:in-memory')],
      { notify },
    )

    expect(result).toEqual({ saved: 0, failed: 1 })
    expect(notify).toHaveBeenCalledWith('素材未能保存，刷新后将丢失', 'error')
  })
})