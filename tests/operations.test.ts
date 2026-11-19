import { describe, expect, it } from 'vitest'
import {
  addMarkerToProject,
  addOverlayTrackFromClip,
  createInitialProject,
  insertFreezeAt,
  removeClipFromProject,
  removeOverlayTrackFromProject,
  moveClipToTrackAtTime,
  moveOverlayClipToTrack,
  reorderClipInProject,
  resizeClipEdge,
  resizeFreezeClip,
  resizeOverlayClipEdge,
  splitOverlayClipAt,
  splitProjectAt,
  trimOverlayClipAt,
  trimProjectLeft,
  trimProjectRight,
  updateClipInProject,
} from '../src/editor/core/operations'
import {
  getActionAvailability,
  getProjectDuration,
  getTimeline,
  snapToMarker,
} from '../src/editor/core/timeline'
import type { Clip, Project } from '../src/editor/core/types'

function makeProject(): Project {
  return createInitialProject({ url: 'blob:test', duration: 10 }, 'clip-a')
}

function styledProject(): Project {
  const project = makeProject()
  const clip: Clip = {
    ...project.clips[0],
    rotation: 35,
    flipH: true,
    flipV: true,
    crop: { x: 0.1, y: 0.2, w: 0.7, h: 0.6 },
    scale: 1.25,
    position: { x: 0.12, y: -0.08 },
  }
  return { ...project, clips: [clip] }
}

describe('splitProjectAt', () => {
  it('splits source in/out points and preserves every transform', () => {
    const project = styledProject()
    const split = splitProjectAt(project, 'clip-a', 4, 'clip-right')
    expect(split).not.toBeNull()
    expect(split!.clips).toHaveLength(2)
    const [left, right] = split!.clips
    expect(left.id).toBe('clip-a')
    expect(left.sourceStart).toBe(0)
    expect(left.sourceEnd).toBe(4)
    expect(right.id).toBe('clip-right')
    expect(right.sourceStart).toBe(4)
    expect(right.sourceEnd).toBe(10)
    expect(right.rotation).toBe(35)
    expect(right.flipH).toBe(true)
    expect(right.flipV).toBe(true)
    expect(right.crop).toEqual({ x: 0.1, y: 0.2, w: 0.7, h: 0.6 })
    expect(right.scale).toBe(1.25)
    expect(right.position).toEqual({ x: 0.12, y: -0.08 })
    expect(getProjectDuration(split!.clips)).toBeCloseTo(10, 5)
  })

  it('refuses to split at clip edges or with too-small pieces', () => {
    const project = makeProject()
    expect(splitProjectAt(project, 'clip-a', 0, 'r1')).toBeNull()
    expect(splitProjectAt(project, 'clip-a', 10, 'r1')).toBeNull()
    expect(splitProjectAt(project, 'clip-a', 0.01, 'r1')).toBeNull()
  })

  it('keeps the frozen frame after splitting a freeze clip', () => {
    const project = makeProject()
    const frozen = insertFreezeAt(project, 4, 'freeze-a', 3, 'split-right')!
    const freeze = frozen.project.clips.find((clip) => clip.id === 'freeze-a')!
    const split = splitProjectAt(frozen.project, 'freeze-a', 5.5, 'freeze-b')!
    const left = split.clips.find((clip) => clip.id === 'freeze-a')!
    const right = split.clips.find((clip) => clip.id === 'freeze-b')!
    expect(left.freezeFrameTime).toBe(freeze.freezeFrameTime)
    expect(right.freezeFrameTime).toBe(freeze.freezeFrameTime)
    expect((left.sourceEnd - left.sourceStart)).toBeCloseTo(1.5, 5)
    expect((right.sourceEnd - right.sourceStart)).toBeCloseTo(1.5, 5)
  })
})

