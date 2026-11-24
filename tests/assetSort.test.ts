import { describe, expect, it } from 'vitest'
import { sortAssets } from '../src/editor/core/assets'
import type { MediaAsset } from '../src/editor/core/types'

function asset(name: string, duration: number, size: number): MediaAsset {
  return {
    id: name,
    url: `blob:${name}`,
    name,
    size,
    duration,
    width: 640,
    height: 360,
    kind: 'video',
  }
}

const list = [asset('clip10.mp4', 3, 100), asset('clip2.mp4', 10, 300), asset('b.mp4', 5, 200)]

describe('sortAssets（素材库排序）', () => {
  it('added 保持导入顺序且不改原数组', () => {
    const before = [...list]
    expect(sortAssets(list, 'added')).toEqual(before)
    expect(list).toEqual(before)
  })

  it('名称按中文/数字感知排序（clip2 < clip10）', () => {
    expect(sortAssets(list, 'name').map((item) => item.name)).toEqual([
      'b.mp4',
      'clip2.mp4',
      'clip10.mp4',
    ])
  })

  it('时长/大小按从大到小', () => {
    expect(sortAssets(list, 'duration').map((item) => item.duration)).toEqual([10, 5, 3])
    expect(sortAssets(list, 'size').map((item) => item.size)).toEqual([300, 200, 100])
  })
})