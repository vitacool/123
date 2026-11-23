import type { MediaAsset, Project } from '../core/types'
import { assetKindOf } from '../core/assets'
import type { ExportRange } from '../core/exportRange'
import { getProjectEnd } from '../core/timeline'
import { createId } from '../core/ids'
import {
  collectReferencedMediaIds,
  legacyProjectRecord,
  mediaIdsToDelete,
  projectThumbnail,
  sortProjectRecords,
  type DraftProjectRecord,
} from '../core/projectLibrary'
import { migrateDraftSnapshot } from '../core/draft'
import { normalizeProject } from '../core/normalizeProject'
import {
  normalizeDraftExportRange,
  normalizeMissingAssets,
  pruneProjectUrls,
  remapProjectUrls,
  type DraftAsset,
  type DraftSettings,
  type DraftSnapshot,
  type MissingAsset,
} from '../core/draft'
import { filterReferencedMissingAssets } from '../core/missingAssets'

const DB_NAME = 'framecut-drafts'
/** v1：单草稿（key = 'current'）。v2：多项目（key = id）。 */
const DB_VERSION = 2
const DRAFT_STORE = 'draft'
const MEDIA_STORE = 'media'
/** v1 里唯一草稿的固定 key（迁移时读取）。 */
const LEGACY_DRAFT_KEY = 'current'
/** 旧 store 升级不进行中的守卫：同一个 Promise 复用。 */
let databasePromise: Promise<IDBDatabase> | null = null

/**
 * 版本升级：
 * - 旧版（v1）的 draft store 没有 keyPath、固定 key 'current'；
 * - v2 改成 keyPath 'id' 的多项目记录，并把旧草稿迁成一条项目记录（用户数据不丢）。
 * 迁移映射本身是纯函数（core/projectLibrary.legacyProjectRecord），这里只做 IDB 编排。
 */
function upgradeDatabase(database: IDBDatabase, transaction: IDBTransaction, oldVersion: number): void {
  if (!database.objectStoreNames.contains(MEDIA_STORE)) {
    database.createObjectStore(MEDIA_STORE)
  }
  if (oldVersion < 2) {
    if (!database.objectStoreNames.contains(DRAFT_STORE)) {
      database.createObjectStore(DRAFT_STORE, { keyPath: 'id' })
      return
    }
    // 读旧草稿 → 删旧 store → 重建为多项目 store → 写入迁移记录（同一个升级事务里完成）。
    const legacy = transaction.objectStore(DRAFT_STORE)
    const request = legacy.get(LEGACY_DRAFT_KEY)
    request.onsuccess = () => {
      const snapshot = request.result as DraftSnapshot | undefined
      database.deleteObjectStore(DRAFT_STORE)
      const projects = database.createObjectStore(DRAFT_STORE, { keyPath: 'id' })
      if (snapshot) {
        projects.put(legacyProjectRecord(snapshot, createId('project')))
      }
    }
    request.onerror = () => {
      // 读不到旧数据也不能让新 store 缺失（否则整个草稿库都不可用）。
      database.deleteObjectStore(DRAFT_STORE)
      database.createObjectStore(DRAFT_STORE, { keyPath: 'id' })
    }
    return
  }
  if (!database.objectStoreNames.contains(DRAFT_STORE)) {
    database.createObjectStore(DRAFT_STORE, { keyPath: 'id' })
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise
  databasePromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前浏览器不支持 IndexedDB。'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = (event) => {
      upgradeDatabase(request.result, request.transaction!, event.oldVersion)
    }
    request.onsuccess = () => {
      const database = request.result
      // 其它标签页要升级时让路，避免阻塞。
      database.onversionchange = () => database.close()
      resolve(database)
    }
    request.onerror = () => {
      // 打开/升级失败后允许重试（否则会一直复用失败的结果）。
      databasePromise = null
      reject(request.error ?? new Error('无法打开草稿数据库。'))
    }
    request.onblocked = () => {
      // 另一个标签页还占着旧版本数据库：不阻塞当前流程，稍后重试即可。
    }
  })
  return databasePromise
}

