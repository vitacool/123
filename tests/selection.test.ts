import { describe, expect, it } from 'vitest'
import {
  idsInRect,
  contiguousRunHeads,
  normalizeSelection,
  planBatchMove,
  primaryOf,
  rangeSelection,
  toggleSelection,
} from '../src/editor/core/selection'
import { getTimeline as getTimelineFor } from '../src/editor/core/timeline'
import {
  applyPastePlan,
  buildClipboardPayload,
  findFreeSlot,
  planPaste,
  type IdFactory,
} from '../src/editor/core/clipboard'
import { createDeleteManyCommand, createMoveManyCommand } from '../src/editor/core/commands'
import { createInitialProject, addOverlayTrackFromClip, createClip } from '../src/editor/core/operations'
import { addTextClipToProject, addTextTrackToProject } from '../src/editor/core/text'
import type { Project } from '../src/editor/core/types'

describe('selection 集合运算', () => {
  it('去重且保持顺序', () => {
    expect(normalizeSelection(['a', 'b', 'a', '', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('Ctrl 点击切换', () => {
    expect(toggleSelection(['a', 'b'], 'c')).toEqual(['a', 'b', 'c'])
    expect(toggleSelection(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
  })

  it('Shift 区间选择（以锚点为界，双向）', () => {
    const ordered = ['a', 'b', 'c', 'd', 'e']
    expect(rangeSelection(ordered, 'b', 'd')).toEqual(['b', 'c', 'd'])
    expect(rangeSelection(ordered, 'd', 'b')).toEqual(['b', 'c', 'd'])
  })

  it('Shift 区间：锚点缺失退化为单选', () => {
    expect(rangeSelection(['a', 'b'], null, 'b')).toEqual(['b'])
    expect(rangeSelection(['a', 'b'], 'zzz', 'b')).toEqual(['b'])
  })

  it('主选中派生', () => {
    expect(primaryOf(['a', 'b'], 'b')).toBe('b')
    expect(primaryOf(['a', 'b'], 'zzz')).toBe('a')
    expect(primaryOf([], 'a')).toBeNull()
  })
})

describe('框选 idsInRect', () => {
  const spans = [
    { id: 'a', trackId: 'main', start: 0, end: 2 },
    { id: 'b', trackId: 'main', start: 2, end: 4 },
    { id: 'c', trackId: 'ov1', start: 3, end: 6 },
  ]

  it('按时间区间相交选出（半开区间，端点不算相交）', () => {
    expect(idsInRect(spans, { start: 1.5, end: 3.5 })).toEqual(['a', 'b', 'c'])
    // [2,3) 与 c 的 [3,6) 只共端点，半开区间不算相交
    expect(idsInRect(spans, { start: 2, end: 3 })).toEqual(['b'])
    expect(idsInRect(spans, { start: 2, end: 3.01 })).toEqual(['b', 'c'])
  })

  it('可限定轨道', () => {
    expect(idsInRect(spans, { start: 0, end: 10, trackIds: ['ov1'] })).toEqual(['c'])
  })

  it('支持反向拖拽的矩形', () => {
    expect(idsInRect(spans, { start: 4, end: 1 })).toEqual(['a', 'b', 'c'])
  })
})

describe('批量拖动 planBatchMove', () => {
  const items = [
    { id: 'a', start: 1, duration: 2 },
    { id: 'b', start: 5, duration: 1 },
  ]

  it('整体平移，保持相对位置', () => {
    const moves = planBatchMove(items, 2)
    expect(moves).toEqual([
      { id: 'a', delta: 2 },
      { id: 'b', delta: 2 },
    ])
  })

  it('越过 0 时统一收敛，相对距离不变', () => {
    const moves = planBatchMove(items, -3)
    const delta = moves[0].delta
    expect(delta).toBe(-1)
    expect(moves[1].delta).toBe(delta)
    expect(items[0].start + delta).toBe(0)
  })
})

function projectWithMain(): Project {
  return {
    ...createInitialProject({ url: 'a', duration: 4 }, 'c1'),
    clips: [createClip('a', 0, 4, {}, 'c1'), createClip('a', 4, 8, {}, 'c2')],
  }
}

describe('剪贴板：收集与粘贴规划', () => {
  it('按 id 收集并计算相对偏移', () => {
    const payload = buildClipboardPayload(projectWithMain(), ['c1', 'c2'])
    expect(payload.count).toBe(2)
    expect(payload.items.map((item) => item.offset)).toEqual([0, 4])
  })

  it('空选择返回空载荷', () => {
    expect(buildClipboardPayload(projectWithMain(), ['zzz']).count).toBe(0)
  })

  it('粘贴到主轨序列：插入下标由播放头决定', () => {
    const payload = buildClipboardPayload(projectWithMain(), ['c2'])
    const plan = planPaste(projectWithMain(), payload, 2)
    expect(plan.video).toHaveLength(1)
    expect(plan.video[0]).toMatchObject({ kind: 'main', trackId: null, index: 0 })
  })

  it('粘贴到剪辑点之后时插入下标递增', () => {
    const payload = buildClipboardPayload(projectWithMain(), ['c2'])
    const plan = planPaste(projectWithMain(), payload, 7)
    expect(plan.video[0].index).toBe(2)
  })

  it('findFreeSlot 冲突后移', () => {
    expect(findFreeSlot(1, 2, [{ start: 0, end: 3 }])).toBeCloseTo(3.05)
    expect(findFreeSlot(1, 2, [])).toBe(1)
  })

  it('音频片段粘贴：原轨可用时落在播放头并避让', () => {
    const project: Project = {
      ...createInitialProject({ url: 'a', duration: 10 }, 'c1'),
      audioTracks: [
        {
          id: 'at',
          name: '配音',
          muted: false,
          hidden: false,
          volume: 1,
          clips: [
            { id: 'ac1', sourceUrl: 'a', sourceStart: 0, sourceEnd: 2, start: 0, volume: 1, fadeIn: 0, fadeOut: 0 },
          ],
        },
      ],
    }
    const payload = buildClipboardPayload(project, ['ac1'])
    const plan = planPaste(project, payload, 1)
    expect(plan.audio).toHaveLength(1)
    expect(plan.audio[0].trackId).toBe('at')
    // 1 处与 0-2 冲突 → 后移到 2.05
    expect(plan.audio[0].clip.start).toBeCloseTo(2.05)
  })

  it('原轨被锁定时标记为需要新建轨道', () => {
    const project: Project = {
      ...createInitialProject({ url: 'a', duration: 10 }, 'c1'),
      audioTracks: [
        {
          id: 'at',
          name: '配音',
          muted: false,
          hidden: false,
          volume: 1,
          clips: [
            { id: 'ac1', sourceUrl: 'a', sourceStart: 0, sourceEnd: 2, start: 0, volume: 1, fadeIn: 0, fadeOut: 0 },
          ],
        },
      ],
    }
    const payload = buildClipboardPayload(project, ['ac1'])
    const plan = planPaste(project, payload, 5, { lockedTrackIds: new Set(['at']) })
    expect(plan.audio[0].trackId).toBeNull()
    expect(plan.audio[0].clip.start).toBe(5)
  })
})

describe('applyPastePlan', () => {
  const ids: string[] = []
  const nextId: IdFactory = (prefix) => {
    const id = `${prefix}-${ids.length + 1}`
    ids.push(id)
    return id
  }

  it('主轨粘贴生成新 id 并保留原引用不被修改', () => {
    const project = projectWithMain()
    const payload = buildClipboardPayload(project, ['c1'])
    const plan = planPaste(project, payload, 0)
    const result = applyPastePlan(project, plan, nextId)
    expect(result.project.clips).toHaveLength(3)
    expect(result.selectedIds).toHaveLength(1)
    // 原工程不被就地修改
    expect(project.clips).toHaveLength(2)
  })

  it('音频原轨缺失时新建音频轨', () => {
    const project = projectWithMain()
    const withAudio = {
      ...project,
      audioTracks: [
        {
          id: 'at',
          name: '配音',
          muted: false,
          hidden: false,
          volume: 1,
          clips: [
            { id: 'ac1', sourceUrl: 'a', sourceStart: 0, sourceEnd: 2, start: 0, volume: 1, fadeIn: 0, fadeOut: 0 },
          ],
        },
      ],
    }
    const payload = buildClipboardPayload(withAudio, ['ac1'])
    const plan = planPaste(withAudio, payload, 5, { lockedTrackIds: new Set(['at']) })
    const result = applyPastePlan(withAudio, plan, nextId)
    expect((result.project.audioTracks ?? []).length).toBe(2)
  })

  it('文本粘贴到已存在轨并清掉联动 link', () => {
    let project = projectWithMain()
    project = addTextTrackToProject(project, 'cap', 'caption')
    project = addTextClipToProject(project, 'cap', {
      id: 't1',
      text: '你好',
      start: 1,
      end: 2,
      x: 0.5,
      y: 0.86,
      fontSize: 0.05,
      color: '#fff',
      background: 'transparent',
      align: 'center',
      bold: false,
      link: { clipId: 'c1', sourceUrl: 'a', sourceStart: 0, sourceEnd: 1, padStart: 0, padEnd: 0.1 },
    })!
    const payload = buildClipboardPayload(project, ['t1'])
    const plan = planPaste(project, payload, 6)
    const result = applyPastePlan(project, plan, nextId)
    const track = result.project.textTracks!.find((t) => t.id === 'cap')!
    expect(track.clips).toHaveLength(2)
    expect(track.clips[1].link).toBeUndefined()
  })
})

describe('createDeleteManyCommand', () => {
  it('一次命令删除跨轨道多个片段，可撤销', () => {
    let project: Project = projectWithMain()
    project = addOverlayTrackFromClip(project, 'c1', 'ov', 'ovc')!.project
    const before = project
    const command = createDeleteManyCommand(['c1', 'ovc'])
    const after = command.execute(project)
    expect(after.clips.map((clip) => clip.id)).toEqual(['c2'])
    expect((after.overlayTracks ?? []).length).toBe(0)
    // 不修改原对象
    expect(before.clips).toHaveLength(2)
  })
})

describe('contiguousRunHeads', () => {
  it('找连续段起点', () => {
    expect(contiguousRunHeads(['a', 'b', 'c', 'd'], ['b', 'c'])).toEqual(['b'])
    expect(contiguousRunHeads(['a', 'b', 'c', 'd'], ['a', 'c'])).toEqual(['a', 'c'])
    expect(contiguousRunHeads(['a', 'b'], [])).toEqual([])
  })
})

describe('createMoveManyCommand（批量拖动保持相对位置）', () => {
  it('主轨连续段整体平移', () => {
    const project = projectWithMain() // c1 0-4, c2 4-8
    const moved = createMoveManyCommand(['c2'], 2).execute(project)
    const timeline = getTimelineFor(moved.clips)
    // c2 的间隙增大 2s，c1 不动
    expect(timeline[0].start).toBe(0)
    expect(timeline[1].start).toBe(6)
  })

  it('多选连续段平移，段内相对位置不变', () => {
    const project: Project = {
      ...createInitialProject({ url: 'a', duration: 20 }, 'c1'),
      clips: [
        createClip('a', 0, 3, {}, 'a'),
        createClip('a', 3, 5, {}, 'b'),
        createClip('a', 5, 9, {}, 'c'),
      ],
    }
    const moved = createMoveManyCommand(['a', 'b'], 2).execute(project)
    const timeline = getTimelineFor(moved.clips)
    expect(timeline[0].start).toBe(2)
    expect(timeline[1].start).toBe(5)
    // 段内间距不变（3 秒）
    expect(timeline[1].start - timeline[0].start).toBe(3)
    // 未选中的 c 跟着顺延
    expect(timeline[2].start).toBe(7)
  })

  it('音频/文本按绝对时间平移', () => {
    const project: Project = {
      ...createInitialProject({ url: 'a', duration: 10 }, 'c1'),
      audioTracks: [
        {
          id: 'at',
          name: '配音',
          muted: false,
          hidden: false,
          volume: 1,
          clips: [
            { id: 'ac1', sourceUrl: 'a', sourceStart: 0, sourceEnd: 2, start: 1, volume: 1, fadeIn: 0, fadeOut: 0 },
          ],
        },
      ],
    }
    const moved = createMoveManyCommand(['ac1'], 3).execute(project)
    expect(moved.audioTracks![0].clips[0].start).toBe(4)
  })
})