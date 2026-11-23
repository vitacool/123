import { describe, expect, it } from 'vitest'
import {
  createInitialProject,
  insertFreezeAt,
} from '../src/editor/core/operations'
import type { SourceInfo } from '../src/editor/core/types'
import { createEditorStore, selectCanUndo, selectCanRedo } from '../src/editor/store/editorStore'

const SOURCE: SourceInfo = {
  url: 'blob:test',
  name: 'test.mp4',
  size: 1024,
  duration: 12,
  width: 1920,
  height: 1080,
}

function makeStore() {
  const store = createEditorStore()
  store.getState().loadSource(SOURCE)
  return store
}

describe('editor store integration', () => {
  it('initializes a project with a selected source clip', () => {
    const store = makeStore()
    const state = store.getState()
    expect(state.project.clips).toHaveLength(1)
    expect(state.project.clips[0].id).toBe(state.selectedClipId)
    expect(state.project.clips[0].sourceEnd).toBe(12)
    expect(selectCanUndo(store.getState())).toBe(false)
  })

  it('routes split, undo and redo through the command history', () => {
    const store = makeStore()
    store.getState().setPlayhead(4)
    store.getState().splitAtPlayhead()
    let state = store.getState()
    expect(state.project.clips).toHaveLength(2)
    expect(selectCanUndo(store.getState())).toBe(true)
    expect(state.selectedClipId).toBe(state.project.clips[1].id)

    state.undo()
    expect(store.getState().project.clips).toHaveLength(1)
    expect(selectCanRedo(store.getState())).toBe(true)

    store.getState().redo()
    state = store.getState()
    expect(state.project.clips).toHaveLength(2)
    expect(state.selectedClipId).toBe(state.project.clips[1].id)
  })

  it('inserts a freeze and maintains unique IDs', () => {
    const store = makeStore()
    store.getState().setPlayhead(5)
    store.getState().insertFreeze()
    const state = store.getState()
    expect(state.project.clips).toHaveLength(3)
    const ids = state.project.clips.map((clip) => clip.id)
    expect(new Set(ids).size).toBe(3)
    const freeze = state.project.clips[1]
    expect(freeze.type).toBe('freeze')
    expect(state.selectedClipId).toBe(freeze.id)
    expect(freeze.sourceEnd - freeze.sourceStart).toBe(3)

    state.undo()
    expect(store.getState().project.clips).toHaveLength(1)
    store.getState().redo()
    expect(store.getState().project.clips).toHaveLength(3)
  })

  it('only writes crop results on commit', () => {
    const store = makeStore()
    store.getState().beginCrop()
    store.getState().updateCropDraft({ x: 0.2, y: 0.1, w: 0.5, h: 0.6 })
    expect(store.getState().project.clips[0].crop).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expect(selectCanUndo(store.getState())).toBe(false)

    store.getState().commitCrop()
    expect(store.getState().project.clips[0].crop).toEqual({ x: 0.2, y: 0.1, w: 0.5, h: 0.6 })
    expect(selectCanUndo(store.getState())).toBe(true)
    expect(store.getState().cropSession).toBeNull()

    store.getState().undo()
    expect(store.getState().project.clips[0].crop).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })

  it('keeps preview patches out of project history', () => {
    const store = makeStore()
    const clipId = store.getState().selectedClipId!
    store.getState().setPreviewPatch({
      clipId,
      patch: { rotation: 45, scale: 1.8 },
    })
    expect(store.getState().project.clips[0].rotation).toBe(0)
    expect(selectCanUndo(store.getState())).toBe(false)

    store.getState().setRotation(45)
    expect(store.getState().project.clips[0].rotation).toBe(45)
    expect(store.getState().previewPatch).toBeNull()
    expect(selectCanUndo(store.getState())).toBe(true)
  })

  it('adds and removes markers through commands', () => {
    const store = makeStore()
    store.getState().setPlayhead(5)
    store.getState().addMarker()
    const markers = store.getState().project.markers
    expect(markers).toHaveLength(1)
    expect(markers[0].time).toBe(5)

    store.getState().deleteMarker(markers[0].id)
    expect(store.getState().project.markers).toHaveLength(0)
  })

  it('deletes the selected clip and restores it with undo', () => {
    const store = makeStore()
    store.getState().setPlayhead(5)
    store.getState().splitAtPlayhead()
    const rightId = store.getState().project.clips[1].id
    store.getState().selectClip(rightId)
    store.getState().deleteSelectedClip()
    let state = store.getState()
    expect(state.project.clips).toHaveLength(1)
    expect(state.selectedClipId).toBe(state.project.clips[0].id)
    expect(selectCanUndo(store.getState())).toBe(true)

    state.undo()
    state = store.getState()
    expect(state.project.clips).toHaveLength(2)
    expect(state.project.clips[1].id).toBe(rightId)
  })

  it('reorders clips and keeps the moved clip selected', () => {
    const store = makeStore()
    store.getState().setPlayhead(5)
    store.getState().splitAtPlayhead()
    const rightId = store.getState().project.clips[1].id
    const leftId = store.getState().project.clips[0].id
    store.getState().reorderClip(rightId, 0)
    const state = store.getState()
    expect(state.project.clips.map((clip) => clip.id)).toEqual([rightId, leftId])
    expect(state.selectedClipId).toBe(rightId)
    expect(state.playhead).toBe(0)
    expect(selectCanUndo(store.getState())).toBe(true)
  })

  it('restores trimmed source from clip edges without losing media', () => {
    const store = makeStore()
    const clipId = store.getState().selectedClipId!
    store.getState().setPlayhead(6)
    store.getState().trimRightAtPlayhead()
    expect(store.getState().project.clips[0].sourceEnd).toBe(6)
    store.getState().resizeClipEdge(clipId, 'right', 6)
    expect(store.getState().project.clips[0].sourceEnd).toBe(12)

    store.getState().setPlayhead(3)
    store.getState().trimLeftAtPlayhead()
    expect(store.getState().project.clips[0].sourceStart).toBe(3)
    expect(store.getState().project.clips[0].gapBefore).toBe(3)
    store.getState().resizeClipEdge(clipId, 'left', -3)
    expect(store.getState().project.clips[0].sourceStart).toBe(0)
    expect(store.getState().project.clips[0].gapBefore).toBe(0)
  })

  it('undoes and redoes a trim', () => {
    const store = makeStore()
    store.getState().setPlayhead(3)
    store.getState().trimLeftAtPlayhead()
    let state = store.getState()
    expect(state.project.clips[0].sourceStart).toBe(3)
    expect(state.project.clips[0].gapBefore).toBe(3)
    expect(selectCanUndo(store.getState())).toBe(true)

    state.undo()
    state = store.getState()
    expect(state.project.clips[0].sourceStart).toBe(0)
    expect(state.project.clips[0].gapBefore).toBe(0)
    expect(selectCanRedo(store.getState())).toBe(true)

    state.redo()
    state = store.getState()
    expect(state.project.clips[0].sourceStart).toBe(3)
    expect(state.project.clips[0].gapBefore).toBe(3)
  })

  it('adds and removes an overlay track with history', () => {
    const store = makeStore()
    const baseId = store.getState().selectedClipId!
    store.getState().addOverlayTrack()
    let state = store.getState()
    expect(state.project.overlayTracks).toHaveLength(1)
    expect(state.project.overlayTracks![0].clips).toHaveLength(0)
    expect(state.selectedClipId).toBe(baseId)
    expect(selectCanUndo(store.getState())).toBe(true)
    const overlayTrackId = state.project.overlayTracks![0].id

    store.getState().removeOverlayTrack(overlayTrackId)
    state = store.getState()
    expect(state.project.overlayTracks).toHaveLength(0)
    expect(state.selectedClipId).toBe(baseId)

    state.undo()
    state = store.getState()
    expect(state.project.overlayTracks).toHaveLength(1)
  })

  it('resets the project when the source is cleared', () => {
    const store = makeStore()
    store.getState().clearSource()
    const state = store.getState()
    expect(state.project.clips).toHaveLength(0)
    expect(state.source).toBeNull()
    expect(selectCanUndo(store.getState())).toBe(false)
  })

  it('inserts a freeze at an exact clip boundary with a stable frame', () => {
    const project = createInitialProject({ url: SOURCE.url, duration: 12 }, 'clip-a')
    const inserted = insertFreezeAt(project, 12, 'freeze-end', 3, 'unused')!
    expect(inserted.project.clips[1].freezeFrameTime).toBe(12)
  })
})

