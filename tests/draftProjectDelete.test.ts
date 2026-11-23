import { beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { createInitialProject } from '../src/editor/core/operations'
import type { DraftAsset } from '../src/editor/core/draft'
import type { DraftProjectRecord } from '../src/editor/core/projectLibrary'
import type { DraftSnapshot } from '../src/editor/core/draft'

/**
 * 删除「另一个项目」时，不能回收**当前会话正在用、但还没落盘**的媒体 blob。
 *
 * `deleteMediaBlobIfUnreferenced` 一直有 `stillReferenced`（当前会话内存里的素材 id）
 * 保护；但 `deleteDraftProject`（用户在「最近项目」里删别的项目时走这条）只按
 * 存储里的记录判定 —— 于是「刚导入素材、700ms 防抖还没落盘」的 blob 会被当成孤儿删掉，
 * 当前会话看起来一切正常，刷新后素材全丢。
 */

type StoreModule = typeof import('../src/editor/services/draftStore')

const SETTINGS = {
  mainTrackMagnet: false,
  autoSnap: true,
  linkage: false,
  previewAxis: false,
  captionFollow: false,
  exportRange: null,
}

const asset = (id: string): DraftAsset => ({
  id,
  url: `blob:${id}`,
  name: `${id}.mp4`,
  size: 1024,
  duration: 5,
  width: 320,
  height: 180,
  kind: 'video',
  local: true,
})

const snapshotWith = (assets: DraftAsset[]): DraftSnapshot => {
  const base = createInitialProject({ url: 'blob:none', duration: 10 }, 'clip-a')
  return {
    version: 1,
    project: { ...base, clips: [], audioTracks: [], overlayTracks: [], textTracks: [] },
    assets,
    sourceUrl: null,
    timelineZoom: 1,
    timelineSettings: { ...SETTINGS },
    playhead: 0,
    updatedAt: Date.now(),
  }
}

const record = (id: string, assets: DraftAsset[]): DraftProjectRecord => ({
  id,
  name: id,
  updatedAt: Date.now(),
  thumbnail: '',
  snapshot: snapshotWith(assets),
})

async function loadStore(): Promise<StoreModule> {
  vi.resetModules()
  return import('../src/editor/services/draftStore')
}

beforeEach(() => {
  ;(globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
})

describe('deleteDraftProject：保护当前会话未落盘的 blob', () => {
  it('删别的项目时，当前会话刚导入（尚未落盘）的 blob 不能被回收', async () => {
    const store = await loadStore()

    // 项目 A 已落盘（引用 a-old），项目 B 已落盘（引用 b-old）；两个 blob 都真实存在
    await store.saveProjectRecord(record('A', [asset('a-old')]))
    await store.saveProjectRecord(record('B', [asset('b-old')]))
    await store.saveMediaBlob('a-old', new Blob(['old']))
    await store.saveMediaBlob('b-old', new Blob(['b']))
    // 当前会话在 A 里刚导入 a-new，草稿还没落盘（700ms 防抖窗口内）
    await store.saveMediaBlob('a-new', new Blob(['new']))

    const removed = await store.deleteDraftProject('B', {
      stillReferenced: ['a-old', 'a-new'],
    })

    // B 的 blob 该回收
    expect(removed).toContain('b-old')
    // A 的 blob（含尚未落盘的新素材）必须留着
    expect(removed).not.toContain('a-new')
    expect(removed).not.toContain('a-old')
    expect(await store.loadMediaBlob('a-new')).toBeTruthy()
  })

  it('不传 stillReferenced 时（兼容旧调用）仍按存储记录回收', async () => {
    const store = await loadStore()
    await store.saveProjectRecord(record('A', [asset('a-old')]))
    await store.saveProjectRecord(record('B', [asset('b-old')]))
    await store.saveMediaBlob('a-old', new Blob(['old']))
    await store.saveMediaBlob('b-old', new Blob(['b']))
    const removed = await store.deleteDraftProject('B')
    expect(removed).toEqual(['b-old'])
    expect(await store.loadMediaBlob('a-old')).toBeTruthy()
  })
})