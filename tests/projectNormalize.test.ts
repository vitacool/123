import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { createId, isLegacyShortId } from '../src/editor/core/ids'
import { migrateDraftSnapshot, DRAFT_SCHEMA_VERSION } from '../src/editor/core/draft'
import type { DraftSettings, DraftSnapshot } from '../src/editor/core/draft'
import {
  PROJECT_SCHEMA_VERSION,
  normalizeProject,
} from '../src/editor/core/normalizeProject'
import { createInitialProject } from '../src/editor/core/operations'
import type { DraftProjectRecord } from '../src/editor/core/projectLibrary'
import type { Project } from '../src/editor/core/types'

/**
 * 工程归一化 / 草稿校验：
 * 1. 旧草稿缺字段（version / timelineSettings / timelineZoom / playhead）不抛错、不出 NaN；
 * 2. 非法片段被修正或丢弃并留下警告；
 * 3. 两条加载路径结果一致（宿主 API 路径也要迁移智能字幕 link）；
 * 4. 并发保存不乱序、旧快照不覆盖新快照；
 * 5. id 有足够熵，且旧短 id 仍被接受。
 */

const SOURCE = {
  url: 'blob:u1',
  name: 'clip.mp4',
  size: 1024,
  duration: 10,
  width: 640,
  height: 360,
}

const clip = (overrides: Record<string, unknown> = {}) => ({
  id: 'c1',
  sourceUrl: 'blob:u1',
  sourceStart: 0,
  sourceEnd: 3,
  type: 'video',
  rotation: 0,
  flipH: false,
  flipV: false,
  crop: { x: 0, y: 0, w: 1, h: 1 },
  scale: 1,
  position: { x: 0, y: 0 },
  ...overrides,
})

const projectOf = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  aspectRatio: '16:9',
  clips: [clip()],
  markers: [],
  exportQuality: { resolution: '480p', fps: 30 },
  ...overrides,
})

const SETTINGS: DraftSettings = {
  mainTrackMagnet: false,
  autoSnap: true,
  linkage: false,
  previewAxis: true,
  captionFollow: true,
  exportRange: null,
}

// ---------------------------------------------------------------- 结构校验

