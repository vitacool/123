import type { MediaAsset, Project } from '../core/types'
import {
  migrateCaptionLinks,
  normalizeProjectColors,
  pruneProjectUrls,
  remapProjectUrls,
  type DraftAsset,
  type DraftSettings,
  type DraftSnapshot,
} from '../core/draft'

const DB_NAME = 'framecut-drafts'
const DB_VERSION = 1
const DRAFT_STORE = 'draft'
const MEDIA_STORE = 'media'
const DRAFT_KEY = 'current'

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
      if (!database.objectStoreNames.contains(DRAFT_STORE)) {
        database.createObjectStore(DRAFT_STORE)
      }
      if (!database.objectStoreNames.contains(MEDIA_STORE)) {
        database.createObjectStore(MEDIA_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开草稿数据库。'))
  })
  return databasePromise
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode)
    const request = action(transaction.objectStore(storeName))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('草稿存储失败。'))
  })
}

export async function saveDraft(snapshot: DraftSnapshot): Promise<void> {
  await withStore(DRAFT_STORE, 'readwrite', (store) => store.put(snapshot, DRAFT_KEY))
}

export async function loadDraftSnapshot(): Promise<DraftSnapshot | null> {
  const snapshot = await withStore<DraftSnapshot | undefined>(
    DRAFT_STORE,
    'readonly',
    (store) => store.get(DRAFT_KEY),
  )
  return snapshot ?? null
}

export async function saveMediaBlob(id: string, blob: Blob): Promise<void> {
  await withStore(MEDIA_STORE, 'readwrite', (store) => store.put(blob, id))
}

export async function loadMediaBlob(id: string): Promise<Blob | undefined> {
  return withStore<Blob | undefined>(MEDIA_STORE, 'readonly', (store) => store.get(id))
}

/**
 * 从 IndexedDB 的 media store 删除某个素材的 Blob。
 * 素材被从素材库移除时调用；这一步不可撤销（撤销只恢复时间轴状态）。
 */
export async function deleteMediaBlob(id: string): Promise<void> {
  await withStore(MEDIA_STORE, 'readwrite', (store) => store.delete(id))
}

export async function clearDraft(): Promise<void> {
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction([DRAFT_STORE, MEDIA_STORE], 'readwrite')
    transaction.objectStore(DRAFT_STORE).delete(DRAFT_KEY)
    transaction.objectStore(MEDIA_STORE).clear()
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('清除草稿失败。'))
  })
}

export interface RestoredDraft {
  project: Project
  assets: MediaAsset[]
  source: MediaAsset | null
  timelineZoom: number
  timelineSettings: DraftSettings
  playhead: number
}

/**
 * Rebuilds object URLs for locally stored media, remaps every `sourceUrl`, and
 * prunes clips whose media is no longer available.
 */
export async function restoreDraft(snapshot: DraftSnapshot): Promise<RestoredDraft | null> {
  const assets: MediaAsset[] = []
  const urlMap = new Map<string, string>()

  for (const meta of snapshot.assets) {
    const local = meta.local === true || meta.url.startsWith('blob:')
    let url = meta.url
    let blob: Blob | undefined
    if (local) {
      blob = await loadMediaBlob(meta.id)
      if (!blob) continue
      url = URL.createObjectURL(blob)
    }
    urlMap.set(meta.url, url)
    assets.push({
      id: meta.id,
      url,
      name: meta.name,
      size: meta.size,
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      kind: meta.kind,
      hasAudio: meta.hasAudio,
      thumbnail: meta.thumbnail,
      file: blob instanceof File ? blob : undefined,
    })
  }

  if (assets.length === 0) return null

  const available = new Set(assets.map((asset) => asset.url))
  const assetIdByUrl = new Map<string, string>()
  for (const meta of snapshot.assets) assetIdByUrl.set(meta.url, meta.id)
  let project = migrateCaptionLinks(normalizeProjectColors(snapshot.project), assetIdByUrl)
  project = pruneProjectUrls(remapProjectUrls(project, urlMap), available)
  if (project.clips.length === 0 && (project.audioTracks ?? []).length === 0) {
    // Keep overlay-only drafts alive; only reject a fully empty timeline.
    if ((project.overlayTracks ?? []).length === 0) return null
  }

  const sourceUrl = snapshot.sourceUrl
    ? urlMap.get(snapshot.sourceUrl) ?? snapshot.sourceUrl
    : null
  const videoAssets = assets.filter((asset) => asset.kind !== 'audio')
  const source =
    (sourceUrl ? assets.find((asset) => asset.url === sourceUrl) : null) ??
    videoAssets[0] ??
    null

  // Drop clips whose source asset never came back.
  project = pruneProjectUrls(project, available)

  return {
    project,
    assets,
    source,
    timelineZoom: snapshot.timelineZoom,
    timelineSettings: snapshot.timelineSettings,
    playhead: snapshot.playhead,
  }
}

export function toDraftAsset(asset: MediaAsset): DraftAsset {
  const local = asset.url.startsWith('blob:') || Boolean(asset.file)
  return {
    id: asset.id,
    url: asset.url,
    name: asset.name,
    size: asset.size,
    duration: asset.duration,
    width: asset.width,
    height: asset.height,
    kind: asset.kind,
    hasAudio: asset.hasAudio,
    thumbnail: asset.thumbnail,
    local,
  }
}

export function toDraftSnapshot(state: {
  project: Project
  assets: MediaAsset[]
  source: { url: string } | null
  timelineZoom: number
  timelineSettings: Omit<DraftSettings, 'captionFollow'>
  captionFollow: boolean
  playhead: number
}): DraftSnapshot {
  return {
    version: 1,
    project: state.project,
    assets: state.assets.map(toDraftAsset),
    sourceUrl: state.source?.url ?? null,
    timelineZoom: state.timelineZoom,
    timelineSettings: { ...state.timelineSettings, captionFollow: state.captionFollow },
    playhead: state.playhead,
    updatedAt: Date.now(),
  }
}