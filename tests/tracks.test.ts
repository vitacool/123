import { describe, expect, it } from 'vitest'
import {
  anySoloActive,
  audioTrackState,
  isAudioSuppressedBySolo,
  isAudioTrackActive,
  isMainAudioActive,
  isMainVideoVisible,
  isOverlayVideoVisible,
  mainTrackState,
  overlayTrackState,
} from '../src/editor/core/tracks'
import { addAudioClipToProject, addAudioTrackToProject } from '../src/editor/core/audio'
import { buildExportPlan } from '../src/editor/core/exportPlan'
import { addOverlayTrackFromClip, createInitialProject } from '../src/editor/core/operations'
import type { AudioTrack, Project, SourceInfo } from '../src/editor/core/types'

function base(): Project {
  return createInitialProject({ url: 'blob:video', duration: 10 }, 'clip-a')
}

function withAudioTracks(): Project {
  let project = addAudioTrackToProject(base(), 'a1').project
  project = addAudioTrackToProject(project, 'a2').project
  project = addAudioClipToProject(project, 'a1', {
    id: 'ac1',
    sourceUrl: 'blob:music',
    sourceStart: 0,
    sourceEnd: 3,
    start: 0,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
  })!
  project = addAudioClipToProject(project, 'a2', {
    id: 'ac2',
    sourceUrl: 'blob:music',
    sourceStart: 0,
    sourceEnd: 3,
    start: 0,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
  })!
  return project
}

function updateAudioTrack(
  project: Project,
  trackId: string,
  patch: Partial<AudioTrack>,
): Project {
  return {
    ...project,
    audioTracks: (project.audioTracks ?? []).map((track) =>
      track.id === trackId ? { ...track, ...patch } : track,
    ),
  }
}

describe('track-aware export', () => {
  const VIDEO: SourceInfo = {
    url: 'blob:video',
    name: 'video.mp4',
    size: 1000,
    duration: 10,
    width: 1920,
    height: 1080,
  }
  const MUSIC1: SourceInfo = {
    url: 'blob:music1',
    name: 'music1.mp3',
    size: 100,
    duration: 10,
    width: 0,
    height: 0,
    kind: 'audio',
  }
  const MUSIC2: SourceInfo = { ...MUSIC1, url: 'blob:music2', name: 'music2.mp3' }

  it('renders main video as black when hidden but keeps its audio', () => {
    const project = {
      ...base(),
      mainTrack: { ...mainTrackState(base()), hidden: true },
    }
    const plan = buildExportPlan(project, VIDEO, true)
    expect(plan.graph).toContain('color=c=black')
    expect(plan.graph).not.toContain('[0:v]')
    expect(plan.graph).toContain('[0:a]')
    expect(plan.hasAudio).toBe(true)
  })

  it('disables both picture and audio when the main track is powered off', () => {
    const project = {
      ...base(),
      mainTrack: { ...mainTrackState(base()), enabled: false },
    }
    const plan = buildExportPlan(project, VIDEO, true)
    expect(plan.graph).toContain('color=c=black')
    expect(plan.hasAudio).toBe(false)
    expect(plan.graph).not.toContain('[0:a]')
  })

  it('skips hidden/disabled overlay tracks', () => {
    const overlay = addOverlayTrackFromClip(base(), 'clip-a', 'o1', 'oc1')!.project
    const hidden = {
      ...overlay,
      overlayTracks: overlay.overlayTracks!.map((track) => ({ ...track, hidden: true })),
    }
    const disabled = {
      ...overlay,
      overlayTracks: overlay.overlayTracks!.map((track) => ({ ...track, enabled: false })),
    }
    for (const project of [hidden, disabled]) {
      const plan = buildExportPlan(project, VIDEO, true)
      expect(plan.graph).not.toContain('[1:v]')
    }
  })

  it('mixes only solo tracks and ignores muted or disabled audio tracks', () => {
    let project = addAudioTrackToProject(base(), 'a1').project
    project = addAudioTrackToProject(project, 'a2').project
    project = addAudioClipToProject(project, 'a1', {
      id: 'ac1',
      sourceUrl: MUSIC1.url,
      sourceStart: 0,
      sourceEnd: 2,
      start: 0,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
    })!
    project = addAudioClipToProject(project, 'a2', {
      id: 'ac2',
      sourceUrl: MUSIC2.url,
      sourceStart: 0,
      sourceEnd: 2,
      start: 0,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
    })!
    const solo = updateAudioTrack(project, 'a2', { solo: true })
    const plan = buildExportPlan(solo, [VIDEO, MUSIC1, MUSIC2], true)
    expect(plan.inputs).toHaveLength(2)
    expect(plan.inputs[1].url).toBe(MUSIC2.url)
    expect(plan.inputs.some((input) => input.url === MUSIC1.url)).toBe(false)
    expect(plan.graph).toContain('[1:a]')
    expect(plan.graph).toContain('amix=inputs=2')

    const muted = updateAudioTrack(updateAudioTrack(project, 'a1', { muted: true }), 'a2', {
      muted: true,
    })
    const mutedPlan = buildExportPlan(muted, [VIDEO, MUSIC1, MUSIC2], true)
    expect(mutedPlan.graph).not.toContain('amix')

    const disabled = updateAudioTrack(updateAudioTrack(project, 'a1', { enabled: false }), 'a2', {
      enabled: false,
    })
    expect(buildExportPlan(disabled, [VIDEO, MUSIC1, MUSIC2], true).graph).not.toContain('amix')
  })
})

