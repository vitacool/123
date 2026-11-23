import { describe, expect, it } from 'vitest'
import { createEditorStore } from '../src/editor/store/editorStore'
import type { Clip, SourceInfo } from '../src/editor/core/types'

const SOURCE: SourceInfo = {
  url: 'blob:test',
  name: 'test.mp4',
  size: 1024,
  duration: 12,
  width: 1920,
  height: 1080,
}

/** 建一个含「主轨片段 + 叠加轨片段」的 store，并选中叠加片段。 */
function makeOverlayStore() {
  const store = createEditorStore()
  store.getState().loadSource(SOURCE)
  store.getState().addOverlayTrack()
  const overlayTrackId = store.getState().project.overlayTracks![0].id
  const assetId = store.getState().assets[0].id
  store.getState().addAssetToTimeline(assetId, { kind: 'track', trackKind: 'overlay', trackId: overlayTrackId, time: 0 })
  const overlayClip = store.getState().project.overlayTracks![0].clips[0]
  store.getState().selectClip(overlayClip.id)
  return { store, clipId: overlayClip.id }
}

const overlayClipOf = (store: ReturnType<typeof makeOverlayStore>['store']): Clip => {
  const clip = store.getState().project.overlayTracks![0].clips[0]
  if (!clip) throw new Error('overlay clip missing')
  return clip
}

/**
 * 回归：这些 action 原先用 createUpdateClipCommand（只查主轨），
 * 对叠加轨片段静默失效 —— 「位置复位 / 适应 / 填充 / 缩放 / 旋转 / 镜像」点了没反应。
 */
describe('叠加轨片段的画面变换动作', () => {
  it('setScale / setPosition 能改到叠加片段', () => {
    const { store } = makeOverlayStore()
    store.getState().setScale(1.5)
    store.getState().setPosition(0.2, -0.1)
    const clip = overlayClipOf(store)
    expect(clip.scale).toBeCloseTo(1.5, 5)
    expect(clip.position.x).toBeCloseTo(0.2, 5)
    expect(clip.position.y).toBeCloseTo(-0.1, 5)
  })

  it('resetPosition 把叠加片段位置归零，且只产生 1 步撤销', () => {
    const { store, clipId } = makeOverlayStore()
    store.getState().setPosition(0.3, -0.2)
    expect(overlayClipOf(store).position.x).toBeCloseTo(0.3, 5)

    store.getState().resetPosition()
    const reset = overlayClipOf(store)
    expect(reset.position.x).toBe(0)
    expect(reset.position.y).toBe(0)
    expect(reset.id).toBe(clipId)

    // 一次撤销回到复位前的位置
    store.getState().undo()
    expect(overlayClipOf(store).position.x).toBeCloseTo(0.3, 5)
  })

  it('fitSelected 把叠加片段缩放归 1', () => {
    const { store } = makeOverlayStore()
    store.getState().setScale(1.8)
    expect(overlayClipOf(store).scale).toBeCloseTo(1.8, 5)

    store.getState().fitSelected()
    expect(overlayClipOf(store).scale).toBe(1)

    store.getState().undo()
    expect(overlayClipOf(store).scale).toBeCloseTo(1.8, 5)
  })

  it('旋转 / 镜像 也能作用到叠加片段', () => {
    const { store } = makeOverlayStore()
    store.getState().setRotation(30)
    expect(overlayClipOf(store).rotation).toBe(30)

    store.getState().rotateSelected(90)
    expect(overlayClipOf(store).rotation).toBe(120)

    store.getState().toggleFlipH()
    expect(overlayClipOf(store).flipH).toBe(true)

    store.getState().resetRotation()
    expect(overlayClipOf(store).rotation).toBe(0)
  })

  it('主轨片段行为不受影响', () => {
    const store = createEditorStore()
    store.getState().loadSource(SOURCE)
    const mainId = store.getState().selectedClipId!
    store.getState().setScale(1.5)
    store.getState().setPosition(0.2, 0.1)
    const main = store.getState().project.clips.find((clip) => clip.id === mainId)!
    expect(main.scale).toBeCloseTo(1.5, 5)
    expect(main.position.x).toBeCloseTo(0.2, 5)

    store.getState().resetPosition()
    const after = store.getState().project.clips.find((clip) => clip.id === mainId)!
    expect(after.position).toEqual({ x: 0, y: 0 })
  })
})