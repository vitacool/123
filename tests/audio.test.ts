import { describe, expect, it } from 'vitest'
import {
  addAudioClipToProject,
  addAudioTrackToProject,
  audioClipEnd,
  audioFadeGain,
  getAudioActionAvailability,
  moveAudioClipInProject,
  replacedAudioSourcePatch,
  reverseAudioClipPatch,
  resizeAudioClipInProject,
  splitAudioClipInProject,
  trimAudioClipAt,
  updateAudioTrackInProject,
} from '../src/editor/core/audio'
import { createReplaceAudioSourceCommand } from '../src/editor/core/commands'
import { buildExportArgs, buildExportPlan } from '../src/editor/core/exportPlan'
import { createInitialProject } from '../src/editor/core/operations'
import { getProjectEnd } from '../src/editor/core/timeline'
import type { AudioClip, Project, SourceInfo } from '../src/editor/core/types'

const VIDEO: SourceInfo = {
  url: 'blob:video',
  name: 'source.mp4',
  size: 12_000,
  duration: 10,
  width: 1920,
  height: 1080,
  kind: 'video',
}

const AUDIO: SourceInfo = {
  url: 'blob:music',
  name: 'music.mp3',
  size: 5_000,
  duration: 8,
  width: 0,
  height: 0,
  kind: 'audio',
}

function makeClip(overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    id: 'audio-a',
    sourceUrl: AUDIO.url,
    sourceStart: 0,
    sourceEnd: 3,
    start: 2,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    ...overrides,
  }
}

function projectWithAudio(clip = makeClip()): Project {
  const base = createInitialProject({ url: VIDEO.url, duration: 10 }, 'clip-a')
  const added = addAudioTrackToProject(base, 'track-a')
  return addAudioClipToProject(added.project, 'track-a', clip)!
}