/**
 * 在一个事务里执行一次读写，并把「成功」定义为**事务提交成功**。
 *
 * 为什么不能只听 `request.onsuccess`：写请求成功只代表这个请求进了事务队列，
 * 事务在提交阶段仍可能失败（最典型的是配额不足 → QuotaExceededError → abort）。
 * 那时 promise 已经 resolve，`reportDraftSaveFailure` 永远不会触发，用户以为存上了。
 * 所以这里是：请求成功先记下结果，`transaction.oncomplete` 才算成功；
 * `onabort` / `onerror` 一律 reject（含事务级错误）。
 */
async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase()
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(storeName, mode)
    let result!: T
    let settled = false
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      reject(error instanceof Error ? error : new Error(String(error ?? '草稿存储失败。')))
    }
    const request = action(transaction.objectStore(storeName))
    request.onsuccess = () => {
      result = request.result
    }
    request.onerror = () => fail(request.error ?? new Error('草稿存储失败。'))
    transaction.oncomplete = () => {
      if (settled) return
      settled = true
      resolve(result)
    }
    transaction.onabort = () =>
      fail(transaction.error ?? request.error ?? new Error('草稿写入被中止（可能是存储空间不足）。'))
    transaction.onerror = () =>
      fail(transaction.error ?? request.error ?? new Error('草稿存储失败。'))
  })
}

/** 保存（或更新）一条项目记录。 */
/**
 * 组装一条项目记录（两处保存路径共用）。
 *
 * 为什么必须只有一个实现：`flushProjectSave`（store 动作）和 VideoEditor 的防抖
 * 保存原来各写一份 `{ id, name, updatedAt, thumbnail, snapshot }`。任何一处改了字段
 * （例如新增 thumbnail 策略），另一处就会写出结构不同的记录。
 */
export function buildDraftRecord(
  state: {
    projectId: string | null
    projectName: string
    project: Project
    assets: MediaAsset[]
    missingAssets: MissingAsset[]
    source: { url: string } | null
    timelineZoom: number
    timelineSettings: { mainTrackMagnet: boolean; autoSnap: boolean; linkage: boolean; previewAxis: boolean }
    captionFollow: boolean
    exportRange: ExportRange | null
    playhead: number
  },
  options: { id?: string; name?: string; updatedAt?: number } = {},
): DraftProjectRecord | null {
  const id = options.id ?? state.projectId
  // 没有项目身份（从未有内容的新会话）不落盘，避免列表里堆满空项目。
  if (!id) return null
  const snapshot = toDraftSnapshot(state)
  return {
    id,
    name: options.name ?? state.projectName,
    updatedAt: options.updatedAt ?? Date.now(),
    thumbnail: projectThumbnail(snapshot),
    snapshot,
  }
}

/**
 * 保存操作的串行队列（按项目 id 分组）。
 *
 * 现状问题：VideoEditor 的保存是"先 await 查记录数/是否存在，再 saveProjectRecord"，
 * 两次 await 之间可能被下一次防抖触发插进来 —— 旧快照反而后写，覆盖新快照。
 *
 * 这里的规则：
 * - 同一个 id 的保存**串行**执行（不会并发写同一条记录）；
 * - 每次请求带一个递增序号，只有序号最新的一次才真正落盘（旧请求被丢弃）；
 *   这样即使排队时快照已经过期，也不会用旧数据覆盖新数据。
 */
const saveSequences = new Map<string, number>()
const saveQueues = new Map<string, Promise<void>>()

export interface SerializedSaveOptions {
  /**
   * 落盘前的最后校验（例如数量上限检查）。返回 false 表示放弃这次保存。
   * 它在队列内部执行，因此不会与同 id 的其它保存交叠。
   */
  beforeSave?: () => Promise<boolean>
}

/**
 * 串行保存一条项目记录（同一项目 id 不并发，旧序号自动丢弃）。
 * 返回的 Promise 在该次写入（或被丢弃/放弃）后 resolve。
 */
