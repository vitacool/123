import type { AsrWord } from '../../core/asr'

/**
 * IndexedDB cache for per-asset word-level transcriptions. Mirrors the pattern
 * in `draftStore.ts`: one database, one object store, Promise-wrapped requests.
 * The cache key is built by `buildAsrCacheKey` (asset id + interval + provider
 * + language) so re-editing the timeline reuses transcribed material.
 *
 * 容量策略：识别结果**可再生**（重跑一遍即可），但不设上限时它会无限长大 ——
 * cacheKey 里带区间（毫秒级精度），时间轴上每挪动一次片段边界就会产生新键；
 * 长期使用后 IndexedDB 配额被打满，反而让「保存」失败、拖垮整轮识别。
 * 因此：写入时记录 `savedAt`，条目数超过上限就按写入时间淘汰最旧的。
 */

const DB_NAME = 'framecut-asr'
/** v2：新增 index store（cacheKey → savedAt），用于淘汰；v1 库自动升级。 */
const DB_VERSION = 2
const WORDS_STORE = 'words'
const INDEX_STORE = 'index'

/** 缓存条目上限。每条是一次「区间识别结果」，几百条足以覆盖正常编辑。 */
export const MAX_CACHED_TRANSCRIPTS = 400
/** 淘汰目标比例：留出余量，避免每写一条都触发一次全量淘汰。 */
const PRUNE_TARGET_RATIO = 0.8

let databasePromise: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise
  databasePromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前浏览器不支持 IndexedDB。'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(WORDS_STORE)) {
        database.createObjectStore(WORDS_STORE)
      }
      // 升级到 v2 时补建：老库里已有的条目没有时间戳，淘汰时按「最旧」处理。
      if (!database.objectStoreNames.contains(INDEX_STORE)) {
        database.createObjectStore(INDEX_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开识别缓存数据库。'))
  })
  return databasePromise
}

async function withStore<T>(
  mode: IDBTransactionMode,
  storeName: string,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode)
    const request = action(transaction.objectStore(storeName))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('识别缓存读写失败。'))
  })
}

/** 在**事务提交**后 resolve：写操作的配额/中止错误只有到提交阶段才能看到。 */
async function writeTransaction(action: (tx: IDBTransaction) => void): Promise<void> {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([WORDS_STORE, INDEX_STORE], 'readwrite')
    const fail = (): void => {
      reject(transaction.error ?? new Error('识别缓存写入失败。'))
    }
    transaction.oncomplete = () => resolve()
    transaction.onerror = fail
    transaction.onabort = fail
    try {
      action(transaction)
    } catch (error) {
      try {
        transaction.abort()
      } catch {
        // 已经中止/提交：忽略。
      }
      reject(error)
    }
  })
}

export async function saveAsrWords(cacheKey: string, words: AsrWord[]): Promise<void> {
  await writeTransaction((transaction) => {
    transaction.objectStore(WORDS_STORE).put(words, cacheKey)
    transaction.objectStore(INDEX_STORE).put(Date.now(), cacheKey)
  })
  // 淘汰失败不影响「写入成功」这个事实（缓存是尽力而为）。
  await pruneAsrCache().catch(() => undefined)
}

export async function loadAsrWords(cacheKey: string): Promise<AsrWord[] | null> {
  const words = await withStore<AsrWord[] | undefined>(
    'readonly',
    WORDS_STORE,
    (store) => store.get(cacheKey),
  )
  return words ?? null
}

/** cacheKey → savedAt（毫秒）。keys 与 values 在**同一个事务**里读，避免错位。 */
async function readSavedAt(): Promise<Map<string, number>> {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(INDEX_STORE, 'readonly')
    const store = transaction.objectStore(INDEX_STORE)
    const keysRequest = store.getAllKeys()
    const valuesRequest = store.getAll()
    transaction.oncomplete = () => {
      const result = new Map<string, number>()
      const keys = keysRequest.result ?? []
      const values = valuesRequest.result ?? []
      keys.forEach((key, index) => {
        const savedAt = values[index]
        result.set(
          String(key),
          typeof savedAt === 'number' && Number.isFinite(savedAt) ? savedAt : 0,
        )
      })
      resolve(result)
    }
    transaction.onerror = () => reject(transaction.error ?? new Error('读取识别缓存索引失败。'))
    transaction.onabort = () => reject(transaction.error ?? new Error('读取识别缓存索引失败。'))
  })
}

/**
 * 淘汰超出上限的缓存条目，返回删除条数。
 *
 * 优先删「没有时间戳的旧条目」（v1 升级上来的），再按 savedAt 从旧到新删到
 * `limit * 0.8`。任何一步失败都只是少清理一些，不会抛给识别流程。
 */
export async function pruneAsrCache(limit = MAX_CACHED_TRANSCRIPTS): Promise<number> {
  const wordsKeys = (
    await withStore<IDBValidKey[]>('readonly', WORDS_STORE, (store) => store.getAllKeys())
  ).map(String)
  if (wordsKeys.length <= limit) return 0

  const aged = await readSavedAt()
  const unindexed = wordsKeys.filter((key) => !aged.has(key))
  const oldest = [...aged.entries()].sort((left, right) => left[1] - right[1]).map(([key]) => key)
  const target = Math.max(0, Math.floor(limit * PRUNE_TARGET_RATIO))
  const removeCount = Math.min(wordsKeys.length - target, wordsKeys.length)
  const victims = [...unindexed, ...oldest].slice(0, Math.max(0, removeCount))
  if (victims.length === 0) return 0

  await writeTransaction((transaction) => {
    for (const key of victims) {
      transaction.objectStore(WORDS_STORE).delete(key)
      transaction.objectStore(INDEX_STORE).delete(key)
    }
  })
  console.info(`[asr] 识别缓存清理 ${victims.length} 条（上限 ${limit}）`)
  return victims.length
}

/** 当前缓存条目数（诊断/测试用）。 */
export async function asrCacheEntryCount(): Promise<number> {
  return withStore<number>('readonly', WORDS_STORE, (store) => store.count())
}

export async function clearAsrCache(): Promise<void> {
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction([WORDS_STORE, INDEX_STORE], 'readwrite')
    transaction.objectStore(WORDS_STORE).clear()
    transaction.objectStore(INDEX_STORE).clear()
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('清除识别缓存失败。'))
    transaction.onabort = () => reject(transaction.error ?? new Error('清除识别缓存失败。'))
  })
}