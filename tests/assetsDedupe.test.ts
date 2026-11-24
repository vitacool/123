import { describe, expect, it } from 'vitest'
import { findDuplicateAsset } from '../src/editor/core/assets'
import type { MediaAsset } from '../src/editor/core/types'

function asset(name: string, size: number): MediaAsset {
  return {
    id: name,
    url: `blob:${name}`,
    name,
    size,
    duration: 5,
    width: 640,
    height: 360,
    kind: 'video',
  }
}

describe('导入判重：同名同大小', () => {
  it('同名同大小视为重复，返回已有素材', () => {
    const existing = asset('clip.mp4', 1024)
    expect(findDuplicateAsset({ name: 'clip.MP4', size: 1024 }, [existing])).toBe(existing)
  })

  it('同大小但不同名 / 同名但不同大小不重复', () => {
    const existing = asset('clip.mp4', 1024)
    expect(findDuplicateAsset({ name: 'other.mp4', size: 1024 }, [existing])).toBeUndefined()
    expect(findDuplicateAsset({ name: 'clip.mp4', size: 2048 }, [existing])).toBeUndefined()
  })
})