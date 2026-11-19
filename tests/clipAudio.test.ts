import { describe, expect, it } from 'vitest'
import {
  clipFadeIn,
  clipFadeOut,
  clipGainAt,
  clipVolume,
  DEFAULT_CLIP_VOLUME,
  hasClipAudioSettings,
} from '../src/editor/core/clipAudio'
import { createDetachAudioCommand } from '../src/editor/core/commands'
import { HistoryStack } from '../src/editor/core/history'
import { createClip, createInitialProject } from '../src/editor/core/operations'
import type { Project } from '../src/editor/core/types'

describe('clipAudio 片段音频参数（旧草稿默认值）', () => {
  it('缺省 volume=1、fade=0', () => {
    const clip = createClip('a', 0, 4)
    expect(clipVolume(clip)).toBe(DEFAULT_CLIP_VOLUME)
    expect(clipFadeIn(clip)).toBe(0)
    expect(clipFadeOut(clip)).toBe(0)
    expect(hasClipAudioSettings(clip)).toBe(false)
  })

  it('volume 夹在 0–2', () => {
    expect(clipVolume(createClip('a', 0, 4, { volume: 1.5 }))).toBe(1.5)
    expect(clipVolume(createClip('a', 0, 4, { volume: 9 }))).toBe(2)
    expect(clipVolume(createClip('a', 0, 4, { volume: -1 }))).toBe(0)
    expect(clipVolume(createClip('a', 0, 4, { volume: Number.NaN }))).toBe(1)
  })

  it('淡入淡出不超过片段时长', () => {
    const clip = createClip('a', 0, 4, { fadeIn: 10, fadeOut: -2 })
    expect(clipFadeIn(clip)).toBe(4)
    expect(clipFadeOut(clip)).toBe(0)
  })

  it('增益包络：中段为 volume，首尾按淡入淡出线性衰减', () => {
    const clip = createClip('a', 0, 4, { volume: 0.5, fadeIn: 1, fadeOut: 2 })
    expect(clipGainAt(clip, 0)).toBeCloseTo(0)
    expect(clipGainAt(clip, 0.5)).toBeCloseTo(0.25)
    expect(clipGainAt(clip, 2)).toBeCloseTo(0.5)
    expect(clipGainAt(clip, 3)).toBeCloseTo(0.25)
    expect(clipGainAt(clip, 4)).toBeCloseTo(0)
  })

  it('未设置 fade 时全程为 volume', () => {
    const clip = createClip('a', 0, 4, { volume: 1.4 })
    expect(clipGainAt(clip, 0)).toBeCloseTo(1.4)
    expect(clipGainAt(clip, 2)).toBeCloseTo(1.4)
    expect(clipGainAt(clip, 4)).toBeCloseTo(1.4)
  })
})

function projectWithClip(): Project {
  const base = createInitialProject({ url: 'a', duration: 10 }, 'c1')
  return { ...base, clips: [createClip('a', 0, 4, { volume: 1.6, fadeIn: 0.5, fadeOut: 0.5 }, 'c1')] }
}

describe('分离音频命令', () => {
  it('生成同起止的音频片段，原片段音量置 0，可一次撤销', () => {
    const before = projectWithClip()
    const history = new HistoryStack(before)
    const result = history.execute(
      createDetachAudioCommand({ clipId: 'c1', audioTrackId: 'at', audioClipId: 'ac1' }),
    )
    expect(result.changed).toBe(true)

    const after = result.project
    const audio = (after.audioTracks ?? [])[0]
    expect(audio.clips).toHaveLength(1)
    expect(audio.clips[0]).toMatchObject({
      id: 'ac1',
      sourceUrl: 'a',
      sourceStart: 0,
      sourceEnd: 4,
      start: 0,
      volume: 1.6,
      fadeIn: 0.5,
      fadeOut: 0.5,
    })
    // 原片段静音且淡入淡出清零
    expect(after.clips[0]).toMatchObject({ volume: 0, fadeIn: 0, fadeOut: 0 })

    const undone = history.undo()
    expect(undone?.before).toEqual(before)
  })

  it('自动新建音频轨', () => {
    const after = createDetachAudioCommand({
      clipId: 'c1',
      audioTrackId: 'new-track',
      audioClipId: 'ac1',
    }).execute(projectWithClip())
    expect((after.audioTracks ?? []).length).toBe(1)
    expect(after.audioTracks![0].id).toBe('new-track')
  })

  it('定格片段不产生音频', () => {
    const base = createInitialProject({ url: 'a', duration: 10 }, 'c1')
    const project: Project = {
      ...base,
      clips: [createClip('a', 0, 3, { type: 'freeze', freezeFrameTime: 0 }, 'f1')],
    }
    const after = createDetachAudioCommand({
      clipId: 'f1',
      audioTrackId: 'at',
      audioClipId: 'ac1',
    }).execute(project)
    expect(after).toBe(project)
  })

  it('主轨被锁定时不执行', () => {
    const before: Project = {
      ...projectWithClip(),
      mainTrack: { enabled: true, locked: true, hidden: false, muted: false, solo: false },
    }
    expect(
      createDetachAudioCommand({ clipId: 'c1', audioTrackId: 'at', audioClipId: 'ac1' }).execute(
        before,
      ),
    ).toBe(before)
  })
})