export async function saveProjectRecordSerialized(
  record: DraftProjectRecord,
  options: SerializedSaveOptions = {},
): Promise<{ written: boolean }> {
  const sequence = (saveSequences.get(record.id) ?? 0) + 1
  saveSequences.set(record.id, sequence)

  const previous = saveQueues.get(record.id) ?? Promise.resolve()
  let releaseCurrent!: () => void
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve
  })
  saveQueues.set(record.id, previous.then(() => current).catch(() => undefined))

  try {
    await previous.catch(() => undefined)
    // 排队期间已经有更新的保存请求：这一次直接丢弃（旧快照绝不能覆盖新快照）。
    if ((saveSequences.get(record.id) ?? 0) !== sequence) {
      return { written: false }
    }
    if (options.beforeSave && !(await options.beforeSave())) {
      return { written: false }
    }
    // 校验期间可能又来了新请求，再检查一次。
    if ((saveSequences.get(record.id) ?? 0) !== sequence) {
      return { written: false }
    }
    await saveProjectRecord(record)
    return { written: true }
  } finally {
    // 释放队尾：让下一个同 id 的保存开始。
    releaseCurrent()
  }
}

export async function saveProjectRecord(record: DraftProjectRecord): Promise<void> {
  await withStore(DRAFT_STORE, 'readwrite', (store) => store.put(record))
  // 正常落盘成功 → 清掉可能残留的「紧急快照」，避免下次又用旧快照覆盖。
  clearEmergencyDraft(record.id)
}

/**
 * 页面关闭时的「紧急快照」：写 localStorage（**同步**），下次启动回放。
 *
 * 为什么不能只靠 IndexedDB：`pagehide` / `visibilitychange(hidden)` 确实会触发，
 * 但 IDB 写事务是异步的，页面卸载时会被中止 —— 实测「编辑后立刻刷新」仍然丢改动。
 * localStorage 是同步 API，在卸载期间可靠。
 *
 * 只在页面即将消失时写，且大小受限（草稿快照通常 < 1MB，这里上限 2MB，超了放弃），
 * 避免把项目 JSON 常驻在 localStorage 里挤占宿主的配额。
 */
const EMERGENCY_PREFIX = 'framecut:draft-pending:'
const EMERGENCY_MAX_CHARS = 2_000_000

/**
 * 安全拿到 localStorage。隐私模式 / 被策略禁用时，**访问这个全局属性本身**就可能抛错
 * （不是返回 undefined），所以连 `typeof localStorage` 都要放进 try 里。
 */
function safeStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

export function writeEmergencyDraft(record: DraftProjectRecord | null): boolean {
  const storage = safeStorage()
  if (!record || !storage) return false
  try {
    const json = JSON.stringify(record)
    if (json.length > EMERGENCY_MAX_CHARS) return false
    storage.setItem(EMERGENCY_PREFIX + record.id, json)
    return true
  } catch {
    // 配额不足 / 隐私模式禁用 localStorage：放弃，正常保存路径仍然有效。
    return false
  }
}

function readEmergencyDraft(id: string): DraftProjectRecord | null {
  const storage = safeStorage()
  if (!storage) return null
  try {
    const raw = storage.getItem(EMERGENCY_PREFIX + id)
    if (!raw) return null
    const parsed = JSON.parse(raw) as DraftProjectRecord
    return parsed && typeof parsed.id === 'string' ? parsed : null
  } catch {
    return null
  }
}

/** 清掉某个（或全部）紧急快照。 */
export function clearEmergencyDraft(id?: string): void {
  const storage = safeStorage()
  if (!storage) return
  try {
    if (id) {
      storage.removeItem(EMERGENCY_PREFIX + id)
      return
    }
    const keys: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key?.startsWith(EMERGENCY_PREFIX)) keys.push(key)
    }
    for (const key of keys) storage.removeItem(key)
  } catch {
    // best-effort
  }
}

/** 列出全部紧急快照（仅 id 与记录本身）。 */
function listEmergencyDrafts(): DraftProjectRecord[] {
  const storage = safeStorage()
  if (!storage) return []
  const out: DraftProjectRecord[] = []
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (!key?.startsWith(EMERGENCY_PREFIX)) continue
      const record = readEmergencyDraft(key.slice(EMERGENCY_PREFIX.length))
      if (record) out.push(record)
    }
  } catch {
    // best-effort
  }
  return out
}

