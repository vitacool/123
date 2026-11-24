import { describe, expect, it } from 'vitest'
import {
  filterAssetsByFolder,
  listAssetFolders,
  normalizeAssetFolder,
} from '../src/editor/core/assets'
import type { MediaAsset } from '../src/editor/core/types'

function asset(name: string, folder?: string): MediaAsset {
  return {
    id: name,
    url: `blob:${name}`,
    name,
    size: 1,
    duration: 5,
    width: 640,
    height: 360,
    kind: 'video',
    ...(folder === undefined ? {} : { folder }),
  }
}

describe('素材文件夹', () => {
  it('归一名：去首尾/压缩空白并限长', () => {
    expect(normalizeAssetFolder('  旅行   素材  ')).toBe('旅行 素材')
    expect(normalizeAssetFolder('x'.repeat(80))).toHaveLength(40)
    expect(normalizeAssetFolder(undefined)).toBe('')
  })

  it('列举去重并排序，未分类不计入', () => {
    const assets = [asset('a', 'B'), asset('b', 'A'), asset('c', undefined), asset('d', 'B')]
    expect(listAssetFolders(assets)).toEqual(['A', 'B'])
  })

  it('筛选：null=全部，空串=未分类，其余精确匹配（忽略空白差异）', () => {
    const assets = [asset('a', 'B'), asset('b', 'A'), asset('c')]
    expect(filterAssetsByFolder(assets, null)).toHaveLength(3)
    expect(filterAssetsByFolder(assets, '').map((item) => item.name)).toEqual(['c'])
    expect(filterAssetsByFolder(assets, ' A ').map((item) => item.name)).toEqual(['b'])
  })
})