describe('trim operations', () => {
  it('removes material left of the playhead and leaves a recoverable gap', () => {
    const trimmed = trimProjectLeft(makeProject(), 'clip-a', 3)!
    expect(trimmed.clips[0].sourceStart).toBe(3)
    expect(trimmed.clips[0].sourceEnd).toBe(10)
    expect(trimmed.clips[0].gapBefore).toBe(3)
    expect(getTimeline(trimmed.clips)[0].start).toBe(3)
    expect(getProjectDuration(trimmed.clips)).toBe(10)
  })

  it('pulls a trimmed left edge back into the retained source range', () => {
    const trimmed = trimProjectLeft(makeProject(), 'clip-a', 3)!
    const restored = resizeClipEdge(trimmed, 'clip-a', 'left', -3, 10)!
    expect(restored.clips[0].sourceStart).toBe(0)
    expect(restored.clips[0].gapBefore).toBe(0)
    expect(getProjectDuration(restored.clips)).toBe(10)
  })

  it('removes material right of the playhead', () => {
    const trimmed = trimProjectRight(makeProject(), 'clip-a', 7)!
    expect(trimmed.clips[0].sourceStart).toBe(0)
    expect(trimmed.clips[0].sourceEnd).toBe(7)
    expect(getProjectDuration(trimmed.clips)).toBe(7)
  })

  it('is disabled exactly at both clip edges', () => {
    const project = makeProject()
    expect(trimProjectLeft(project, 'clip-a', 0)).toBeNull()
    expect(trimProjectLeft(project, 'clip-a', 10)).toBeNull()
    expect(trimProjectRight(project, 'clip-a', 0)).toBeNull()
    expect(trimProjectRight(project, 'clip-a', 10)).toBeNull()
  })

  it('restores a right trim without losing the source range', () => {
    const trimmed = trimProjectRight(makeProject(), 'clip-a', 7)!
    expect(trimmed.clips[0].sourceEnd).toBe(7)
    const restored = resizeClipEdge(trimmed, 'clip-a', 'right', 3, 10)!
    expect(restored.clips[0].sourceEnd).toBe(10)
    expect(getProjectDuration(restored.clips)).toBe(10)
  })

  it('leaves a gap after a middle-clip right trim and restores it', () => {
    const split = splitProjectAt(makeProject(), 'clip-a', 4, 'clip-right')!
    const trimmed = trimProjectRight(split, 'clip-a', 3)!
    expect(trimmed.clips[0].sourceEnd).toBe(3)
    expect(trimmed.clips[1].gapBefore).toBe(1)
    expect(getTimeline(trimmed.clips).map((segment) => [segment.start, segment.end])).toEqual([
      [0, 3],
      [4, 10],
    ])
    const restored = resizeClipEdge(trimmed, 'clip-a', 'right', 1, 10)!
    expect(restored.clips[0].sourceEnd).toBe(4)
    expect(restored.clips[1].gapBefore).toBe(0)
    expect(getProjectDuration(restored.clips)).toBe(10)
  })
})

