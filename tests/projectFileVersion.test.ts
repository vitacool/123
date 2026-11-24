import { describe, expect, it } from 'vitest'
import {
  PROJECT_FILE_KIND,
  PROJECT_FILE_VERSION,
  parseProjectFile,
} from '../src/editor/projectFile'

/**
 * 工程文件版本门禁。
 *
 * 真实隐患：原来用 `data.version !== PROJECT_FILE_VERSION`，一旦版本号上调，
 * **所有历史工程文件**会立刻报「版本不受支持」，而 project 内部本来就有
 * normalizeProject 的 migrate()（schemaVersion），根本轮不到执行。
 * 这里锁住：老版本放行、新版本拒绝、非法版本给可读错误。
 */

function file(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: PROJECT_FILE_KIND,
    version: PROJECT_FILE_VERSION,
    exportedAt: 1_700_000_000_000,
    project: { clips: [] },
    assets: [],
    sourceUrl: null,
    timelineZoom: 92,
    timelineSettings: {
      mainTrackMagnet: true,
      autoSnap: true,
      linkage: true,
      previewAxis: true,
      captionFollow: true,
    },
    playhead: 0,
    ...overrides,
  }
}

describe('parseProjectFile 版本处理', () => {
  it('当前版本正常解析', () => {
    const parsed = parseProjectFile(JSON.stringify(file()))
    expect(parsed.version).toBe(PROJECT_FILE_VERSION)
    expect(parsed.project.clips).toEqual([])
  })

  it('老版本（v1）在更高版本的代码里也能打开，交给 normalizeProject 迁移', () => {
    // 模拟「以后 PROJECT_FILE_VERSION 变成 2」：老文件不该被信封直接拒绝。
    const parsed = parseProjectFile(JSON.stringify(file({ version: 1, schemaVersion: 1 })))
    expect(parsed.version).toBe(PROJECT_FILE_VERSION)
  })

  it('字符串版本号（手工编辑 / 第三方生成）按数字处理', () => {
    const parsed = parseProjectFile(JSON.stringify(file({ version: '1' })))
    expect(parsed.version).toBe(PROJECT_FILE_VERSION)
  })

  it('未来版本给出「需要更新版本」的可读错误', () => {
    expect(() => parseProjectFile(JSON.stringify(file({ version: PROJECT_FILE_VERSION + 1 })))).toThrow(
      /更新版本/,
    )
  })

  it('非法版本号被拒绝', () => {
    expect(() => parseProjectFile(JSON.stringify(file({ version: 0 })))).toThrow(/版本号无效/)
    expect(() => parseProjectFile(JSON.stringify(file({ version: 'abc' })))).toThrow(/版本号无效/)
  })

  it('仍然拒绝非 FrameCut 文件与缺 project 的文件', () => {
    expect(() => parseProjectFile(JSON.stringify(file({ kind: 'other' })))).toThrow(/FrameCut 工程文件/)
    expect(() => parseProjectFile(JSON.stringify(file({ project: null })))).toThrow(/缺少 project/)
  })
})