import type { AudioClip, AudioTrack, Project } from './types'
import { clipSpeed, clipTimelineDuration } from './clipTime'
import { fadeProgress } from './clipAudio'
import { isAudioLocked } from './tracks'

export const AUDIO_MIN_DURATION = 0.05

export interface AudioClipLocation {
  track: AudioTrack
  clip: AudioClip
  index: number
}

export function audioClipDuration(clip: AudioClip): number {
  return Math.max(0, clipTimelineDuration(clip))
}

export function audioClipEnd(clip: AudioClip): number {
  return clip.start + audioClipDuration(clip)
}

export function audioTrackEnd(track: AudioTrack): number {
  let end = 0
  for (const clip of track.clips) end = Math.max(end, audioClipEnd(clip))
  return end
}

export function audioProjectEnd(project: Project): number {
  let end = 0
  for (const track of project.audioTracks ?? []) end = Math.max(end, audioTrackEnd(track))
  return end
}

export function sortAudioClips(clips: AudioClip[]): AudioClip[] {
  return [...clips].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))
}

export function findAudioClipLocation(
  project: Project,
  id: string | null,
): AudioClipLocation | null {
  if (!id) return null
  for (const track of project.audioTracks ?? []) {
    const index = track.clips.findIndex((clip) => clip.id === id)
    if (index >= 0) return { track, clip: track.clips[index], index }
  }
  return null
}

export function updateAudioTrackInProject(
  project: Project,
  trackId: string,
  update: Partial<
    Pick<AudioTrack, 'name' | 'muted' | 'hidden' | 'volume' | 'enabled' | 'locked' | 'solo'>
  >,
): Project | null {
  const tracks = project.audioTracks ?? []
  if (!tracks.some((track) => track.id === trackId)) return null
  return {
    ...project,
    audioTracks: tracks.map((track) =>
      track.id === trackId ? { ...track, ...update } : track,
    ),
  }
}

export function addAudioTrackToProject(
  project: Project,
  trackId: string,
): { project: Project; track: AudioTrack } {
  const tracks = project.audioTracks ?? []
  const track: AudioTrack = {
    id: trackId,
    name: `音频轨 ${tracks.length + 1}`,
    muted: false,
    hidden: false,
    enabled: true,
    locked: false,
    solo: false,
    volume: 1,
    clips: [],
  }
  return { project: { ...project, audioTracks: [...tracks, track] }, track }
}

export function removeAudioTrackFromProject(project: Project, trackId: string): Project | null {
  const tracks = project.audioTracks ?? []
  if (!tracks.some((track) => track.id === trackId)) return null
  return { ...project, audioTracks: tracks.filter((track) => track.id !== trackId) }
}

function resolveAudioStart(
  clips: AudioClip[],
  clipId: string,
  duration: number,
  desired: number,
): number {
  let start = Math.max(0, desired)
  const others = clips
    .filter((clip) => clip.id !== clipId)
    .sort((a, b) => a.start - b.start)
  let changed = true
  while (changed) {
    changed = false
    for (const other of others) {
      if (start < audioClipEnd(other) && start + duration > other.start) {
        start = audioClipEnd(other)
        changed = true
      }
    }
  }
  return start
}

export function addAudioClipToProject(
  project: Project,
  trackId: string,
  clip: AudioClip,
  trackName?: string,
): Project | null {
  const tracks = project.audioTracks ?? []
  let nextTracks = tracks
  let target = tracks.find((track) => track.id === trackId)
  if (!target) {
    target = {
      id: trackId,
      name: trackName ?? `音频轨 ${tracks.length + 1}`,
      muted: false,
      hidden: false,
      enabled: true,
      locked: false,
      solo: false,
      volume: 1,
      clips: [],
    }
    nextTracks = [...tracks, target]
  }
  const start = resolveAudioStart(target.clips, clip.id, audioClipDuration(clip), clip.start)
  const inserted: AudioClip = { ...clip, start }
  return {
    ...project,
    audioTracks: nextTracks.map((track) =>
      track.id === trackId
        ? { ...track, clips: sortAudioClips([...track.clips, inserted]) }
        : track,
    ),
  }
}

export function updateAudioClipInProject(
  project: Project,
  trackId: string,
  clipId: string,
  update: Partial<Omit<AudioClip, 'id'>>,
): Project | null {
  const tracks = project.audioTracks ?? []
  const track = tracks.find((item) => item.id === trackId)
  if (!track || !track.clips.some((clip) => clip.id === clipId)) return null
  const clips = track.clips.map((clip) =>
    clip.id === clipId ? { ...clip, ...update } : clip,
  )
  return {
    ...project,
    audioTracks: tracks.map((item) =>
      item.id === trackId ? { ...item, clips: sortAudioClips(clips) } : item,
    ),
  }
}

/** 换素材时把源区间夹到新素材时长内；保留尽量多的原入出点。 */
export function replacedAudioSourcePatch(
  clip: AudioClip,
  sourceUrl: string,
  sourceDuration: number,
): Pick<AudioClip, 'sourceUrl' | 'sourceStart' | 'sourceEnd'> {
  const duration = Number.isFinite(sourceDuration) ? Math.max(0.05, sourceDuration) : 0.05
  const start = Math.min(Math.max(0, clip.sourceStart), Math.max(0, duration - 0.05))
  const end = Math.min(duration, Math.max(start + 0.05, clip.sourceEnd))
  return { sourceUrl, sourceStart: start, sourceEnd: end }
}

export function removeAudioClipFromProject(
  project: Project,
  trackId: string,
  clipId: string,
): Project | null {
  const tracks = project.audioTracks ?? []
  const track = tracks.find((item) => item.id === trackId)
  if (!track || !track.clips.some((clip) => clip.id === clipId)) return null
  return {
    ...project,
    audioTracks: tracks.map((item) =>
      item.id === trackId
        ? { ...item, clips: item.clips.filter((clip) => clip.id !== clipId) }
        : item,
    ),
  }
}

