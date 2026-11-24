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

describe('字幕列表：在播放头新增条目', () => {
  it('导入字幕后可在播放头插入一条新字幕（仍为 caption 轨）', () => {
    const store = createEditorStore()
    store.getState().loadSource(source)
    store.getState().importSubtitles([{ start: 0, end: 2, text: '第一句' }])
    const track = store.getState().project.textTracks?.[0]
    expect(track?.kind).toBe('caption')

    store.getState().setPlayhead(5)
    store.getState().addCaptionAtPlayhead(track!.id)
    const clips = store.getState().project.textTracks?.[0].clips ?? []
    expect(clips).toHaveLength(2)
    expect(clips[1]).toMatchObject({ text: '新字幕', start: 5, end: 7 })
    expect(store.getState().selectedClipId).toBe(clips[1].id)
  })

  it('锁定字幕轨时拒绝新增并提示', () => {
    const store = createEditorStore()
    store.getState().loadSource(source)
    store.getState().importSubtitles([{ start: 0, end: 2, text: '第一句' }])
    const track = store.getState().project.textTracks?.[0]
    store.getState().toggleTrackFlag('text', track!.id, 'locked')
    store.getState().setPlayhead(5)
    store.getState().addCaptionAtPlayhead(track!.id)
    expect(store.getState().project.textTracks?.[0].clips).toHaveLength(1)
    expect(store.getState().toast?.message).toContain('锁定')
  })
})