describe('freeze insertion', () => {
  it('splits the source clip and inserts three seconds at the playhead', () => {
    const insertion = insertFreezeAt(makeProject(), 4, 'freeze-a', 3, 'clip-right')!
    const clips = insertion.project.clips
    expect(clips).toHaveLength(3)
    expect(clips.map((clip) => clip.id)).toEqual(['clip-a', 'freeze-a', 'clip-right'])
    expect(clips[0].sourceEnd).toBe(4)
    expect(clips[1].type).toBe('freeze')
    expect(clips[1].freezeFrameTime).toBe(4)
    expect(clips[1].sourceEnd - clips[1].sourceStart).toBe(3)
    expect(clips[2].sourceStart).toBe(4)
    expect(clips[2].sourceEnd).toBe(10)
    expect(getProjectDuration(clips)).toBe(13)
    expect(new Set(clips.map((clip) => clip.id)).size).toBe(3)
  })

  it('inserts at the beginning and end without splitting', () => {
    const atStart = insertFreezeAt(makeProject(), 0, 'freeze-start', 3, 'unused')!
    expect(atStart.project.clips.map((clip) => clip.id)).toEqual(['freeze-start', 'clip-a'])
    expect(atStart.freeze.sourceStart).toBe(0)
    expect(getProjectDuration(atStart.project.clips)).toBe(13)

    const atEnd = insertFreezeAt(makeProject(), 10, 'freeze-end', 3, 'unused')!
    expect(atEnd.project.clips.map((clip) => clip.id)).toEqual(['clip-a', 'freeze-end'])
    expect(atEnd.freeze.sourceStart).toBe(10)
    expect(getProjectDuration(atEnd.project.clips)).toBe(13)
  })

  it('inherits the active clip transforms', () => {
    const insertion = insertFreezeAt(styledProject(), 4, 'freeze-a', 3, 'clip-right')!
    const freeze = insertion.project.clips[1]
    expect(freeze.rotation).toBe(35)
    expect(freeze.flipH).toBe(true)
    expect(freeze.flipV).toBe(true)
    expect(freeze.crop).toEqual({ x: 0.1, y: 0.2, w: 0.7, h: 0.6 })
    expect(freeze.scale).toBe(1.25)
    expect(freeze.position).toEqual({ x: 0.12, y: -0.08 })
  })

  it('clamps freeze duration and supports resizing', () => {
    const insertion = insertFreezeAt(makeProject(), 4, 'freeze-a', 50, 'clip-right')!
    expect(insertion.project.clips[1].sourceEnd - insertion.project.clips[1].sourceStart).toBe(10)
    const resized = resizeFreezeClip(insertion.project, 'freeze-a', 0.1)!
    expect(resized.clips[1].sourceEnd - resized.clips[1].sourceStart).toBe(0.5)
  })

  it('inserts inside an existing gap without extending the timeline', () => {
    const project = makeProject()
    project.clips[0] = { ...project.clips[0], gapBefore: 4 }
    const insertion = insertFreezeAt(project, 2, 'freeze-gap', 2, 'unused')!
    expect(insertion.freeze.gapBefore).toBe(2)
    expect(getTimeline(insertion.project.clips).map((segment) => [segment.start, segment.end])).toEqual([
      [2, 4],
      [4, 14],
    ])
    expect(getProjectDuration(insertion.project.clips)).toBe(14)
  })

  it('deletes a clip and reorders clips while keeping their source ranges', () => {
    const split = splitProjectAt(makeProject(), 'clip-a', 4, 'clip-right')!
    const deleted = removeClipFromProject(split, 'clip-a')!
    expect(deleted.clips.map((clip) => clip.id)).toEqual(['clip-right'])
    expect(getTimeline(deleted.clips)[0].start).toBe(0)

    const reordered = reorderClipInProject(split, 'clip-right', 0)!
    expect(reordered.clips.map((clip) => clip.id)).toEqual(['clip-right', 'clip-a'])
    expect(getTimeline(reordered.clips).map((segment) => [segment.start, segment.end])).toEqual([
      [0, 6],
      [6, 10],
    ])
  })

  it('adds an overlay track from a base clip and updates its clip', () => {
    const project = makeProject()
    const added = addOverlayTrackFromClip(project, 'clip-a', 'track-over', 'overlay-clip')!
    expect(added.project.clips).toHaveLength(1)
    expect(added.project.overlayTracks).toHaveLength(1)
    expect(added.track.clips[0].gapBefore).toBe(0)
    expect(added.clip.scale).toBeLessThan(1)
    expect(added.clip.position.x).toBeGreaterThan(0)

    const updated = updateClipInProject(added.project, 'overlay-clip', { rotation: 45 })!
    expect(updated.clips[0].rotation).toBe(0)
    expect(updated.overlayTracks?.[0].clips[0].rotation).toBe(45)

    const removed = removeOverlayTrackFromProject(updated, 'track-over')!
    expect(removed.overlayTracks).toHaveLength(0)
  })

  it('moves a clip to an arbitrary start time with a gap', () => {
    const project = makeProject()
    const moved = moveClipToTrackAtTime(project, 'clip-a', null, 4)!
    expect(moved.clips[0].gapBefore).toBe(4)
    expect(getTimeline(moved.clips)[0].start).toBe(4)
    expect(getTimeline(moved.clips)[0].end).toBe(14)
    expect(getProjectDuration(moved.clips)).toBe(14)
  })

  it('moves a clip into occupied time and pushes the next clip', () => {
    const split = splitProjectAt(makeProject(), 'clip-a', 4, 'clip-right')!
    const moved = moveClipToTrackAtTime(split, 'clip-a', null, 5)!
    expect(getTimeline(moved.clips).map((segment) => [segment.start, segment.end])).toEqual([
      [5, 9],
      [9, 15],
    ])
    expect(moved.clips.map((clip) => clip.id)).toEqual(['clip-a', 'clip-right'])
  })

  it('compacts the main track when main-track magnet is enabled', () => {
    const split = splitProjectAt(makeProject(), 'clip-a', 4, 'clip-right')!
    const moved = moveClipToTrackAtTime(split, 'clip-a', null, 8, false, true)!
    expect(moved.clips.map((clip) => clip.id)).toEqual(['clip-right', 'clip-a'])
    expect(getTimeline(moved.clips).map((segment) => [segment.start, segment.end])).toEqual([
      [0, 6],
      [6, 10],
    ])
    expect(moved.clips.every((clip) => (clip.gapBefore ?? 0) === 0)).toBe(true)
  })

  it('shifts following clips by the move delta when linkage is enabled', () => {
    const split = splitProjectAt(makeProject(), 'clip-a', 4, 'clip-right')!
    const project = {
      ...split,
      clips: split.clips.map((clip, index) =>
        index === 1 ? { ...clip, gapBefore: 2 } : clip,
      ),
    }
    const moved = moveClipToTrackAtTime(project, 'clip-a', null, 1, true)!
    expect(getTimeline(moved.clips).map((segment) => [segment.start, segment.end])).toEqual([
      [1, 5],
      [7, 13],
    ])
  })

  it('moves an overlay clip between overlay tracks', () => {
    const first = addOverlayTrackFromClip(makeProject(), 'clip-a', 'track-1', 'overlay-1')!
    const second = addOverlayTrackFromClip(first.project, 'clip-a', 'track-2', 'overlay-2')!
    const moved = moveOverlayClipToTrack(second.project, 'track-1', 'overlay-1', 'track-2', 1, 4)!
    expect(moved.overlayTracks?.[0].clips).toHaveLength(0)
    expect(moved.overlayTracks?.[1].clips.map((clip) => clip.id)).toEqual(['overlay-2', 'overlay-1'])
    expect(moved.overlayTracks?.[1].clips[1].gapBefore).toBeGreaterThanOrEqual(0)
  })
})

