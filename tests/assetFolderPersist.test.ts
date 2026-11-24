import { describe, expect, it } from 'vitest'
import { toDraftAsset } from '../src/editor/services/draftStore'
import { normalizeProjectFileAssets } from '../src/editor/projectFile'
import type { MediaAsset } from '../src/editor/core/types'

const base: MediaAsset = {
  id: 'asset-1',
  url: 'blob:asset-1',
  name: 'clip.mp4',
  size: 10,
  duration: 5,
  width: 640,
  height: 360,
  kind: 'video',
}

describe('素材文件夹持久化', () => {
  it('草稿快照写入/保留 folder', () => {
    expect(toDraftAsset({ ...base, folder: '旅行' }).folder).toBe('旅行')
    expect(toDraftAsset(base).folder).toBeUndefined()
  })

  it('工程文件导入清洗 folder（去空白、限长、丢弃非字符串）', () => {
    const assets = normalizeProjectFileAssets([
      { id: 'a', url: 'blob:a', folder: '  旅行  ' },
      { id: 'b', url: 'blob:b', folder: 42 },
    ])
    expect(assets[0].folder).toBe('旅行')
    expect(assets[1].folder).toBeUndefined()
  })
})