import { describe, expect, it } from 'vitest'
import {
  collectEditPoints,
  fitZoom,
  nextEditPoint,
  stepByFrames,
  stepBySeconds,
  TIMELINE_PAD,
  TIMELINE_TAIL,
} from '../src/editor/core/playhead'
import {
  addOverlayTrackFromClip,
  createClip,
  createEmptyProject,
  createInitialProject,
} from '../src/editor/core/operations'
import { addTextClipToProject, addTextTrackToProject } from '../src/editor/core/text'
import type { Project } from '../src/editor/core/types'

function baseProject(): Project {
  // 主轨两段：0-4、4-10（第二段从源 4s 起，总长 10s）
  const first = createInitialProject({ url: 'a', duration: 4 }, 'c1')
  const clips = [
    createClip('a', 0, 4, {}, 'c1'),
    createClip('a', 4, 10, {}, 'c2'),
  ]
  return {
    ...first,
    clips,
    markers: [{ id: 'm1', time: 6, color: '#f00', note: '' }],
  }
}

describe('collectEditPoints', () => {
  it('收集主轨片段边界、0 与结尾', () => {
    const points = collectEditPoints(baseProject(), { includeMarkers: false })
    expect(points).toEqual([0, 4, 10])
  })

  it('包含标记时间并去重排序', () => {
    const points = collectEditPoints(baseProject())
    expect(points).toEqual([0, 4, 6, 10])
  })

  it('合并叠加轨、音频轨、文本轨的边界', () => {
    let project = baseProject()
    project = addOverlayTrackFromClip(project, 'c1', 'ov', 'ovs')!.project
    project = addTextTrackToProject(project, 'cap', 'caption')
    project = addTextClipToProject(project, 'cap', {
      id: 't1',
      text: '你好',
      start: 2,
      end: 3,
      x: 0.5,
      y: 0.86,
      fontSize: 0.05,
      color: '#fff',
      background: 'transparent',
      align: 'center',
      bold: false,
    })!
    project = {
      ...project,
      audioTracks: [
        {
          id: 'at',
          name: '配音',
          muted: false,
          hidden: false,
          volume: 1,
          clips: [
            { id: 'ac', sourceUrl: 'a', sourceStart: 0, sourceEnd: 2, start: 7, volume: 1, fadeIn: 0, fadeOut: 0 },
          ],
        },
      ],
    }
    const points = collectEditPoints(project)
    expect(points).toContain(2)
    expect(points).toContain(3)
    expect(points).toContain(7)
    expect(points).toContain(9)
    expect(points).toEqual([...points].sort((a, b) => a - b))
  })

  it('空工程只返回 0', () => {
    expect(collectEditPoints(createEmptyProject())).toEqual([0])
  })

  it('includeBounds=false 时不额外补 0（0 只来自片段边界）', () => {
    // 首个片段带 2s 空隙，时间轴从 2s 开始。
    const first = createInitialProject({ url: 'a', duration: 4 }, 'c1')
    const gapped: Project = {
      ...first,
      clips: [createClip('a', 0, 4, { gapBefore: 2 }, 'c1')],
      markers: [],
    }
    expect(collectEditPoints(gapped, { includeBounds: false })).toEqual([2, 6])
    expect(collectEditPoints(gapped)).toEqual([0, 2, 6])
  })
})

describe('nextEditPoint', () => {
  const points = [0, 4, 6, 10]

  it('向前找最近的更小剪辑点', () => {
    expect(nextEditPoint(points, 7, 'prev')).toBe(6)
    expect(nextEditPoint(points, 4.5, 'prev')).toBe(4)
  })

  it('向后找最近的更大剪辑点', () => {
    expect(nextEditPoint(points, 7, 'next')).toBe(10)
    expect(nextEditPoint(points, 4.5, 'next')).toBe(6)
  })

  it('正好落在剪辑点上时跳到相邻点，不原地停留', () => {
    expect(nextEditPoint(points, 6, 'prev')).toBe(4)
    expect(nextEditPoint(points, 6, 'next')).toBe(10)
  })

  it('端点返回 null', () => {
    expect(nextEditPoint(points, 0, 'prev')).toBeNull()
    expect(nextEditPoint(points, 10, 'next')).toBeNull()
    expect(nextEditPoint([], 0, 'next')).toBeNull()
  })
})

describe('stepByFrames / stepBySeconds', () => {
  it('按 fps 逐帧步进', () => {
    expect(stepByFrames(1, 1, 30, 10)).toBeCloseTo(1 + 1 / 30)
    expect(stepByFrames(1, -1, 25, 10)).toBeCloseTo(1 - 1 / 25)
    expect(stepByFrames(1, 60, 60, 10)).toBeCloseTo(2)
  })

  it('夹在 [0, total]', () => {
    expect(stepByFrames(0, -10, 30, 10)).toBe(0)
    expect(stepByFrames(10, 10, 30, 10)).toBe(10)
  })

  it('非法 fps 回退 30', () => {
    expect(stepByFrames(1, 1, 0, 10)).toBeCloseTo(1 + 1 / 30)
    expect(stepByFrames(1, 1, Number.NaN, 10)).toBeCloseTo(1 + 1 / 30)
  })

  it('按秒步进并夹取', () => {
    expect(stepBySeconds(3, 1, 10)).toBe(4)
    expect(stepBySeconds(3, -10, 10)).toBe(0)
    expect(stepBySeconds(9.5, 1, 10)).toBe(10)
  })
})

describe('fitZoom', () => {
  it('让总时长恰好铺满可视宽度', () => {
    const viewport = 1000
    const total = 20
    const zoom = fitZoom(total, viewport, 24, 320)
    expect(zoom).toBeCloseTo((viewport - TIMELINE_PAD * 2 - TIMELINE_TAIL) / total)
  })

  it('受最小/最大缩放夹取', () => {
    expect(fitZoom(1000, 1000, 24, 320)).toBe(24)
    expect(fitZoom(0.5, 2000, 24, 320)).toBe(320)
  })

  it('空时间轴返回最大缩放', () => {
    expect(fitZoom(0, 1000, 24, 320)).toBe(320)
  })
})