describe('text track history', () => {
  it('reveals the selected text clip by moving the playhead into it', () => {
    const store = makeStore()
    store.getState().addTextAtPlayhead()
    const textClip = store.getState().project.textTracks?.[0].clips[0]
    expect(textClip).toBeTruthy()
    store.getState().setPlayhead(3)
    store.getState().selectClip(textClip!.id)
    expect(store.getState().playhead).toBe(0)
  })

  it('splits the selected text clip at the playhead', () => {
    const store = makeStore()
    store.getState().addTextAtPlayhead()
    const textClip = store.getState().project.textTracks?.[0].clips[0]
    expect(textClip).toBeTruthy()
    store.getState().selectClip(textClip!.id)
    store.getState().setPlayhead(1.5)
    store.getState().splitAtPlayhead()
    const clips = store.getState().project.textTracks?.[0].clips ?? []
    expect(clips).toHaveLength(2)
    expect(clips[0].end).toBe(1.5)
    expect(clips[1].start).toBe(1.5)
    expect(selectCanUndo(store.getState())).toBe(true)
  })
})

describe('locked target tracks', () => {
  it('refuses to move a clip into a locked overlay target', () => {
    const store = makeStore()
    store.getState().addOverlayTrack()
    const overlay = store.getState().project.overlayTracks?.[0]
    expect(overlay).toBeTruthy()
    store.getState().toggleTrackFlag('overlay', overlay!.id, 'locked')
    const baseClipId = store.getState().project.clips[0].id
    store.getState().moveClipToTrackAtTime(baseClipId, overlay!.id, 0)
    const state = store.getState()
    expect(state.project.clips).toHaveLength(1)
    expect(state.project.overlayTracks?.[0].clips).toHaveLength(0)
  })
})