describe('audio timeline operations', () => {
  it('adds an audio track and clip, and extends the project end', () => {
    const project = projectWithAudio()
    expect(project.audioTracks).toHaveLength(1)
    expect(project.audioTracks![0].clips).toHaveLength(1)
    expect(project.audioTracks![0].clips[0].start).toBe(2)
    expect(audioClipEnd(project.audioTracks![0].clips[0])).toBe(5)
    expect(getProjectEnd(project)).toBe(10)

    const long = projectWithAudio(makeClip({ start: 8, sourceEnd: 8 }))
    expect(getProjectEnd(long)).toBe(16)
  })

  it('pushes overlapping clips to the next free slot', () => {
    let project = projectWithAudio(makeClip({ id: 'a', start: 2 }))
    project = addAudioClipToProject(
      project,
      'track-a',
      makeClip({ id: 'b', start: 3, sourceEnd: 4 }),
    )!
    const starts = project.audioTracks![0].clips
      .map((clip) => clip.start)
      .sort((a, b) => a - b)
    expect(starts).toEqual([2, 5])
  })

  it('moves and trims audio clips within source bounds', () => {
    const project = projectWithAudio()
    const moved = moveAudioClipInProject(project, 'track-a', 'audio-a', 4)
    expect(moved?.audioTracks?.[0].clips[0].start).toBe(4)

    const trimmed = resizeAudioClipInProject(project, 'track-a', 'audio-a', 'right', -1, 8)
    expect(trimmed?.audioTracks?.[0].clips[0].sourceEnd).toBe(2)
    const restored = resizeAudioClipInProject(trimmed!, 'track-a', 'audio-a', 'right', 1, 8)
    expect(restored?.audioTracks?.[0].clips[0].sourceEnd).toBe(3)

    const leftTrimmed = resizeAudioClipInProject(project, 'track-a', 'audio-a', 'left', 1, 8)
    expect(leftTrimmed?.audioTracks?.[0].clips[0].sourceStart).toBe(1)
    expect(leftTrimmed?.audioTracks?.[0].clips[0].start).toBe(3)
  })

  it('倒放：源区间镜像、淡化/曲线对调、音量关键帧镜像', () => {
    const clip = makeClip({
      sourceStart: 2,
      sourceEnd: 6,
      fadeIn: 1,
      fadeOut: 2,
      fadeInCurve: 'exp',
      fadeOutCurve: 'log',
      anim: {
        volume: [
          { t: 0.2, value: 2, ease: 'linear' },
          { t: 0.8, value: 0.5, ease: 'linear' },
        ],
      },
    })
    const patch = reverseAudioClipPatch(clip, 'blob:reversed', 8)
    // 8-6=2 .. 8-2=6（原区间对称，便于验证）
    expect(patch.sourceStart).toBe(2)
    expect(patch.sourceEnd).toBe(6)
    expect(patch.sourceUrl).toBe('blob:reversed')
    // 淡化值/曲线对调
    expect(patch.fadeIn).toBe(2)
    expect(patch.fadeOut).toBe(1)
    expect(patch.fadeInCurve).toBe('log')
    expect(patch.fadeOutCurve).toBe('exp')
    // 关键帧 t 镜像并重新排序
    const keys = patch.anim?.volume ?? []
    expect(keys[0].t).toBeCloseTo(0.2)
    expect(keys[0].value).toBe(0.5)
    expect(keys[1].t).toBeCloseTo(0.8)
    expect(keys[1].value).toBe(2)
  })

  it('换素材：源区间夹到新时长内，起点/音量/倍率保持不变', () => {
    const patch = replacedAudioSourcePatch(
      makeClip({ sourceStart: 2, sourceEnd: 6 }),
      'blob:new',
      4,
    )
    expect(patch).toEqual({ sourceUrl: 'blob:new', sourceStart: 2, sourceEnd: 4 })

    // 原入点超出新素材时长 → 夹到末尾前 0.05s。
    const clamped = replacedAudioSourcePatch(
      makeClip({ sourceStart: 8, sourceEnd: 9 }),
      'blob:new',
      5,
    )
    expect(clamped.sourceEnd).toBe(5)
    expect(clamped.sourceStart).toBeLessThan(clamped.sourceEnd)

    const project = projectWithAudio(
      makeClip({ start: 5, sourceStart: 2, sourceEnd: 6, volume: 1.2, speed: 2 }),
    )
    const next = createReplaceAudioSourceCommand(
      'track-a',
      'audio-a',
      'blob:new',
      4,
    ).execute(project)
    const replaced = next.audioTracks![0].clips[0]
    expect(replaced).toMatchObject({
      sourceUrl: 'blob:new',
      sourceStart: 2,
      sourceEnd: 4,
      start: 5,
      volume: 1.2,
      speed: 2,
    })
  })

  it('变速：时长按倍率缩短，分割/裁剪按倍率换算源区间', () => {
    const project = projectWithAudio(makeClip({ sourceEnd: 6, start: 2, speed: 2 }))
    const clip = project.audioTracks![0].clips[0]
    // 源跨度 6s / 2x = 3s → 2..5
    expect(audioClipEnd(clip)).toBe(5)

    // 时间轴 3s 处分割：local 1s × 2 = 源 2s
    const split = splitAudioClipInProject(project, 'track-a', 'audio-a', 3, 'audio-b')!
    expect(split.audioTracks![0].clips.map((item) => item.sourceEnd)).toContain(2)
    expect(split.audioTracks![0].clips.map((item) => item.sourceStart)).toContain(2)

    // 右裁到 3s：sourceEnd = 0 + 1s × 2 = 2
    const trimmed = trimAudioClipAt(project, 'track-a', 'audio-a', 3, 'right')!
    expect(trimmed.audioTracks![0].clips[0].sourceEnd).toBe(2)

    // 左裁到 3s：sourceStart = 2，start = 3
    const left = trimAudioClipAt(project, 'track-a', 'audio-a', 3, 'left')!
    expect(left.audioTracks![0].clips[0].sourceStart).toBe(2)
    expect(left.audioTracks![0].clips[0].start).toBe(3)

    // 右拉 1s 时间轴 → 源 +2s（6 → 8，正好到素材末尾）
    const resized = resizeAudioClipInProject(project, 'track-a', 'audio-a', 'right', 1, 8)!
    expect(resized.audioTracks![0].clips[0].sourceEnd).toBe(8)
  })

  it('变速音频导出用 atempo，时长按倍率计算', () => {
    const project = projectWithAudio(
      makeClip({ sourceEnd: 6, start: 0, speed: 2, keepPitch: true }),
    )
    const plan = buildExportPlan(project, [VIDEO, AUDIO], true)
    expect(plan.graph).toContain('atempo=2')
    expect(plan.totalDuration).toBe(10)
  })

  it('keepPitch=false 时音频导出改 asetrate', () => {
    const project = projectWithAudio(
      makeClip({ sourceEnd: 6, start: 0, speed: 2, keepPitch: false }),
    )
    const plan = buildExportPlan(project, [VIDEO, AUDIO], true)
    expect(plan.graph).toContain('asetrate=96000')
    expect(plan.graph).not.toContain('atempo=2')
  })

  it('updates track mute/volume and computes fade gain', () => {
    const project = projectWithAudio()
    const muted = updateAudioTrackInProject(project, 'track-a', { muted: true })
    expect(muted?.audioTracks?.[0].muted).toBe(true)
    const loud = updateAudioTrackInProject(project, 'track-a', { volume: 1.5 })
    expect(loud?.audioTracks?.[0].volume).toBe(1.5)

    const faded = makeClip({ fadeIn: 1, fadeOut: 1 })
    expect(audioFadeGain(faded, 0)).toBe(0)
    expect(audioFadeGain(faded, 0.5)).toBeCloseTo(0.5, 5)
    expect(audioFadeGain(faded, 2.5)).toBeCloseTo(0.5, 5)
    expect(audioFadeGain(faded, 3)).toBe(0)
  })

  it('splits and trims audio at the playhead', () => {
    const project = projectWithAudio(makeClip({ start: 2, sourceEnd: 6 }))
    expect(getAudioActionAvailability(project, 'audio-a', 2).canSplit).toBe(false)
    expect(getAudioActionAvailability(project, 'audio-a', 4).canSplit).toBe(true)

    const split = splitAudioClipInProject(project, 'track-a', 'audio-a', 4, 'audio-b')!
    expect(split.audioTracks![0].clips).toHaveLength(2)
    const [left, right] = split.audioTracks![0].clips
    expect(left.sourceEnd).toBe(2)
    expect(right.start).toBe(4)
    expect(right.sourceStart).toBe(2)
    expect(right.sourceEnd).toBe(6)

    const trimmedLeft = trimAudioClipAt(project, 'track-a', 'audio-a', 4, 'left')!
    expect(trimmedLeft.audioTracks![0].clips[0].start).toBe(4)
    expect(trimmedLeft.audioTracks![0].clips[0].sourceStart).toBe(2)

    const trimmedRight = trimAudioClipAt(project, 'track-a', 'audio-a', 4, 'right')!
    expect(trimmedRight.audioTracks![0].clips[0].sourceEnd).toBe(2)
  })
})

