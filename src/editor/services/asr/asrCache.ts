import type { AsrWord } from '../../core/asr'

/**
 * IndexedDB cache for per-asset word-level transcriptions. Mirrors the pattern
 * in `draftStore.ts`: one database, one object store, Promise-wrapped requests.
 * The cache key is built by `buildAsrCacheKey` (asset id + interval + provider
 * + language) so re-editing the timeline reuses transcribed material.
 */

const DB_NAME = 'framecut-asr'
const DB_VERSION = 1
const WORDS_STORE = 'words'

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
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开识别缓存数据库。'))
  })
  return databasePromise
}

async function withStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(WORDS_STORE, mode)
    const request = action(transaction.objectStore(WORDS_STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('识别缓存读写失败。'))
  })
}

export async function saveAsrWords(cacheKey: string, words: AsrWord[]): Promise<void> {
  await withStore('readwrite', (store) => store.put(words, cacheKey))
}

export async function loadAsrWords(cacheKey: string): Promise<AsrWord[] | null> {
  const words = await withStore<AsrWord[] | undefined>(
    'readonly',
    (store) => store.get(cacheKey),
  )
  return words ?? null
}

export async function clearAsrCache(): Promise<void> {
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(WORDS_STORE, 'readwrite')
    transaction.objectStore(WORDS_STORE).clear()
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('清除识别缓存失败。'))
  })
}