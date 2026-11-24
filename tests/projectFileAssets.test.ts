import { describe, expect, it } from 'vitest'
import {
  MAX_PROJECT_FILE_ASSETS,
  PROJECT_FILE_KIND,
  PROJECT_FILE_VERSION,
  isLocalAsset,
  normalizeProjectFileAssets,
  parseProjectFile,
} from '../src/editor/projectFile'

/**
 * 工程文件 `assets[]` 的不可信输入校验。
 *
 * 真实隐患：以前是 `data.assets as DraftAsset[]` 直接转型，畸形条目（`{id: 42}`、
 * `url: null`）会一路传到 `isLocalAsset(asset)` 的 `asset.url.startsWith(...)`，
 * 抛 TypeError → 用户只看到「工程导入失败：Cannot read properties of null」，
 * 整个工程打不开，而不是「素材缺失、以占位显示」。
 */

function file(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: PROJECT_FILE_KIND,
    version: PROJECT_FILE_VERSION,
    exportedAt: 1,
    project: { clips: [] },
    assets: [],
    sourceUrl: null,
    timelineZoom: 92,
    timelineSettings: {},
    playhead: 0,
    ...overrides,
  }
}

describe('normalizeProjectFileAssets', () => {
  it('保留合法条目并补齐字段', () => {
    const assets = normalizeProjectFileAssets([
      {
        id: 'a1',
        url: 'blob:x',
        name: 'clip.mp4',
        size: 10,
        duration: 5,
        width: 1920,
        height: 1080,
        kind: 'video',
        hasAudio: true,
        local: true,
      },
    ])
    expect(assets).toHaveLength(1)
    expect(assets[0]).toMatchObject({ id: 'a1', url: 'blob:x', kind: 'video', local: true })
  })

  it('丢弃缺 id / 缺 url / 非对象的条目（不是抛错）', () => {
    const assets = normalizeProjectFileAssets([
      null,
      'oops',
      { id: 42, url: 'blob:x' },
      { url: 'blob:no-id' },
      { id: 'no-url' },
      { id: 'empty-url', url: '' },
      { id: 'ok', url: 'blob:ok' },
    ])
    expect(assets.map((asset) => asset.id)).toEqual(['ok'])
    // 关键：清洗后 isLocalAsset 不会因为 url 缺失而抛 TypeError。
    expect(() => assets.map(isLocalAsset)).not.toThrow()
    expect(assets[0].name).toBe('blob:ok')
  })

  it('数值字段非有限/负数时夹到 0；kind 非法时丢弃该字段', () => {
    const [asset] = normalizeProjectFileAssets([
      {
        id: 'a',
        url: 'blob:a',
        size: -5,
        duration: Number.NaN,
        width: '1920',
        height: Number.POSITIVE_INFINITY,
        kind: 'audio-track',
      },
    ])
    expect(asset.size).toBe(0)
    expect(asset.duration).toBe(0)
    expect(asset.width).toBe(0)
    expect(asset.height).toBe(0)
    expect(asset.kind).toBeUndefined()
  })

  it('同 id 去重（先出现的胜出），并限制条目总数', () => {
    const dup = normalizeProjectFileAssets([
      { id: 'a', url: 'blob:first' },
      { id: 'a', url: 'blob:second' },
    ])
    expect(dup).toHaveLength(1)
    expect(dup[0].url).toBe('blob:first')

    const many = normalizeProjectFileAssets(
      Array.from({ length: MAX_PROJECT_FILE_ASSETS + 25 }, (_, index) => ({
        id: `a${index}`,
        url: `blob:${index}`,
      })),
    )
    expect(many).toHaveLength(MAX_PROJECT_FILE_ASSETS)
  })

  it('reversedFrom 只在区间是有限数字时保留', () => {
    const [good] = normalizeProjectFileAssets([
      { id: 'a', url: 'blob:a', reversedFrom: { assetId: 'src', start: 1, end: 2 } },
    ])
    expect(good.reversedFrom).toEqual({ assetId: 'src', start: 1, end: 2 })

    const [bad] = normalizeProjectFileAssets([
      { id: 'b', url: 'blob:b', reversedFrom: { start: 'x', end: null } },
    ])
    expect(bad.reversedFrom).toBeUndefined()
  })

  it('非数组 / 缺省时返回空数组', () => {
    expect(normalizeProjectFileAssets(undefined)).toEqual([])
    expect(normalizeProjectFileAssets(null)).toEqual([])
    expect(normalizeProjectFileAssets({ 0: 'x' })).toEqual([])
  })
})

describe('parseProjectFile 对 assets 的清洗', () => {
  it('畸形 assets 不会让导入抛错，只丢掉坏条目', () => {
    const parsed = parseProjectFile(
      JSON.stringify(
        file({
          assets: [null, { id: 7 }, { id: 'ok', url: 'blob:ok' }],
        }),
      ),
    )
    expect(parsed.assets.map((asset) => asset.id)).toEqual(['ok'])
  })

  it('assets 不是数组时按空数组处理', () => {
    expect(parseProjectFile(JSON.stringify(file({ assets: 'nope' }))).assets).toEqual([])
  })
})