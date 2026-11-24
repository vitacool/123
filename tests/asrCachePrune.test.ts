import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'

/**
 * 识别缓存（IndexedDB）的容量与可靠性回归。
 *
 * 真实隐患：cacheKey 里带「区间（毫秒精度）」，时间轴上每挪动一次片段边界就产生
 * 一条新缓存，而旧实现**没有任何淘汰**。长期使用后 IndexedDB 配额被打满，
 * 写入失败反而拖垮整轮识别。这里锁住：
 * 1. 保存/读取往返；
 * 2. 超过上限按写入时间淘汰最旧（并留出 20% 余量）；
 * 3. v1 老库（没有 savedAt 索引）能升级，且「无时间戳」的条目优先被淘汰；
 * 4. clearAsrCache 两个 store 都清空。
 */

type CacheModule = typeof import('../src/editor/services/asr/asrCache')

const DB_NAME = 'framecut-asr'

/** 每个测试用全新的内存数据库 + 全新模块实例（asrCache 缓存 databasePromise）。 */
async function loadCache(): Promise<CacheModule> {
  vi.resetModules()
  return import('../src/editor/services/asr/asrCache')
}

const words = (text: string) => [{ text, start: 0, end: 0.4 }]

beforeEach(() => {
  // 全新的内存 IDB，避免测试之间串数据。
  globalThis.indexedDB = new IDBFactory()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('asrCache：保存与读取', () => {
  it('写入后能按 key 读回；不存在的 key 返回 null', async () => {
    const cache = await loadCache()
    await cache.saveAsrWords('k1', words('你好'))
    await expect(cache.loadAsrWords('k1')).resolves.toEqual(words('你好'))
    await expect(cache.loadAsrWords('missing')).resolves.toBeNull()
  })

  it('重复写同一个 key 覆盖而不是累加', async () => {
    const cache = await loadCache()
    await cache.saveAsrWords('k1', words('旧'))
    await cache.saveAsrWords('k1', words('新'))
    await expect(cache.loadAsrWords('k1')).resolves.toEqual(words('新'))
    await expect(cache.asrCacheEntryCount()).resolves.toBe(1)
  })
})

describe('asrCache：容量淘汰', () => {
  it('超过上限时删掉最旧的一批（保留上限的 80%）', async () => {
    const cache = await loadCache()
    let clock = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => {
      clock += 1_000
      return clock
    })
    for (let index = 0; index < 10; index += 1) {
      await cache.saveAsrWords(`k${index}`, words(`w${index}`))
    }
    // 写入时不触发淘汰（10 < 400），手动按 limit=5 触发：目标 4 条。
    const removed = await cache.pruneAsrCache(5)
    expect(removed).toBe(6)
    await expect(cache.asrCacheEntryCount()).resolves.toBe(4)

    // 保留的应该是最新的 4 条（k6..k9）。
    for (const key of ['k6', 'k7', 'k8', 'k9']) {
      await expect(cache.loadAsrWords(key)).resolves.not.toBeNull()
    }
    for (const key of ['k0', 'k1', 'k2', 'k3', 'k4', 'k5']) {
      await expect(cache.loadAsrWords(key)).resolves.toBeNull()
    }
  })

  it('未超上限时不动任何数据', async () => {
    const cache = await loadCache()
    await cache.saveAsrWords('a', words('a'))
    await cache.saveAsrWords('b', words('b'))
    await expect(cache.pruneAsrCache(5)).resolves.toBe(0)
    await expect(cache.asrCacheEntryCount()).resolves.toBe(2)
  })

  it('v1 老库升级后，没有时间戳的条目优先被淘汰', async () => {
    // 手工建一个 v1 库（只有 words store，没有任何 savedAt 索引）。
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('words')
      }
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction('words', 'readwrite')
        for (let index = 0; index < 6; index += 1) {
          transaction.objectStore('words').put(words(`legacy${index}`), `legacy-${index}`)
        }
        transaction.oncomplete = () => {
          database.close()
          resolve()
        }
        transaction.onerror = () => reject(transaction.error)
      }
      request.onerror = () => reject(request.error)
    })

    const cache = await loadCache()
    // 读取要能穿透升级后的库。
    await expect(cache.loadAsrWords('legacy-3')).resolves.toEqual(words('legacy3'))
    await expect(cache.asrCacheEntryCount()).resolves.toBe(6)

    const removed = await cache.pruneAsrCache(5)
    expect(removed).toBe(2)
    await expect(cache.asrCacheEntryCount()).resolves.toBe(4)
  })
})

describe('asrCache：清空', () => {
  it('clearAsrCache 同时清空 words 与 index（再写不会误删）', async () => {
    const cache = await loadCache()
    await cache.saveAsrWords('a', words('a'))
    await cache.saveAsrWords('b', words('b'))
    await cache.clearAsrCache()
    await expect(cache.asrCacheEntryCount()).resolves.toBe(0)
    await expect(cache.loadAsrWords('a')).resolves.toBeNull()

    await cache.saveAsrWords('c', words('c'))
    await expect(cache.asrCacheEntryCount()).resolves.toBe(1)
    await expect(cache.pruneAsrCache(5)).resolves.toBe(0)
  })
})