/** 列出全部项目记录（最近更新在前）。 */
export async function loadProjectRecords(): Promise<DraftProjectRecord[]> {
  const records = await withStore<DraftProjectRecord[]>(
    DRAFT_STORE,
    'readonly',
    (store) => store.getAll(),
  )
  /**
   * 用「紧急快照」覆盖更新的那条：上一次会话在防抖窗口内被关掉/刷新时，
   * 改动只存在于 localStorage 里（IDB 写事务被卸载中止）。
   */
  const byId = new Map((records ?? []).map((record) => [record.id, record]))
  for (const draft of listEmergencyDrafts()) {
    const existing = byId.get(draft.id)
    if (!existing || (draft.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
      byId.set(draft.id, draft)
    }
  }
  return sortProjectRecords([...byId.values()])
}

/** 读取单个项目记录。 */
export async function loadProjectRecord(id: string): Promise<DraftProjectRecord | null> {
  const record = await withStore<DraftProjectRecord | undefined>(
    DRAFT_STORE,
    'readonly',
    (store) => store.get(id),
  )
  const emergency = readEmergencyDraft(id)
  if (emergency && (!record || (emergency.updatedAt ?? 0) > (record.updatedAt ?? 0))) {
    return emergency
  }
  return record ?? null
}

/** 该项目是否已经存在（用于上限判定，避免把更新当成新增）。 */
export async function hasProjectRecord(id: string): Promise<boolean> {
  const key = await withStore<IDBValidKey | undefined>(
    DRAFT_STORE,
    'readonly',
    (store) => store.getKey(id),
  )
  return key !== undefined
}

/** 项目总数。 */
export async function countProjectRecords(): Promise<number> {
  return withStore<number>(DRAFT_STORE, 'readonly', (store) => store.count())
}

/** media store 里的全部 blob id。 */
export async function listMediaIds(): Promise<string[]> {
  const keys = await withStore<IDBValidKey[]>(MEDIA_STORE, 'readonly', (store) =>
    store.getAllKeys(),
  )
  return (keys ?? []).map((key) => String(key))
}

/**
 * 删除一个项目：同时回收「不再被任何项目引用」的媒体 blob。
 * 返回被回收的 blob id（用于日志/提示）。
 */
export async function deleteDraftProject(id: string): Promise<string[]> {
  await withStore(DRAFT_STORE, 'readwrite', (store) => store.delete(id))
  const records = await loadProjectRecords()
  const referenced = collectReferencedMediaIds(records)
  const stored = await listMediaIds()
  const removable = mediaIdsToDelete(stored, referenced)
  for (const mediaId of removable) {
    await deleteMediaBlob(mediaId).catch(() => undefined)
  }
  return removable
}

/**
 * 只有「没有任何项目再引用」时才删除 blob。
 *
 * - `stillReferenced`：当前会话里仍然存在的素材 id（内存态可能比存储里的快照新）；
 * - `exceptProjectId`：当前项目的存储快照是旧的，判定时排除它、改用上面的实时集合，
 *   否则会把「刚删掉素材但草稿还没保存」的旧引用当成仍在引用而永远不回收。
 */
export async function deleteMediaBlobIfUnreferenced(
  assetId: string,
  options: { exceptProjectId?: string | null; stillReferenced?: Iterable<string> } = {},
): Promise<boolean> {
  if (new Set(options.stillReferenced ?? []).has(assetId)) return false
  const records = await loadProjectRecords()
  const referenced = collectReferencedMediaIds(records, {
    exceptProjectId: options.exceptProjectId ?? null,
  })
  if (referenced.has(assetId)) return false
  await deleteMediaBlob(assetId)
  return true
}

export async function saveMediaBlob(id: string, blob: Blob): Promise<void> {
  await withStore(MEDIA_STORE, 'readwrite', (store) => store.put(blob, id))
}

/** 素材 Blob 写入失败提示的全局去重时间戳（30s 内只提示一次，批量导入不刷屏）。 */
let lastMediaSaveErrorAt = 0

/**
 * 素材 Blob 写入 IndexedDB 失败（配额不足最常见）时的可见提示。
 *
 * 必须提示、不能静默：素材此刻还在内存里，界面看上去一切正常，但刷新后
 * restoreDraft 找不到 Blob，会直接剔除素材和引用它的片段。
 */
export function reportMediaSaveFailure(
  notify?: (message: string, kind?: 'info' | 'success' | 'warning' | 'error') => void,
): void {
  if (!notify) return
  const now = Date.now()
  if (now - lastMediaSaveErrorAt < 30_000) return
  lastMediaSaveErrorAt = now
  notify('素材未能保存，刷新后将丢失', 'error')
}

/**
 * 把导入进来的本地素材写进 IndexedDB。
 *
 * 为什么必须只有一个实现：工程文件（以及宿主 `loadProject` 传入的工程）只有素材
 * 元信息，没有任何 Blob —— 重新选择出来的 Blob 只在这一刻存在于内存里。漏写一次，
 * 刷新后 restoreDraft 在 media store 里查不到 Blob，就会跳过该素材并剔除引用它的
 * 片段，用户看到的是「素材全部不可用、片段全没了」。拖拽导入、工程文件导入、宿主
 * API 三条路径都走这里，避免以后新增入口时再漏。
 *
 * 单个素材写失败不阻断本次会话（素材仍在内存里可继续编辑），但会汇总提示一次。
 */
export async function persistImportedAssets(
  assets: Iterable<MediaAsset>,
  options: {
    notify?: (message: string, kind?: 'info' | 'success' | 'warning' | 'error') => void
  } = {},
): Promise<{ saved: number; failed: number }> {
  const pending = [...assets].filter((asset) => Boolean(asset.file))
  const results = await Promise.allSettled(
    pending.map(async (asset) => {
      await saveMediaBlob(asset.id, asset.file as Blob)
    }),
  )
  let saved = 0
  let failed = 0
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      saved += 1
      return
    }
    failed += 1
    console.warn(`[FrameCut] 素材未能保存到本地：${pending[index].name}`, result.reason)
  })
  if (failed > 0) reportMediaSaveFailure(options.notify)
  return { saved, failed }
}

