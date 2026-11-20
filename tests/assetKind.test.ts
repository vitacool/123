import { describe, expect, it } from 'vitest'
import {
  ASSET_KIND_LABELS,
  assetKindOf,
  countAssetKinds,
  matchesAssetName,
} from '../src/editor/core/assets'
import type { MediaAsset } from '../src/editor/core/types'

const asset = (patch: Partial<MediaAsset>): MediaAsset => ({
  id: 'a1',
  url: 'blob:test',
  name: 'clip.mp4',
  size: 1,
  duration: 10,
  width: 1920,
  height: 1080,
  kind: 'video',
  ...patch,
})

describe('assetKindOf', () => {
  it('kind 存在时直接返回（三个取值）', () => {
    expect(assetKindOf(asset({ kind: 'video' }))).toBe('video')
    expect(assetKindOf(asset({ kind: 'image' }))).toBe('image')
    expect(assetKindOf(asset({ kind: 'audio' }))).toBe('audio')
  })

  it('kind 缺失兜底 1：宽高都为 0 → 音频', () => {
    expect(
      assetKindOf(asset({ kind: undefined, width: 0, height: 0, name: 'voice', url: 'blob:x' })),
    ).toBe('audio')
    // 即便文件名像视频，宽高为 0 也按音频处理（音频探测不到画面尺寸）
  })

  it('kind 缺失兜底 2：扩展名命中图片格式 → 图片（name 或 url 均生效）', () => {
    expect(assetKindOf(asset({ kind: undefined, name: 'poster.PNG' }))).toBe('image')
    expect(assetKindOf(asset({ kind: undefined, name: 'x.JpEg' }))).toBe('image')
    expect(assetKindOf(asset({ kind: undefined, name: 'x.webp' }))).toBe('image')
    expect(assetKindOf(asset({ kind: undefined, name: 'x.gif' }))).toBe('image')
    // name 没有扩展名，但 url 有
    expect(assetKindOf(asset({ kind: undefined, name: 'noext', url: 'blob:a/b.jpg' }))).toBe('image')
  })

  it('kind 缺失兜底 3：其余 → 视频', () => {
    expect(assetKindOf(asset({ kind: undefined, name: 'movie.mov' }))).toBe('video')
    expect(assetKindOf(asset({ kind: undefined, name: 'no-extension' }))).toBe('video')
    expect(assetKindOf(asset({ kind: undefined, name: 'x.png.mp4' }))).toBe('video')
  })

  it('忽略查询串与 Hash，扩展名仍能识别', () => {
    expect(assetKindOf(asset({ kind: undefined, url: 'http://x/a.png?token=1' }))).toBe('image')
    expect(assetKindOf(asset({ kind: undefined, url: 'http://x/a.png#frag' }))).toBe('image')
  })
})

describe('countAssetKinds / ASSET_KIND_LABELS', () => {
  it('按真实分类计数（含 kind 缺失的旧素材）', () => {
    const counts = countAssetKinds([
      asset({ id: '1', kind: 'video' }),
      asset({ id: '2', kind: 'video' }),
      asset({ id: '3', kind: 'image' }),
      asset({ id: '4', kind: undefined, width: 0, height: 0, name: 'a.mp3' }),
    ])
    expect(counts).toEqual({ video: 2, image: 1, audio: 1 })
  })

  it('标签为 视频 / 图片 / 音频', () => {
    expect(ASSET_KIND_LABELS).toEqual({ video: '视频', image: '图片', audio: '音频' })
  })
})

describe('matchesAssetName', () => {
  it('大小写不敏感、trim、空串视为匹配全部', () => {
    expect(matchesAssetName({ name: 'MyClip.MP4' }, 'myclip')).toBe(true)
    expect(matchesAssetName({ name: '我的视频_01.mp4' }, '  视频_01  ')).toBe(true)
    expect(matchesAssetName({ name: 'abc.mp4' }, '')).toBe(true)
    expect(matchesAssetName({ name: 'abc.mp4' }, '   ')).toBe(true)
  })

  it('只匹配名字，不匹配路径', () => {
    expect(matchesAssetName({ name: 'abc.mp4' }, 'users')).toBe(false)
  })

  it('中文 / 英文 / 数字 / 下划线一视同仁', () => {
    expect(matchesAssetName({ name: '宣传片_final2.mp4' }, '片_final2')).toBe(true)
    expect(matchesAssetName({ name: '宣传片_final2.mp4' }, '宣传')).toBe(true)
  })
})