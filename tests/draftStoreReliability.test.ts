import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { createInitialProject } from '../src/editor/core/operations'
import type { DraftAsset, DraftSettings, DraftSnapshot } from '../src/editor/core/draft'
import type { DraftProjectRecord } from '../src/editor/core/projectLibrary'

/**
 * 草稿存储的可靠性回归：
 * A. 写操作以「事务提交」为准（配额不足在提交阶段 abort 时必须 reject）；
 * B. restoreDraft 失败路径要回收它自己建的 objectURL；
 * C. 「只导入素材、还没有任何片段」的草稿必须能恢复（原来永远打不开）。
 *
 * 用 fake-indexeddb 跑真实 IDB 语义；A 的「提交阶段失败」用一个可编程的假 db 注入。
 */

type StoreModule = typeof import('../src/editor/services/draftStore')

const SETTINGS: DraftSettings = {
  mainTrackMagnet: false,
  autoSnap: true,
  linkage: false,
  previewAxis: false,
  captionFollow: false,
  exportRange: null,
}

/** 每个测试用全新的内存数据库 + 全新的模块实例（draftStore 会缓存数据库 Promise）。 */
async function loadStore(): Promise<StoreModule> {
  vi.resetModules()
  return import('../src/editor/services/draftStore')
}

const audioAsset = (id: string, overrides: Partial<DraftAsset> = {}): DraftAsset => ({
  id,
  url: `blob:audio-${id}`,
  name: `${id}.mp3`,
  size: 2048,
  duration: 5,
  width: 0,
  height: 0,
  kind: 'audio',
  local: true,
  ...overrides,
})

const snapshotOf = (
  assets: DraftAsset[],
  overrides: Partial<DraftSnapshot> = {},
): DraftSnapshot => {
  const base = createInitialProject({ url: 'blob:unused', duration: 10 }, 'clip-a')
  return {
    version: 1,
    // 默认「空时间轴」：只有素材、没有任何片段
    project: { ...base, clips: [], audioTracks: [], overlayTracks: [], textTracks: [] },
    assets,
    sourceUrl: null,
    timelineZoom: 1,
    timelineSettings: { ...SETTINGS },
    playhead: 0,
    updatedAt: Date.now(),
    ...overrides,
  }
}

const recordOf = (id: string, snapshot: DraftSnapshot): DraftProjectRecord => ({
  id,
  name: '测试项目',
  updatedAt: Date.now(),
  thumbnail: '',
  snapshot,
})

