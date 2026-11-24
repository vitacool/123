import type { AudioTrack, OverlayTrack, Project, TextTrack, TrackState } from './types'

export type TrackKind = 'main' | 'overlay' | 'audio' | 'text'
export type TrackFlag = keyof TrackState

export const DEFAULT_TRACK_STATE: TrackState = {
  enabled: true,
  locked: false,
  hidden: false,
  muted: false,
  solo: false,
}

export function mainTrackState(project: Project): TrackState {
  return { ...DEFAULT_TRACK_STATE, ...project.mainTrack }
}

export function overlayTrackState(track: OverlayTrack): TrackState {
  return {
    enabled: track.enabled !== false,
    locked: track.locked === true,
    hidden: track.hidden === true,
    muted: track.muted === true,
    solo: track.solo === true,
  }
}

export function audioTrackState(track: AudioTrack): TrackState {
  return {
    enabled: track.enabled !== false,
    locked: track.locked === true,
    hidden: track.hidden === true,
    muted: track.muted === true,
    solo: track.solo === true,
  }
}

export function textTrackState(track: TextTrack): TrackState {
  return {
    enabled: track.enabled !== false,
    locked: track.locked === true,
    hidden: track.hidden === true,
    muted: track.muted === true,
    solo: track.solo === true,
  }
}

/** Solo is audio-only; enabled solo tracks suppress every other audio source. */
export function anySoloActive(project: Project): boolean {
  if (mainTrackState(project).enabled && mainTrackState(project).solo) return true
  if (
    (project.audioTracks ?? []).some((track) => {
      const state = audioTrackState(track)
      return state.enabled && state.solo
    })
  ) {
    return true
  }
  // 叠加轨也参与混音（导出 amix / 预览混音），它的 S 必须同样能压住其它音源；
  // 否则按钮可点但听感完全不变（曾经的死 UI）。
  return (project.overlayTracks ?? []).some((track) => {
    const state = overlayTrackState(track)
    return state.enabled && state.solo
  })
}

export function isMainVideoVisible(project: Project): boolean {
  const state = mainTrackState(project)
  return state.enabled && !state.hidden
}

export function isMainAudioActive(project: Project): boolean {
  const state = mainTrackState(project)
  if (!state.enabled) return false
  return anySoloActive(project) ? state.solo : !state.muted
}

export function isOverlayVideoVisible(track: OverlayTrack): boolean {
  const state = overlayTrackState(track)
  return state.enabled && !state.hidden
}

/**
 * 叠加轨的声音是否参与混音：轨道启用、未被静音，且没有被其它轨道的独奏压制。
 * 语义与音频轨一致，供预览与导出共用。
 */
export function isOverlayAudioActive(project: Project, track: OverlayTrack): boolean {
  const state = overlayTrackState(track)
  if (!state.enabled) return false
  return anySoloActive(project) ? state.solo : !state.muted
}

export function isTextTrackVisible(track: TextTrack): boolean {
  const state = textTrackState(track)
  return state.enabled && !state.hidden
}

export function isTextLocked(track: TextTrack): boolean {
  return textTrackState(track).locked
}

export function isAudioTrackActive(project: Project, track: AudioTrack): boolean {
  const state = audioTrackState(track)
  if (!state.enabled) return false
  return anySoloActive(project) ? state.solo : !state.muted
}

export function isMainLocked(project: Project): boolean {
  return mainTrackState(project).locked
}

export function isOverlayLocked(track: OverlayTrack): boolean {
  return overlayTrackState(track).locked
}

export function isAudioLocked(track: AudioTrack): boolean {
  return audioTrackState(track).locked
}

/** True when this audio-capable track is suppressed by another track's solo. */
export function isAudioSuppressedBySolo(
  project: Project,
  state: TrackState,
): boolean {
  return anySoloActive(project) && state.enabled && !state.solo
}