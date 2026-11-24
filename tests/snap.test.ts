import { describe, expect, it } from 'vitest'
import { collectSnapPoints, snapTime } from '../src/editor/core/snap'
import { createInitialProject, addOverlayTrackFromClip } from '../src/editor/core/operations'
import { addAudioClipToProject, addAudioTrackToProject } from '../src/editor/core/audio'
import type { Project } from '../src/editor/core/types'

const points = [
  { time: 0, label: '起点' },
  { time: 2, label: '片段边缘' },
  { time: 5, label: '播放头' },
]

describe('snapTime（阈值内最近吸附）', () => {
  it('取最近点', () => {
    expect(snapTime(2.08, points, 0.1)).toMatchObject({ time: 2, label: '片段边缘' })
  })

  it('超出阈值不吸附', () => {
    expect(snapTime(3.5, points, 0.2)).toBeNull()
  })

  it('非法值/阈值不吸附', () => {
    expect(snapTime(Number.NaN, points, 0.5)).toBeNull()
    expect(snapTime(2, points, 0)).toBeNull()
  })
})

describe('collectSnapPoints（时间轴吸附点集合）', () => {
  it('包含起点、播放头、标记与各轨片段边缘', () => {
    let project: Project = createInitialProject({ url: 'v', duration: 10 }, 'c1')
    project = { ...project, markers: [{ id: 'm1', time: 6, color: '#fff', note: '' }] }
    project = addOverlayTrackFromClip(project, 'c1', 'over', 'ov1')!.project
    project = addAudioTrackToProject(project, 'at').project
    project = addAudioClipToProject(project, 'at', {
      id: 'ac1',
      sourceUrl: 'a',
      sourceStart: 0,
      sourceEnd: 2,
      start: 3,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
    })!
    const result = collectSnapPoints(project, 4)
    expect(result.some((point) => point.label === '起点' && point.time === 0)).toBe(true)
    expect(result.some((point) => point.label === '播放头' && point.time === 4)).toBe(true)
    expect(result.some((point) => point.label === '标记' && point.time === 6)).toBe(true)
    // 音频片段 3..5 的右边缘
    expect(result.some((point) => point.time === 5 && point.label === '音频边缘')).toBe(true)
  })
})