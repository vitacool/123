import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { createInitialProject } from '../src/editor/core/operations'
import { createEditorStore } from '../src/editor/store/editorStore'
import { createFrameCutApi, applyProjectToStore } from '../src/editor/api'
import { pruneProjectUrls } from '../src/editor/core/draft'
import type { DraftSettings, DraftSnapshot, MissingAsset } from '../src/editor/core/draft'
import type { Project } from '../src/editor/core/types'
import {
  createProjectFile,
  parseProjectFile,
  serializeProjectFile,
} from '../src/editor/projectFile'

/**
 * 「跳过缺失素材」后的占位片段：
 * - 不再被 pruneProjectUrls 剔除；
 * - 片段以「素材已移除」显示（Timeline 已有该状态），预览跳过、导出为背景；
 * - 缺失素材元信息随草稿/工程文件持久化，刷新后占位仍在。
 */

type DraftStoreModule = typeof import('../src/editor/services/draftStore')

const SETTINGS: DraftSettings = {
  mainTrackMagnet: false,
  autoSnap: true,
  linkage: false,
  previewAxis: false,
  captionFollow: false,
  exportRange: null,
}

const ORIGIN = { url: 'blob:origin', duration: 6 }

const missing: MissingAsset[] = [{ url: ORIGIN.url, name: 'clip.mp4', kind: 'video', duration: 6 }]

function projectWithTwoClips(): Project {
  const base = createInitialProject(ORIGIN, 'clip-1')
  return {
    ...base,
    clips: [base.clips[0], { ...base.clips[0], id: 'clip-2', sourceStart: 3, sourceEnd: 6 }],
  }
}

async function reopen(
  snapshot: unknown,
): Promise<{ drafts: DraftStoreModule; restored: Awaited<ReturnType<DraftStoreModule['restoreDraft']>> }> {
  vi.resetModules()
  const drafts = await import('../src/editor/services/draftStore')
  const restored = await drafts.restoreDraft(snapshot)
  return { drafts, restored }
}

beforeEach(() => {
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  vi.resetModules()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('pruneProjectUrls：保留占位', () => {
  it('默认剔除缺失素材的片段（旧行为不变）', () => {
    const project = projectWithTwoClips()
    const pruned = pruneProjectUrls(project, new Set())
    expect(pruned.clips).toHaveLength(0)
  })

  it('keepUrls 中的片段保留（占位）', () => {
    const project = projectWithTwoClips()
    const pruned = pruneProjectUrls(project, new Set(), { keepUrls: [ORIGIN.url] })
    expect(pruned.clips.map((clip) => clip.id)).toEqual(['clip-1', 'clip-2'])
    expect(pruned.audioTracks).toEqual([])
  })
})

describe('applyProjectToStore：缺失素材保留为占位', () => {
  it('未提供文件时片段保留，missingAssets 写入 store', () => {
    const store = createEditorStore()
    const result = applyProjectToStore(store, {
      project: projectWithTwoClips(),
      missingAssets: missing,
    })

    expect(result.assetCount).toBe(0)
    expect(result.missingCount).toBe(1)
    expect(result.removedClips).toBe(0)
    expect(store.getState().project.clips.map((clip) => clip.id)).toEqual(['clip-1', 'clip-2'])
    expect(store.getState().assets).toEqual([])
    expect(store.getState().missingAssets).toEqual(missing)
  })
})

describe('占位片段跨刷新保留', () => {
  it('保存 → 重新打开：片段与 missingAssets 都恢复', async () => {
    const store = createEditorStore()
    applyProjectToStore(store, { project: projectWithTwoClips(), missingAssets: missing })

    const drafts: DraftStoreModule = await import('../src/editor/services/draftStore')
    const record = drafts.buildDraftRecord(store.getState())
    expect(record).not.toBeNull()
    expect(record!.snapshot.missingAssets).toEqual(missing)
    await drafts.saveProjectRecord(record!)

    const { restored } = await reopen(record!.snapshot)
    expect(restored, '只有占位片段的工程也必须能打开').not.toBeNull()
    expect(restored!.assets).toEqual([])
    expect(restored!.project.clips.map((clip) => clip.id)).toEqual(['clip-1', 'clip-2'])
    expect(restored!.missingAssets).toEqual(missing)
  })

  it('再次自动保存后缺失素材不会丢（占位不会在第二次刷新后消失）', async () => {
    const store = createEditorStore()
    applyProjectToStore(store, { project: projectWithTwoClips(), missingAssets: missing })
    const drafts: DraftStoreModule = await import('../src/editor/services/draftStore')
    const record = drafts.buildDraftRecord(store.getState())
    await drafts.saveProjectRecord(record!)

    const { restored } = await reopen(record!.snapshot)
    const nextStore = createEditorStore()
    // 真实流程里 openProjectRecord 先 adoptProject(record.id) 再 hydrate。
    nextStore.getState().adoptProject(record!.id, record!.name)
    nextStore.getState().hydrateDraft(restored!)
    const second = drafts.buildDraftRecord(nextStore.getState())
    expect(second!.snapshot.missingAssets).toEqual(missing)
  })

  it('没有缺失素材的旧草稿仍然正常（missingAssets 缺省为空数组）', async () => {
    const store = createEditorStore()
    // 远程 URL 不需要 Blob，能正常恢复；用来验证 missingAssets 字段缺省时不报错。
    store.getState().loadSource({
      url: 'https://example.com/clip.mp4',
      name: 'clip.mp4',
      size: 1,
      duration: 6,
      width: 320,
      height: 180,
    })
    const drafts: DraftStoreModule = await import('../src/editor/services/draftStore')
    const record = drafts.buildDraftRecord(store.getState())
    // 手动去掉字段，模拟旧草稿
    const snapshot = { ...record!.snapshot } as DraftSnapshot & { missingAssets?: unknown }
    delete snapshot.missingAssets
    await drafts.saveProjectRecord({ ...record!, snapshot })

    const { restored } = await reopen(snapshot)
    expect(restored!.missingAssets).toEqual([])
  })
})

describe('宿主 API loadProject：未提供文件时也保留占位', () => {
  it('缺失片段保留，并写入 missingAssets', async () => {
    const store = createEditorStore()
    const api = createFrameCutApi({ store })

    await api.loadProject(projectWithTwoClips())
    expect(store.getState().project.clips.map((clip) => clip.id)).toEqual(['clip-1', 'clip-2'])
    expect(store.getState().missingAssets).toEqual([
      { url: ORIGIN.url, name: '本地视频' },
    ])
  })
})

describe('工程文件：missingAssets 往返', () => {
  it('导出/导入保留缺失素材元信息', () => {
    const file = createProjectFile({
      project: projectWithTwoClips(),
      assets: [],
      missingAssets: missing,
      sourceUrl: null,
      timelineZoom: 92,
      timelineSettings: SETTINGS,
      playhead: 0,
    })
    const parsed = parseProjectFile(serializeProjectFile(file))
    expect(parsed.missingAssets).toEqual(missing)
  })

  it('旧工程文件没有 missingAssets → 解析为空数组（向后兼容）', () => {
    const legacy = JSON.stringify({
      kind: 'framecut-project',
      version: 1,
      project: { clips: [] },
    })
    expect(parseProjectFile(legacy).missingAssets).toEqual([])
  })
})