describe('overlay clip editing', () => {
  it('splits, trims and restores overlay clips like main clips', () => {
    const base = makeProject()
    const project = addOverlayTrackFromClip(base, 'clip-a', 'track-o', 'overlay-a')!.project
    expect(getActionAvailability(project, 'overlay-a', 4).canSplit).toBe(true)
    expect(getActionAvailability(project, 'overlay-a', 0).canSplit).toBe(false)

    const split = splitOverlayClipAt(project, 'track-o', 'overlay-a', 4, 'overlay-b')!
    const [left, right] = split.overlayTracks![0].clips
    expect(left.sourceEnd).toBe(4)
    expect(right.id).toBe('overlay-b')
    expect(getTimeline(split.overlayTracks![0].clips)[1].start).toBe(4)
    expect(right.sourceStart).toBe(4)
    expect(right.sourceEnd).toBe(10)

    const trimmedLeft = trimOverlayClipAt(project, 'track-o', 'overlay-a', 3, 'left')!
    expect(trimmedLeft.overlayTracks![0].clips[0].sourceStart).toBe(3)
    expect(trimmedLeft.overlayTracks![0].clips[0].gapBefore).toBe(3)
    const restoredLeft = resizeOverlayClipEdge(
      trimmedLeft,
      'track-o',
      'overlay-a',
      'left',
      -3,
      10,
    )!
    expect(restoredLeft.overlayTracks![0].clips[0].sourceStart).toBe(0)
    expect(restoredLeft.overlayTracks![0].clips[0].gapBefore).toBe(0)

    const trimmedRight = trimOverlayClipAt(project, 'track-o', 'overlay-a', 7, 'right')!
    expect(trimmedRight.overlayTracks![0].clips[0].sourceEnd).toBe(7)
    const restoredRight = resizeOverlayClipEdge(
      trimmedRight,
      'track-o',
      'overlay-a',
      'right',
      3,
      10,
    )!
    expect(restoredRight.overlayTracks![0].clips[0].sourceEnd).toBe(10)
  })
})

describe('timeline helpers', () => {
  it('uses the next clip at an exact boundary', () => {
    const insertion = insertFreezeAt(makeProject(), 4, 'freeze-a', 3, 'clip-right')!
    const timeline = getTimeline(insertion.project.clips)
    expect(timeline.map((segment) => [segment.start, segment.end])).toEqual([
      [0, 4],
      [4, 7],
      [7, 13],
    ])
  })

  it('disables destructive buttons outside the selected clip', () => {
    const project = makeProject()
    expect(getActionAvailability(project, 'clip-a', 5)).toEqual({
      canSplit: true,
      canTrimLeft: true,
      canTrimRight: true,
      canFreeze: true,
      hasSelection: true,
    })
    expect(getActionAvailability(project, 'clip-a', 0).canSplit).toBe(false)
    expect(getActionAvailability(project, null, 5).canSplit).toBe(false)
    expect(getActionAvailability(project, 'clip-a', 11).canFreeze).toBe(false)
  })

  it('snaps to the nearest marker inside the threshold', () => {
    const project = addMarkerToProject(makeProject(), {
      id: 'm1',
      time: 4,
      color: '#e4573d',
      note: 'beat',
    })
    expect(snapToMarker(4.1, project.markers, 0.2)).toBe(4)
    expect(snapToMarker(4.5, project.markers, 0.2)).toBe(4.5)
  })
})