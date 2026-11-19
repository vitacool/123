import { describe, expect, it } from 'vitest'
import {
  projectMediaUrls,
  pruneProjectUrls,
  remapProjectUrls,
} from '../src/editor/core/draft'
import { addAudioClipToProject, addAudioTrackToProject } from '../src/editor/core/audio'
import { addOverlayTrackFromClip, createInitialProject } from '../src/editor/core/operations'
import type { Project } from '../src/editor/core/types'

function makeProject(): Project {
  const base = createInitialProject({ url: 'blob:main', duration: 8 }, 'clip-a')
  const overlay = addOverlayTrackFromClip(base, 'clip-a', 'track-o', 'overlay-a')!.project
  const withOverlayUrl: Project = {
    ...overlay,
    overlayTracks: overlay.overlayTracks!.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => ({ ...clip, sourceUrl: 'blob:overlay' })),
    })),
  }
  const withAudio = addAudioTrackToProject(withOverlayUrl, 'track-a').project
  return addAudioClipToProject(withAudio, 'track-a', {
    id: 'audio-a',
    sourceUrl: 'blob:music',
    sourceStart: 0,
    sourceEnd: 4,
    start: 1,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
  })!
}

describe('draft serialization helpers', () => {
  it('remaps every clip URL, including overlays and audio', () => {
    const project = makeProject()
    const map = new Map([
      ['blob:main', 'blob:restored-main'],
      ['blob:music', 'blob:restored-music'],
    ])
    const restored = remapProjectUrls(project, map)
    expect(restored.clips[0].sourceUrl).toBe('blob:restored-main')
    expect(restored.audioTracks?.[0].clips[0].sourceUrl).toBe('blob:restored-music')
    expect(restored.overlayTracks?.[0].clips[0].sourceUrl).toBe('blob:overlay')
  })

  it('prunes clips whose media did not come back and removes empty tracks', () => {
    const project = makeProject()
    const available = new Set(['blob:main'])
    const pruned = pruneProjectUrls(project, available)
    expect(pruned.clips).toHaveLength(1)
    expect(pruned.overlayTracks).toHaveLength(0)
    expect(pruned.audioTracks).toHaveLength(0)
  })

  it('collects every media URL used by the project', () => {
    const urls = projectMediaUrls(makeProject())
    expect(urls.has('blob:main')).toBe(true)
    expect(urls.has('blob:music')).toBe(true)
  })
})