/** 草稿保存失败提示的全局去重时间戳（30s 内只提示一次，批量导入不刷屏）。 */
let lastDraftSaveErrorAt = 0

/** 草稿写入 IndexedDB 失败时给出可见提示（配额不足是最常见原因）。 */
export function reportDraftSaveFailure(
  notify: (message: string, kind?: 'info' | 'success' | 'warning' | 'error') => void,
): void {
  const now = Date.now()
  if (now - lastDraftSaveErrorAt < 30_000) return
  lastDraftSaveErrorAt = now
  notify('草稿保存失败，可能是浏览器存储空间不足', 'warning')
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

export interface RestoredDraft {
  project: Project
  assets: MediaAsset[]
  /** 工程引用、但本地没有 Blob 的素材（占位片段）。 */
  missingAssets: MissingAsset[]
  source: MediaAsset | null
  timelineZoom: number
  timelineSettings: DraftSettings
  playhead: number
}

/**
 * Rebuilds object URLs for locally stored media, remaps every `sourceUrl`, and
 * prunes clips whose media is no longer available.
 */
export async function restoreDraft(input: unknown): Promise<RestoredDraft | null> {
  // 外壳先迁移（version 缺失按 v1、timelineSettings/zoom/playhead 缺失填默认值），
  // 再走统一的工程归一化链（含智能字幕 link 迁移）。
  const migrated = migrateDraftSnapshot(input)
  const snapshot = migrated.snapshot
  const assets: MediaAsset[] = []
  const urlMap = new Map<string, string>()
  /** 本次为 blob 新建的 objectURL：失败路径必须回收，否则会一直占着内存。 */
  const createdUrls: string[] = []
  let succeeded = false

  try {
    for (const meta of snapshot.assets) {
      const local = meta.local === true || meta.url.startsWith('blob:')
      let url = meta.url
      let blob: Blob | undefined
      if (local) {
        blob = await loadMediaBlob(meta.id)
        if (!blob) continue
        url = URL.createObjectURL(blob)
        createdUrls.push(url)
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
        // 旧草稿可能没有 kind：用统一判定补回，避免「音频被加到主轨 / 跑进视频 Tab」。
        kind: assetKindOf(meta),
        hasAudio: meta.hasAudio,
        thumbnail: meta.thumbnail,
        ...(meta.reversedFrom ? { reversedFrom: meta.reversedFrom } : {}),
        file: blob instanceof File ? blob : undefined,
      })
    }

    const available = new Set(assets.map((asset) => asset.url))
    const assetIdByUrl = new Map<string, string>()
    for (const meta of snapshot.assets) assetIdByUrl.set(meta.url, meta.id)
    const normalized = normalizeProject(snapshot.project, { assetIdByUrl }).project
    // 缺失素材的片段保留为占位（「素材已移除」），不再因为找不到 Blob 被剔除。
    const missingAssets = filterReferencedMissingAssets(
      normalizeMissingAssets(snapshot.missingAssets).filter(
        (item) => !urlMap.has(item.url) && !available.has(item.url),
      ),
      normalized,
    )
    const keepUrls = new Set(missingAssets.map((item) => item.url))
    const project = pruneProjectUrls(remapProjectUrls(normalized, urlMap), available, { keepUrls })

    // 没有 Blob 不等于「不可恢复」：占位片段（素材缺失）也要能打开。
    // 时间轴为空也不是「不可恢复」：素材可能只是导入了、还没拖进时间轴
    // （典型：只导入音频、还没建任何片段）。真正的「全空」才判 null。
    if (assets.length === 0 && getProjectEnd(project) <= 0) return null

    const sourceUrl = snapshot.sourceUrl
      ? urlMap.get(snapshot.sourceUrl) ?? snapshot.sourceUrl
      : null
    const videoAssets = assets.filter((asset) => asset.kind !== 'audio')
    const source =
      (sourceUrl ? assets.find((asset) => asset.url === sourceUrl) : null) ??
      videoAssets[0] ??
      null

    succeeded = true
    return {
      project,
      assets,
      missingAssets: filterReferencedMissingAssets(missingAssets, project),
      source,
      timelineZoom: snapshot.timelineZoom,
      timelineSettings: {
        ...snapshot.timelineSettings,
        // 旧草稿没有导出区间 → null（导出全部）；素材被剔除后工程变短 → 夹回有效范围。
        exportRange: normalizeDraftExportRange(
          snapshot.timelineSettings.exportRange,
          getProjectEnd(project),
        ),
      },
      playhead: snapshot.playhead,
    }
  } finally {
    // 返回 null 或中途抛错时，本函数建的 objectURL 全部回收（调用方拿不到它们）。
    if (!succeeded) {
      for (const url of createdUrls) URL.revokeObjectURL(url)
    }
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
    ...(asset.reversedFrom ? { reversedFrom: asset.reversedFrom } : {}),
    local,
  }
}

export function toDraftSnapshot(state: {
  project: Project
  assets: MediaAsset[]
  missingAssets?: MissingAsset[]
  source: { url: string } | null
  timelineZoom: number
  timelineSettings: Omit<DraftSettings, 'captionFollow'>
  captionFollow: boolean
  exportRange: ExportRange | null
  playhead: number
}): DraftSnapshot {
  return {
    version: 1,
    project: state.project,
    assets: state.assets.map(toDraftAsset),
    // 缺失素材（占位片段）随草稿保存，刷新后片段不会消失。
    ...(state.missingAssets && state.missingAssets.length > 0
      ? { missingAssets: state.missingAssets }
      : {}),
    sourceUrl: state.source?.url ?? null,
    timelineZoom: state.timelineZoom,
    timelineSettings: {
      ...state.timelineSettings,
      captionFollow: state.captionFollow,
      exportRange: state.exportRange,
    },
    playhead: state.playhead,
    updatedAt: Date.now(),
  }
}