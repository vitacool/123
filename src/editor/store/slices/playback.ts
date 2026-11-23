import type { EditorState } from '../editorStore'
import type { StoreGet, StoreInternals, StoreSet } from '../internal'
import { TIMELINE_DEFAULT_ZOOM, TIMELINE_MAX_ZOOM, TIMELINE_MIN_ZOOM } from '../../core/constants'
import { clamp, getProjectEnd, snapToMarker } from '../../core/timeline'
import { collectEditPoints, fitZoom, nextEditPoint, stepByFrames, stepBySeconds } from '../../core/playhead'


/** playback slice：播放头、播放状态与时间轴缩放/视口 */
export type PlaybackSlice = Pick<EditorState, 'playhead' | 'isPlaying' | 'timelineZoom' | 'timelineViewportWidth' | 'setPlayhead' | 'stepPlayheadFrames' | 'nudgePlayhead' | 'jumpToEditPoint' | 'zoomToFit' | 'setTimelineViewportWidth' | 'setPlaying' | 'togglePlay' | 'replay' | 'finishPlayback' | 'setTimelineZoom'>

export function createPlaybackSlice(ctx: {
  get: StoreGet
  set: StoreSet
  internals: StoreInternals
}): PlaybackSlice {
  const { get, set, internals } = ctx
  void internals
  return {
    playhead: 0,
    isPlaying: false,
    timelineZoom: TIMELINE_DEFAULT_ZOOM,
    timelineViewportWidth: 960,
    setPlayhead: (time, snapThreshold = 0) => {
      const state = get()
      const total = getProjectEnd(state.project)
      const snapped = snapThreshold > 0 ? snapToMarker(time, state.project.markers, snapThreshold) : time
      set({ playhead: clamp(snapped, 0, Math.max(0, total)) })
    },
    stepPlayheadFrames: (frames) => {
      const state = get()
      const total = getProjectEnd(state.project)
      const fps = state.project.exportQuality.fps
      set({
        playhead: stepByFrames(state.playhead, frames, fps, total),
        isPlaying: false,
      })
    },
    nudgePlayhead: (seconds) => {
      const state = get()
      const total = getProjectEnd(state.project)
      set({ playhead: stepBySeconds(state.playhead, seconds, total), isPlaying: false })
    },
    jumpToEditPoint: (direction) => {
      const state = get()
      const points = collectEditPoints(state.project)
      const target = nextEditPoint(points, state.playhead, direction)
      if (target === null) return
      set({ playhead: target, isPlaying: false })
    },
    zoomToFit: () => {
      const state = get()
      const total = getProjectEnd(state.project)
      set({
        timelineZoom: fitZoom(
          total,
          state.timelineViewportWidth,
          TIMELINE_MIN_ZOOM,
          TIMELINE_MAX_ZOOM,
        ),
      })
    },
    setTimelineViewportWidth: (width) => {
      if (width > 0) set({ timelineViewportWidth: width })
    },
    setPlaying: (playing) => {
      const state = get()
      const total = getProjectEnd(state.project)
      if (total <= 0) {
        set({ isPlaying: false })
        return
      }
      if (playing && state.playhead >= total - 0.001) {
        set({ playhead: 0, isPlaying: true })
        return
      }
      set({ isPlaying: playing })
    },
    togglePlay: () => {
      const state = get()
      state.setPlaying(!state.isPlaying)
    },
    replay: () => {
      const state = get()
      if (getProjectEnd(state.project) <= 0) return
      set({ playhead: 0, isPlaying: true, previewPatch: null })
    },
    finishPlayback: () => {
      const total = getProjectEnd(get().project)
      set({ isPlaying: false, playhead: total })
    },
    setTimelineZoom: (zoom) => {
      set({ timelineZoom: clamp(zoom, TIMELINE_MIN_ZOOM, TIMELINE_MAX_ZOOM) })
    },
  }
}