describe('audio export mixing', () => {
  it('adds an audio input, delays it and mixes it with the main audio', () => {
    const project = projectWithAudio(makeClip({ start: 8, sourceEnd: 8 }))
    const plan = buildExportPlan(project, [VIDEO, AUDIO], true)
    expect(plan.inputs).toHaveLength(2)
    expect(plan.inputs[1].kind).toBe('audio')
    expect(plan.totalDuration).toBe(16)
    expect(plan.hasAudio).toBe(true)
    expect(plan.graph).toContain('amix=inputs=2')
    expect(plan.graph).toContain('adelay=8000|8000')
    expect(plan.graph).toContain('volume=1')
    expect(plan.graph).toContain('tpad=stop_mode=add:stop_duration=6')
    expect(plan.graph).toContain('[outa]')
    const args = buildExportArgs(plan, 'graph.txt', 'out.mp4')
    expect(args.filter((value) => value === '-i')).toHaveLength(2)
  })

  it('adds fades and respects a muted track', () => {
    const faded = projectWithAudio(makeClip({ start: 2, fadeIn: 0.5, fadeOut: 0.5 }))
    const plan = buildExportPlan(faded, [VIDEO, AUDIO], true)
    expect(plan.graph).toContain('afade=t=in:st=0:d=0.5')
    expect(plan.graph).toContain('afade=t=out:st=2.5:d=0.5')

    const muted = updateAudioTrackInProject(faded, 'track-a', { muted: true })!
    const mutedPlan = buildExportPlan(muted, [VIDEO, AUDIO], true)
    expect(mutedPlan.graph).not.toContain('amix')
    expect(mutedPlan.inputs).toHaveLength(1)
  })
})