describe('track state semantics', () => {
  it('defaults every track to enabled/unlocked/visible/audible', () => {
    const project = base()
    expect(mainTrackState(project)).toEqual({
      enabled: true,
      locked: false,
      hidden: false,
      muted: false,
      solo: false,
    })
    const overlay = addOverlayTrackFromClip(project, 'clip-a', 'o1', 'oc1')!.project
    const state = overlayTrackState(overlay.overlayTracks![0])
    expect(state.enabled).toBe(true)
    expect(state.hidden).toBe(false)
  })

  it('keeps eye and mute independent and lets power disable everything', () => {
    let project = base()
    project = { ...project, mainTrack: { ...mainTrackState(project), hidden: true } }
    expect(isMainVideoVisible(project)).toBe(false)
    expect(isMainAudioActive(project)).toBe(true)

    project = { ...project, mainTrack: { ...mainTrackState(project), muted: true } }
    expect(isMainAudioActive(project)).toBe(false)

    project = { ...project, mainTrack: { ...mainTrackState(project), enabled: false } }
    expect(isMainVideoVisible(project)).toBe(false)
    expect(isMainAudioActive(project)).toBe(false)
  })

  it('supports multiple solo tracks and restores mute state afterwards', () => {
    let project = withAudioTracks()
    const muted = updateAudioTrack(project, 'a1', { muted: true })
    const solo = updateAudioTrack(muted, 'a2', { solo: true })
    expect(anySoloActive(solo)).toBe(true)
    expect(isAudioTrackActive(solo, solo.audioTracks![0])).toBe(false)
    expect(isAudioTrackActive(solo, solo.audioTracks![1])).toBe(true)

    const bothSolo = updateAudioTrack(solo, 'a1', { solo: true })
    expect(isAudioTrackActive(bothSolo, bothSolo.audioTracks![0])).toBe(true)
    expect(isAudioTrackActive(bothSolo, bothSolo.audioTracks![1])).toBe(true)

    const restored = updateAudioTrack(bothSolo, 'a2', { solo: false })
    expect(isAudioTrackActive(restored, restored.audioTracks![0])).toBe(true)
    // a1 is still solo, so only a1 is audible; a2's own mute flag is unchanged (false).
    expect(restored.audioTracks![1].muted).toBe(false)

    const noSolo = updateAudioTrack(restored, 'a1', { solo: false })
    expect(noSolo.audioTracks![0].muted).toBe(true)
    expect(isAudioTrackActive(noSolo, noSolo.audioTracks![0])).toBe(false)
    expect(isAudioTrackActive(noSolo, noSolo.audioTracks![1])).toBe(true)
  })

  it('marks non-solo tracks as suppressed without changing their mute flags', () => {
    const project = withAudioTracks()
    const solo = updateAudioTrack(project, 'a2', { solo: true })
    const first = audioTrackState(solo.audioTracks![0])
    expect(isAudioSuppressedBySolo(solo, first)).toBe(true)
    expect(solo.audioTracks![0].muted).toBe(false)
  })

  it('lets overlay eye hide video without touching audio flags', () => {
    const project = addOverlayTrackFromClip(base(), 'clip-a', 'o1', 'oc1')!.project
    const track = project.overlayTracks![0]
    expect(isOverlayVideoVisible({ ...track, hidden: true })).toBe(false)
    expect(isOverlayVideoVisible({ ...track, enabled: false })).toBe(false)
    expect(overlayTrackState({ ...track, hidden: true }).muted).toBe(track.muted)
  })
})