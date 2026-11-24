import { describe, expect, it } from 'vitest'
import { createInitialProject } from '../src/editor/core/operations'
import type { DraftSnapshot } from '../src/editor/core/draft'
import {
  DEFAULT_PROJECT_NAME,
  PROJECT_LIMIT,
  collectReferencedMediaIds,
  formatProjectUpdatedAt,
  legacyProjectRecord,
  localMediaIds,
  mediaIdsToDelete,
  normalizeProjectName,
  projectLimitReached,
  projectNameFromSource,
  projectThumbnail,
  sortProjectRecords,
  summarizeProjectSnapshot,
  type DraftProjectRecord,
} from '../src/editor/core/projectLibrary'

const REMOTE = 'https://cdn.example.com/main.mp4'
const LOCAL = 'blob:local-a'

function snapshot(overrides: Partial<DraftSnapshot> = {}): DraftSnapshot {
  return {
    version: 1,
    project: createInitialProject({ url: REMOTE, duration: 10 }, 'clip-a'),
    assets: [
      {
        id: 'remote-a',
        url: REMOTE,
        name: 'main.mp4',
        size: 1_000_000,
        duration: 10,
        width: 1920,
        height: 1080,
        kind: 'video',
        thumbnail: 'data:image/jpeg;base64,AAA',
      },
    ],
    sourceUrl: REMOTE,
    timelineZoom: 92,
    timelineSettings: {
      mainTrackMagnet: true,
      autoSnap: true,
      linkage: true,
      previewAxis: true,
      captionFollow: true,
    },
    playhead: 0,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

function record(id: string, updatedAt: number, mediaIds: string[] = []): DraftProjectRecord {
  return {
    id,
    name: `项目 ${id}`,
    updatedAt,
    snapshot: snapshot({
      assets: mediaIds.map((mediaId) => ({
        id: mediaId,
        url: mediaId.startsWith('blob:') ? mediaId : `https://cdn.example.com/${mediaId}.mp4`,
        name: `${mediaId}.mp4`,
        size: 1,
        duration: 5,
        width: 640,
        height: 360,
        kind: 'video' as const,
        local: mediaId.startsWith('blob:'),
      })),
    }),
  }
}

describe('项目列表摘要', () => {
  it('统计片段数 / 总时长 / 素材数 / 缺失数', () => {
    const base = snapshot()
    const summary = summarizeProjectSnapshot({
      ...base,
      missingAssets: [{ url: 'blob:gone', name: 'gone.mp4', kind: 'video' }],
    })
    expect(summary).toEqual({
      clipCount: 1,
      duration: 10,
      assetCount: 1,
      missingCount: 1,
    })
  })
})

describe('项目名', () => {
  it('默认取主素材名并去掉扩展名', () => {
    expect(projectNameFromSource('demo.mp4')).toBe('demo')
    expect(projectNameFromSource('旅行 vlog.mov')).toBe('旅行 vlog')
    expect(projectNameFromSource('a/b:c*.mov')).toBe('a-b-c-')
  })

  it('空名回退默认名，超长截断到 64', () => {
    expect(projectNameFromSource(undefined)).toBe(DEFAULT_PROJECT_NAME)
    expect(projectNameFromSource('   ')).toBe(DEFAULT_PROJECT_NAME)
    expect(projectNameFromSource(`${'x'.repeat(80)}.mp4`)).toBe('x'.repeat(64))
  })

  it('重命名不清洗扩展名（用户自己起的名字原样保留）', () => {
    expect(normalizeProjectName('  v2.0 正式版 ')).toBe('v2.0 正式版')
    expect(normalizeProjectName('a/b:c*')).toBe('a-b-c-')
    expect(normalizeProjectName('')).toBe(DEFAULT_PROJECT_NAME)
  })
})

describe('旧草稿迁移成项目记录', () => {
  it('生成 id / 名字 / 时间 / 缩略图，快照原样保留', () => {
    const legacy = snapshot()
    const migrated = legacyProjectRecord(legacy, 'project-1', 999)
    expect(migrated.id).toBe('project-1')
    expect(migrated.name).toBe('main')
    expect(migrated.updatedAt).toBe(legacy.updatedAt)
    expect(migrated.thumbnail).toBe('data:image/jpeg;base64,AAA')
    expect(migrated.snapshot).toBe(legacy)
  })

  it('快照缺少 updatedAt 时用传入的当前时间', () => {
    const legacy = snapshot({ updatedAt: Number.NaN })
    expect(legacyProjectRecord(legacy, 'project-1', 1234).updatedAt).toBe(1234)
  })

  it('没有素材时名字回退默认名，缩略图缺省', () => {
    const legacy = snapshot({ assets: [], sourceUrl: null })
    const migrated = legacyProjectRecord(legacy, 'project-2', 1)
    expect(migrated.name).toBe(DEFAULT_PROJECT_NAME)
    expect(migrated.thumbnail).toBeUndefined()
  })

  it('主素材按 sourceUrl 命中，其次第一个非音频素材', () => {
    const legacy = snapshot({
      sourceUrl: 'blob:second',
      assets: [
        {
          id: 'audio-a',
          url: 'blob:audio',
          name: 'bgm.mp3',
          size: 1,
          duration: 10,
          width: 0,
          height: 0,
          kind: 'audio',
        },
        {
          id: 'video-b',
          url: 'blob:second',
          name: 'second.mp4',
          size: 1,
          duration: 10,
          width: 640,
          height: 360,
          kind: 'video',
          thumbnail: 'data:image/jpeg;base64,BBB',
        },
      ],
    })
    expect(projectThumbnail(legacy)).toBe('data:image/jpeg;base64,BBB')
    expect(legacyProjectRecord(legacy, 'p', 1).name).toBe('second')
  })
})

describe('项目列表排序与上限', () => {
  it('最近更新的排前面，时间相同按 id 稳定', () => {
    const sorted = sortProjectRecords([
      record('b', 100),
      record('a', 300),
      record('c', 200),
      record('d', 100),
    ])
    expect(sorted.map((item) => item.id)).toEqual(['a', 'c', 'b', 'd'])
  })

  it('上限 20：达到后拒绝新增（不自动删除）', () => {
    expect(PROJECT_LIMIT).toBe(20)
    expect(projectLimitReached(19)).toBe(false)
    expect(projectLimitReached(20)).toBe(true)
    expect(projectLimitReached(21)).toBe(true)
    expect(projectLimitReached(Number.NaN)).toBe(false)
  })
})

describe('媒体 blob 引用计数与删除判定', () => {
  it('只把本地素材计为需要存储的 blob', () => {
    const snap = snapshot({
      assets: [
        { id: 'remote', url: REMOTE, name: 'a.mp4', size: 1, duration: 1, width: 2, height: 2 },
        { id: 'local-1', url: LOCAL, name: 'b.mp4', size: 1, duration: 1, width: 2, height: 2, local: true },
        { id: 'local-2', url: 'blob:local-b', name: 'c.mp4', size: 1, duration: 1, width: 2, height: 2 },
      ],
    })
    expect(localMediaIds(snap)).toEqual(['local-1', 'local-2'])
  })

  it('多个项目的引用取并集，可排除当前项目', () => {
    const records = [record('p1', 1, ['blob:a', 'blob:b']), record('p2', 2, ['blob:b', 'blob:c'])]
    expect([...collectReferencedMediaIds(records)].sort()).toEqual(['blob:a', 'blob:b', 'blob:c'])
    expect([...collectReferencedMediaIds(records, { exceptProjectId: 'p1' })]).toEqual([
      'blob:b',
      'blob:c',
    ])
  })

  it('只删除「没有任何项目引用」的 blob', () => {
    const referenced = new Set(['blob:a', 'blob:b'])
    expect(mediaIdsToDelete(['blob:a', 'blob:orphan', 'blob:b'], referenced)).toEqual(['blob:orphan'])
    expect(mediaIdsToDelete(['blob:a'], referenced)).toEqual([])
    expect(mediaIdsToDelete([], referenced)).toEqual([])
  })

  it('删除项目后：仍被其它项目引用的 blob 保留', () => {
    const remaining = [record('p2', 2, ['blob:shared', 'blob:only-b'])]
    const referenced = collectReferencedMediaIds(remaining)
    // blob:shared 仍被 p2 引用 → 不删；只有只剩 p1 独占的 blob 才会进删除列表。
    expect(mediaIdsToDelete(['blob:shared', 'blob:only-a', 'blob:only-b'], referenced)).toEqual([
      'blob:only-a',
    ])
  })
})

describe('更新时间展示', () => {
  const now = new Date(2026, 10, 20, 15, 30).getTime()

  it('一分钟内显示刚刚，一小时内显示分钟', () => {
    expect(formatProjectUpdatedAt(now - 5_000, now)).toBe('刚刚')
    expect(formatProjectUpdatedAt(now - 5 * 60_000, now)).toBe('5 分钟前')
    expect(formatProjectUpdatedAt(now - 59 * 60_000, now)).toBe('59 分钟前')
  })

  it('今天 / 昨天 / 更早', () => {
    expect(formatProjectUpdatedAt(new Date(2026, 10, 20, 9, 5).getTime(), now)).toBe('今天 09:05')
    expect(formatProjectUpdatedAt(new Date(2026, 10, 19, 22, 40).getTime(), now)).toBe(
      '昨天 22:40',
    )
    expect(formatProjectUpdatedAt(new Date(2026, 10, 1, 8, 0).getTime(), now)).toBe('2026-11-01')
  })

  it('非法时间返回占位符', () => {
    expect(formatProjectUpdatedAt(0, now)).toBe('—')
    expect(formatProjectUpdatedAt(Number.NaN, now)).toBe('—')
  })
})