beforeEach(() => {
  // fake-indexeddb/auto 装好了全局实现；这里换成一份全新的内存实例，保证测试互不影响。
  ;(globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// A. 写入以 transaction.oncomplete 为准
// ---------------------------------------------------------------------------
describe('A. 草稿写入要等事务提交', () => {
  it('正常保存后可以立刻读到（说明提交完成才 resolve）', async () => {
    const store = await loadStore()
    const record = recordOf('p-normal', snapshotOf([audioAsset('a1')]))
    await store.saveProjectRecord(record)

    const fresh = await loadStore()
    expect(await fresh.loadProjectRecord('p-normal')).toEqual(record)
    expect(await fresh.countProjectRecords()).toBe(1)
  })

  it('请求成功但事务在提交阶段 abort（配额不足）→ reject，而不是假装成功', async () => {
    // 可编程的假 IDB：put 的 onsuccess 先触发，随后事务 abort（正是配额不足的时序）。
    let requestSucceeded = false
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
                    ;(putRequest.onsuccess as (() => void) | undefined)?.()
                    requestSucceeded = true
                    // 提交阶段失败：事务被回滚
                    ;(transaction.onabort as (() => void) | undefined)?.()
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
    ;(globalThis as { indexedDB: unknown }).indexedDB = fakeFactory

    const store = await loadStore()
    await expect(
      store.saveProjectRecord(recordOf('p-quota', snapshotOf([audioAsset('a1')]))),
    ).rejects.toThrow(/Quota|存储空间不足|中止/)
    // 关键时序：请求本身是成功的，失败发生在提交阶段。
    expect(requestSucceeded).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// B. restoreDraft 失败路径回收 objectURL
// ---------------------------------------------------------------------------
describe('B. 恢复失败时回收 objectURL', () => {
  it('中途抛错 → 已经建好的 objectURL 全部 revoke', async () => {
    const store = await loadStore()
    await store.saveMediaBlob('m1', new Blob(['one'], { type: 'audio/mpeg' }))
    await store.saveMediaBlob('m2', new Blob(['two'], { type: 'audio/mpeg' }))

    const created: string[] = []
    const revoked: string[] = []
    let calls = 0
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      calls += 1
      if (calls === 2) throw new Error('createObjectURL 失败（模拟内存不足）')
      const url = `blob:mock-${calls}`
      created.push(url)
      return url
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
      revoked.push(url)
    })

    const snapshot = snapshotOf([
      audioAsset('m1', { url: 'blob:orig-1' }),
      audioAsset('m2', { url: 'blob:orig-2' }),
    ])
    await expect(store.restoreDraft(snapshot)).rejects.toThrow(/createObjectURL 失败/)
    expect(created).toEqual(['blob:mock-1'])
    expect(revoked).toEqual(['blob:mock-1'])
  })

  it('返回 null（素材全缺）时也不留下 objectURL', async () => {
    const store = await loadStore()
    const revoked: string[] = []
    const createSpy = vi.spyOn(URL, 'createObjectURL')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
      revoked.push(url)
    })

    // 没有任何 blob 写进数据库 → 每个 local 素材都会被跳过
    const restored = await store.restoreDraft(
      snapshotOf([audioAsset('missing-1'), audioAsset('missing-2')]),
    )
    expect(restored).toBeNull()
    expect(createSpy).not.toHaveBeenCalled()
    expect(revoked).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// C. 「有素材、无片段」的草稿必须能恢复
// ---------------------------------------------------------------------------
describe('C. 只导入素材、还没有片段的草稿可以恢复', () => {
  it('音频素材 + 空时间轴 → 恢复成功（原来会返回 null 提示素材不可用）', async () => {
    const store = await loadStore()
    await store.saveMediaBlob('audio-1', new Blob(['x'], { type: 'audio/mpeg' }))
    const revoked: string[] = []
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
      revoked.push(url)
    })

    const snapshot = snapshotOf([audioAsset('audio-1')])
    const restored = await store.restoreDraft(snapshot)

    expect(restored).not.toBeNull()
    expect(restored!.assets).toHaveLength(1)
    expect(restored!.assets[0].kind).toBe('audio')
    // 素材的 blob URL 已重新生成（不再是草稿里的旧 URL）
    expect(restored!.assets[0].url.startsWith('blob:')).toBe(true)
    // 时间轴仍然是空的，但素材在素材库里
    expect(restored!.project.clips).toHaveLength(0)
    // 纯音频项目没有「主素材」
    expect(restored!.source).toBeNull()
    // 成功路径不能误回收
    expect(revoked).toEqual([])
  })

  it('有音频轨片段的项目照旧恢复；素材全缺失时仍返回 null', async () => {
    const store = await loadStore()
    await store.saveMediaBlob('audio-2', new Blob(['y'], { type: 'audio/mpeg' }))

    const withTrack = snapshotOf([audioAsset('audio-2')], {
      project: {
        ...snapshotOf([]).project,
        audioTracks: [
          {
            id: 'at',
            name: '音频 1',
            muted: false,
            hidden: false,
            volume: 1,
            clips: [
              {
                id: 'ac',
                sourceUrl: 'blob:audio-audio-2',
                sourceStart: 0,
                sourceEnd: 5,
                start: 0,
                volume: 1,
                fadeIn: 0,
                fadeOut: 0,
              },
            ],
          },
        ],
      },
    })
    const restored = await store.restoreDraft(withTrack)
    expect(restored).not.toBeNull()
    expect(restored!.project.audioTracks?.[0]?.clips).toHaveLength(1)

    // 素材全部缺失 → 依旧判为不可恢复（这里才是真正的「素材不可用」）
    const broken = await store.restoreDraft(snapshotOf([audioAsset('gone')]))
    expect(broken).toBeNull()
  })
})