describe('normalizeProject：缺字段与非法值', () => {
  it('缺 type / markers 的 v1 工程会被迁移（并记录警告）', () => {
    const { project, warnings, fromVersion } = normalizeProject({
      aspectRatio: '16:9',
      clips: [clip({ type: undefined })],
      exportQuality: { resolution: '480p', fps: 30 },
    })
    expect(fromVersion).toBe(1)
    expect(project.clips[0].type).toBe('video')
    expect(project.markers).toEqual([])
    expect(warnings.some((warning) => warning.code === 'migration-applied')).toBe(true)
  })

  it('sourceStart >= sourceEnd 被修正为合法区间，并留下警告', () => {
    const { project, warnings } = normalizeProject(
      projectOf({ clips: [clip({ sourceStart: 5, sourceEnd: 5 })] }),
    )
    const fixed = project.clips[0]
    expect(fixed.sourceEnd).toBeGreaterThan(fixed.sourceStart)
    expect(warnings.some((warning) => warning.code === 'clip-repaired' && warning.id === 'c1')).toBe(
      true,
    )
  })

  it('缺 sourceUrl / 缺 id 的片段被丢弃，其它片段保留', () => {
    const { project, warnings } = normalizeProject(
      projectOf({
        clips: [
          clip({ id: 'ok' }),
          clip({ id: 'no-url', sourceUrl: '' }),
          { sourceUrl: 'blob:u2', sourceStart: 0, sourceEnd: 1 },
          'not-an-object',
        ],
      }),
    )
    expect(project.clips.map((c) => c.id)).toEqual(['ok'])
    expect(warnings.filter((warning) => warning.code === 'clip-dropped').length).toBeGreaterThanOrEqual(2)
  })

  it('缺省字段填默认值（crop 完整、scale 1、position 0）', () => {
    const { project } = normalizeProject(
      projectOf({
        clips: [
          {
            id: 'bare',
            sourceUrl: 'blob:u1',
            sourceStart: 0,
            sourceEnd: 2,
          },
        ],
      }),
    )
    const bare = project.clips[0]
    expect(bare.type).toBe('video')
    expect(bare.crop).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expect(bare.scale).toBe(1)
    expect(bare.position).toEqual({ x: 0, y: 0 })
    expect(bare.rotation).toBe(0)
  })

  it('完全非法输入不抛错，返回空工程', () => {
    const { project, warnings } = normalizeProject(null)
    expect(project.clips).toEqual([])
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('版本高于当前支持时只校验、不迁移，并给出未知版本警告', () => {
    const { fromVersion, warnings } = normalizeProject({
      ...projectOf(),
      schemaVersion: PROJECT_SCHEMA_VERSION + 5,
    })
    expect(fromVersion).toBe(PROJECT_SCHEMA_VERSION + 5)
    expect(warnings.some((warning) => warning.code === 'unknown-version')).toBe(true)
  })
})

// ---------------------------------------------------------------- 智能字幕 link

describe('两条加载路径一致：智能字幕 link 迁移', () => {
  const projectWithCaption = (): Record<string, unknown> =>
    projectOf({
      textTracks: [
        {
          id: 't1',
          name: '字幕',
          clips: [
            {
              id: 'cap1',
              text: '你好',
              start: 0,
              end: 2,
              x: 0.5,
              y: 0.8,
              fontSize: 0.05,
              link: { sourceUrl: 'blob:u1', start: 0, end: 2 },
            },
          ],
        },
      ],
    })

  it('传 assetIdByUrl 时 link.assetId 被补齐（原来 api 路径漏了这一步）', () => {
    const assetIdByUrl = new Map([['blob:u1', 'asset-1']])
    const { project } = normalizeProject(projectWithCaption(), { assetIdByUrl })
    const caption = project.textTracks?.[0]?.clips[0]
    expect(caption?.link?.assetId).toBe('asset-1')
  })

  it('不传 assetIdByUrl 时 link 原样保留（不误改）', () => {
    const { project } = normalizeProject(projectWithCaption())
    const caption = project.textTracks?.[0]?.clips[0]
    expect(caption?.link?.assetId).toBeUndefined()
    expect(caption?.link?.sourceUrl).toBe('blob:u1')
  })
})

// ---------------------------------------------------------------- 草稿快照迁移

describe('migrateDraftSnapshot：旧草稿缺字段不抛错、不出 NaN', () => {
  it('version 缺失按 v1 处理，并补默认设置', () => {
    const result = migrateDraftSnapshot({
      project: projectOf(),
      assets: [],
      sourceUrl: null,
      // 没有 version / timelineSettings / timelineZoom / playhead
    })
    expect(result.fromVersion).toBe(1)
    expect(result.snapshot.version).toBe(DRAFT_SCHEMA_VERSION)
    expect(result.snapshot.timelineSettings).toEqual({
      mainTrackMagnet: false,
      autoSnap: true,
      linkage: false,
      previewAxis: true,
      captionFollow: true,
      exportRange: null,
    })
    // 关键：不能是 NaN（NaN 会被 clamp 原样传下去，污染整个界面）
    expect(Number.isFinite(result.snapshot.timelineZoom)).toBe(true)
    expect(Number.isFinite(result.snapshot.playhead)).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('version'))).toBe(true)
  })

  it('timelineSettings 缺失时不会抛错（原来会 throw 然后被上层静默吞掉）', () => {
    expect(() =>
      migrateDraftSnapshot({ project: projectOf(), assets: [], timelineZoom: 40, playhead: 2 }),
    ).not.toThrow()
    const { snapshot } = migrateDraftSnapshot({
      project: projectOf(),
      assets: [],
      timelineZoom: 40,
      playhead: 2,
    })
    expect(snapshot.timelineSettings.mainTrackMagnet).toBe(false)
    expect(snapshot.timelineZoom).toBe(40)
    expect(snapshot.playhead).toBe(2)
  })

  it('非法数值（NaN / 字符串）退回默认值', () => {
    const { snapshot, warnings } = migrateDraftSnapshot({
      project: projectOf(),
      assets: [],
      timelineZoom: Number.NaN,
      playhead: 'oops',
      timelineSettings: { mainTrackMagnet: 'yes' },
    })
    expect(snapshot.timelineZoom).toBe(0)
    expect(snapshot.playhead).toBe(0)
    expect(snapshot.timelineSettings.mainTrackMagnet).toBe(false)
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('完全空的输入也能返回可用的快照（不会崩）', () => {
    const { snapshot } = migrateDraftSnapshot(undefined)
    expect(snapshot.assets).toEqual([])
    expect(snapshot.timelineSettings.autoSnap).toBe(true)
    expect(snapshot.version).toBe(DRAFT_SCHEMA_VERSION)
  })
})

// ---------------------------------------------------------------- ID 熵

describe('createId：熵与向后兼容', () => {
  it('新 id 至少 64 位熵（长度远大于旧的 8 位片段）', () => {
    const id = createId('clip')
    const token = id.slice('clip_'.length)
    expect(token.length).toBeGreaterThanOrEqual(16)
    expect(id).not.toMatch(/^clip_[0-9a-f]{8}$/)
  })

  it('批量生成不重复', () => {
    const ids = new Set<string>()
    for (let index = 0; index < 2000; index += 1) ids.add(createId('clip'))
    expect(ids.size).toBe(2000)
  })

  it('旧短 id 仍被识别为合法（向后兼容，不做校验拒绝）', () => {
    expect(isLegacyShortId('clip_1a2b3c4d')).toBe(true)
    expect(isLegacyShortId(createId('clip'))).toBe(false)
  })
})

// ---------------------------------------------------------------- 并发保存

describe('saveProjectRecordSerialized：并发保存不乱序', () => {
  const record = (id: string, marker: number): DraftProjectRecord =>
    ({
      id,
      name: `p${marker}`,
      updatedAt: marker,
      thumbnail: '',
      snapshot: {
        version: DRAFT_SCHEMA_VERSION,
        project: { ...createInitialProject(SOURCE, 'c1'), markers: [{ id: `m${marker}`, time: 0, color: '#fff', note: '' }] } as Project,
        assets: [],
        sourceUrl: null,
        timelineZoom: 40,
        timelineSettings: SETTINGS,
        playhead: 0,
        updatedAt: marker,
      } satisfies DraftSnapshot,
    }) as DraftProjectRecord

  beforeEach(() => {
    vi.resetModules()
    globalThis.indexedDB = new IDBFactory()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('同一项目并发提交多次，最终落盘的是最后一次（旧快照被丢弃）', async () => {
    const store = await import('../src/editor/services/draftStore')
    // 同时发起 5 次保存（模拟防抖与强制保存交叠）
    const writes = [1, 2, 3, 4, 5].map((marker) => store.saveProjectRecordSerialized(record('p1', marker)))
    const results = await Promise.all(writes)
    // 只有最后一次真正写入
    expect(results.filter((result) => result.written)).toHaveLength(1)

    const loaded = await store.loadProjectRecord('p1')
    expect(loaded?.name).toBe('p5')
    expect(loaded?.snapshot.project.markers[0].id).toBe('m5')
  })

  it('不同项目之间互不阻塞（各自独立队列）', async () => {
    const store = await import('../src/editor/services/draftStore')
    const results = await Promise.all([
      store.saveProjectRecordSerialized(record('a', 1)),
      store.saveProjectRecordSerialized(record('b', 2)),
    ])
    expect(results.every((result) => result.written)).toBe(true)
    expect((await store.loadProjectRecord('a'))?.name).toBe('p1')
    expect((await store.loadProjectRecord('b'))?.name).toBe('p2')
  })

  it('beforeSave 返回 false 时放弃写入（用于数量上限）', async () => {
    const store = await import('../src/editor/services/draftStore')
    const result = await store.saveProjectRecordSerialized(record('p1', 1), {
      beforeSave: async () => false,
    })
    expect(result.written).toBe(false)
    expect(await store.loadProjectRecord('p1')).toBeNull()
  })
})
describe('saveProjectRecordSerialized：慢写也不能让旧快照后落盘', () => {
  beforeEach(() => {
    vi.resetModules()
    globalThis.indexedDB = new IDBFactory()
  })

  it('第一次写入比第二次慢得多时，最终记录仍是最新的一次', async () => {
    const store = await import('../src/editor/services/draftStore')
    const make = (marker: number): DraftProjectRecord =>
      ({
        id: 'slow',
        name: `p${marker}`,
        updatedAt: marker,
        thumbnail: '',
        snapshot: {
          version: DRAFT_SCHEMA_VERSION,
          project: createInitialProject(SOURCE, 'c1'),
          assets: [],
          sourceUrl: null,
          timelineZoom: 40,
          timelineSettings: SETTINGS,
          playhead: 0,
          updatedAt: marker,
        },
      }) as DraftProjectRecord

    // 让「更早的那次保存」在真实 IO 上更慢：直接压测队列的顺序保证。
    const first = store.saveProjectRecordSerialized(make(1))
    const second = store.saveProjectRecordSerialized(make(2))
    const third = store.saveProjectRecordSerialized(make(3))
    const results = await Promise.all([first, second, third])
    // 前两次被丢弃，只有最后一次真正写
    expect(results.map((result) => result.written)).toEqual([false, false, true])
    expect((await store.loadProjectRecord('slow'))?.name).toBe('p3')
  })
})