export function moveAudioClipInProject(
  project: Project,
  trackId: string,
  clipId: string,
  start: number,
): Project | null {
  const tracks = project.audioTracks ?? []
  const track = tracks.find((item) => item.id === trackId)
  if (!track) return null
  const clip = track.clips.find((item) => item.id === clipId)
  if (!clip) return null
  const nextStart = resolveAudioStart(
    track.clips,
    clipId,
    audioClipDuration(clip),
    start,
  )
  if (Math.abs(nextStart - clip.start) < 0.0001) return null
  return updateAudioClipInProject(project, trackId, clipId, { start: nextStart })
}

export function resizeAudioClipInProject(
  project: Project,
  trackId: string,
  clipId: string,
  edge: 'left' | 'right',
  delta: number,
  sourceDuration: number,
): Project | null {
  const location = findAudioClipLocation(project, clipId)
  if (!location || location.track.id !== trackId) return null
  const { clip } = location
  if (!Number.isFinite(delta) || Math.abs(delta) < 0.0001) return null
  const duration = audioClipDuration(clip)
  if (duration <= 0) return null
  // 音频只支持单一倍率；源时间与时间轴时间的换算 = ×speed。
  const speed = clipSpeed(clip)

  if (edge === 'left') {
    const maxExtend = Math.min(clip.sourceStart / speed, clip.start)
    const minDelta = -maxExtend
    const maxDelta = duration - AUDIO_MIN_DURATION
    const actual = Math.min(maxDelta, Math.max(minDelta, delta))
    if (Math.abs(actual) < 0.0001) return null
    return updateAudioClipInProject(project, trackId, clipId, {
      start: clip.start + actual,
      sourceStart: clip.sourceStart + actual * speed,
    })
  }

  const maxExtend = Math.max(0, (sourceDuration - clip.sourceEnd) / speed)
  const minDelta = -(duration - AUDIO_MIN_DURATION)
  const actual = Math.min(maxExtend, Math.max(minDelta, delta))
  if (Math.abs(actual) < 0.0001) return null
  return updateAudioClipInProject(project, trackId, clipId, {
    sourceEnd: clip.sourceEnd + actual * speed,
  })
}

/** Gain multiplier for a clip at a local playhead time, including fades. */
export function audioFadeGain(clip: AudioClip, localTime: number): number {
  const duration = audioClipDuration(clip)
  if (duration <= 0) return 0
  let gain = 1
  if (clip.fadeIn > 0.001 && localTime < clip.fadeIn) {
    gain *= fadeProgress(localTime / clip.fadeIn, clip.fadeInCurve)
  }
  const fadeOutStart = duration - clip.fadeOut
  if (clip.fadeOut > 0.001 && localTime > fadeOutStart) {
    gain *= fadeProgress((duration - localTime) / clip.fadeOut, clip.fadeOutCurve)
  }
  return Math.max(0, gain)
}

export interface AudioActionAvailability {
  canSplit: boolean
  canTrimLeft: boolean
  canTrimRight: boolean
}

export function getAudioActionAvailability(
  project: Project,
  clipId: string | null,
  playhead: number,
): AudioActionAvailability {
  const location = findAudioClipLocation(project, clipId)
  if (!location) {
    return { canSplit: false, canTrimLeft: false, canTrimRight: false }
  }
  const duration = audioClipDuration(location.clip)
  if (isAudioLocked(location.track)) {
    return { canSplit: false, canTrimLeft: false, canTrimRight: false }
  }
  const local = playhead - location.clip.start
  const inside = local > AUDIO_MIN_DURATION && local < duration - AUDIO_MIN_DURATION
  return { canSplit: inside, canTrimLeft: inside, canTrimRight: inside }
}

export function splitAudioClipInProject(
  project: Project,
  trackId: string,
  clipId: string,
  time: number,
  rightId: string,
): Project | null {
  const location = findAudioClipLocation(project, clipId)
  if (!location || location.track.id !== trackId) return null
  const clips = location.track.clips
  const duration = audioClipDuration(location.clip)
  const local = time - location.clip.start
  if (local <= AUDIO_MIN_DURATION || local >= duration - AUDIO_MIN_DURATION) return null
  const splitSource = location.clip.sourceStart + local * clipSpeed(location.clip)
  const left: AudioClip = { ...location.clip, sourceEnd: splitSource }
  const right: AudioClip = {
    ...location.clip,
    id: rightId,
    sourceStart: splitSource,
    start: time,
  }
  const next = [...clips]
  next.splice(location.index, 1, left, right)
  return {
    ...project,
    audioTracks: (project.audioTracks ?? []).map((track) =>
      track.id === trackId ? { ...track, clips: sortAudioClips(next) } : track,
    ),
  }
}

export function trimAudioClipAt(
  project: Project,
  trackId: string,
  clipId: string,
  time: number,
  edge: 'left' | 'right',
): Project | null {
  const location = findAudioClipLocation(project, clipId)
  if (!location || location.track.id !== trackId) return null
  const clip = location.clip
  const duration = audioClipDuration(clip)
  const local = time - clip.start
  if (local <= AUDIO_MIN_DURATION || local >= duration - AUDIO_MIN_DURATION) return null
  const speed = clipSpeed(clip)
  if (edge === 'left') {
    return updateAudioClipInProject(project, trackId, clipId, {
      sourceStart: clip.sourceStart + local * speed,
      start: time,
    })
  }
  return updateAudioClipInProject(project, trackId, clipId, {
    sourceEnd: clip.sourceStart + local * speed,
  })
}