describe('导出区间（I/O 打点）', () => {
  it('设入点：只设了一端时出点取工程终点', () => {
    const store = makeStore()
    store.getState().setPlayhead(3)
    store.getState().setExportInPoint()
    expect(store.getState().exportRange).toEqual({ start: 3, end: 12 })
  })

  it('设出点：只设了一端时入点取工程起点', () => {
    const store = makeStore()
    store.getState().setPlayhead(5)
    store.getState().setExportOutPoint()
    expect(store.getState().exportRange).toEqual({ start: 0, end: 5 })
  })

  it('两端都设过之后各自保持另一端不变', () => {
    const store = makeStore()
    store.getState().setPlayhead(2)
    store.getState().setExportInPoint()
    store.getState().setPlayhead(7)
    store.getState().setExportOutPoint()
    expect(store.getState().exportRange).toEqual({ start: 2, end: 7 })

    // 再改入点：出点保持 7。
    store.getState().setPlayhead(4)
    store.getState().setExportInPoint()
    expect(store.getState().exportRange).toEqual({ start: 4, end: 7 })
  })

  it('入点越过出点、或在工程终点设入点都会被拒绝并提示', () => {
    const store = makeStore()
    store.getState().setPlayhead(2)
    store.getState().setExportInPoint()
    store.getState().setPlayhead(7)
    store.getState().setExportOutPoint()
    expect(store.getState().exportRange).toEqual({ start: 2, end: 7 })

    // 已有区间时另一端保持不变：入点越过出点 → 拒绝。
    store.getState().setPlayhead(7.05)
    store.getState().setExportInPoint()
    expect(store.getState().exportRange).toEqual({ start: 2, end: 7 })
    expect(store.getState().toast?.kind).toBe('warning')

    // 出点越到入点之前同样拒绝。
    store.getState().setPlayhead(1)
    store.getState().setExportOutPoint()
    expect(store.getState().exportRange).toEqual({ start: 2, end: 7 })

    // 没有区间时出点会自动取工程起点；入点取工程终点（此处在 12 秒 → 长度 0 被拒）。
    store.getState().clearExportRange()
    store.getState().setPlayhead(12)
    store.getState().setExportInPoint()
    expect(store.getState().exportRange).toBeNull()
    expect(store.getState().toast?.kind).toBe('warning')
  })

  it('拖动端点时保持至少 0.1 秒，并夹到工程范围内', () => {
    const store = makeStore()
    store.getState().setPlayhead(2)
    store.getState().setExportInPoint()
    store.getState().setPlayhead(8)
    store.getState().setExportOutPoint()

    store.getState().setExportRangeEdge('start', 20)
    expect(store.getState().exportRange).toEqual({ start: 7.9, end: 8 })

    store.getState().setExportRangeEdge('end', 40)
    expect(store.getState().exportRange).toEqual({ start: 7.9, end: 12 })

    store.getState().setExportRangeEdge('end', -5)
    expect(store.getState().exportRange).toEqual({ start: 7.9, end: 8 })
  })

  it('清除区间（Alt+X 对应 action）', () => {
    const store = makeStore()
    store.getState().setPlayhead(2)
    store.getState().setExportInPoint()
    expect(store.getState().exportRange).not.toBeNull()
    store.getState().clearExportRange()
    expect(store.getState().exportRange).toBeNull()
  })

  it('区间不进撤销历史：撤销 / 重做不改变区间', () => {
    const store = makeStore()
    store.getState().setPlayhead(2)
    store.getState().setExportInPoint()
    store.getState().setPlayhead(7)
    store.getState().setExportOutPoint()
    const range = store.getState().exportRange

    store.getState().setPlayhead(5)
    store.getState().splitAtPlayhead()
    expect(selectCanUndo(store.getState())).toBe(true)
    store.getState().undo()
    expect(store.getState().exportRange).toEqual(range)
    store.getState().redo()
    expect(store.getState().exportRange).toEqual(range)
  })

  it('工程变短后区间自动夹回有效范围', () => {
    const store = makeStore()
    store.getState().setPlayhead(2)
    store.getState().setExportInPoint()
    store.getState().setPlayhead(8)
    store.getState().setExportOutPoint()

    // 播放头 5 处分割，删除后半段：工程只剩 5 秒。
    store.getState().setPlayhead(5)
    store.getState().splitAtPlayhead()
    store.getState().deleteSelectedClip()
    expect(store.getState().project.clips).toHaveLength(1)
    expect(store.getState().exportRange).toEqual({ start: 2, end: 5 })
  })

  it('载入旧草稿（没有 exportRange）时按 null 处理，越界区间夹取', () => {
    const store = makeStore()
    const project = store.getState().project
    store.getState().hydrateDraft({
      project,
      assets: store.getState().assets,
      source: store.getState().source,
      timelineZoom: 92,
      timelineSettings: {
        mainTrackMagnet: true,
        autoSnap: true,
        linkage: true,
        previewAxis: true,
        captionFollow: true,
      },
      playhead: 0,
    })
    expect(store.getState().exportRange).toBeNull()

    store.getState().hydrateDraft({
      project,
      assets: store.getState().assets,
      source: store.getState().source,
      timelineZoom: 92,
      timelineSettings: {
        mainTrackMagnet: true,
        autoSnap: true,
        linkage: true,
        previewAxis: true,
        captionFollow: true,
        exportRange: { start: 9, end: 40 },
      },
      playhead: 0,
    })
    expect(store.getState().exportRange).toEqual({ start: 9, end: 12 })
  })
})