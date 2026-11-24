import { describe, expect, it } from 'vitest'
import { filterAssetsByUsage } from '../src/editor/core/assets'
import { createInitialProject } from '../src/editor/core/operations'
import type { MediaAsset } from '../src/editor/core/types'

function asset(name: string, url: string): MediaAsset {
  return {
    id: name,
    url,
    name,
    size: 1,
    duration: 10,
    width: 640,
    height: 360,
    kind: 'video',
  }
}

describe('filterAssetsByUsage（素材使用情况筛选）', () => {
  const project = createInitialProject({ url: 'blob:a', duration: 10 }, 'clip-a')
  const assets = [asset('a', 'blob:a'), asset('b', 'blob:b')]

  it('all 原样返回', () => {
    expect(filterAssetsByUsage(assets, project, 'all')).toEqual(assets)
  })

  it('used 只保留被主轨/叠加轨/音频/字幕引用或倒放链依赖的素材', () => {
    expect(filterAssetsByUsage(assets, project, 'used').map((item) => item.name)).toEqual(['a'])
  })

  it('unused 只保留完全没被引用的素材', () => {
    expect(filterAssetsByUsage(assets, project, 'unused').map((item) => item.name)).toEqual(['b'])
  })
})