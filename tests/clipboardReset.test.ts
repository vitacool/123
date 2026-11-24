import { describe, expect, it } from 'vitest'
import { createEditorStore } from '../src/editor/store/editorStore'

const source = {
  url: 'blob:video',
  name: 'video.mp4',
  size: 1024,
  duration: 10,
  width: 640,
  height: 360,
}

describe('切换项目：剪贴板必须清空', () => {
  it('copy 后 hydrateDraft 到另一份工程，clipboard 不再保留旧片段', () => {
    const store = createEditorStore()
    store.getState().loadSource(source)
    const clipId = store.getState().project.clips[0].id
    store.getState().selectClip(clipId)
    store.getState().copySelection()
    expect(store.getState().clipboard.count).toBe(1)

    const state = store.getState()
    store.getState().hydrateDraft({
      project: state.project,
      assets: state.assets,
      missingAssets: [],
      source: state.source,
      timelineZoom: state.timelineZoom,
      timelineSettings: {
        ...state.timelineSettings,
        captionFollow: state.captionFollow,
        exportRange: state.exportRange,
      },
      playhead: 0,
    })
    expect(store.getState().clipboard.count).toBe(0)
    expect(store.getState().clipboard.items).toHaveLength(0)
  })
})