import { describe, expect, it } from 'vitest'
import {
  applyTransitionToAllJunctions,
  createClip,
  createInitialProject,
} from '../src/editor/core/operations'
import { createSetTransitionAllCommand } from '../src/editor/core/commands'
import { clipTransitionOut, TRANSITION_MIN_DURATION } from '../src/editor/core/transition'
import type { Clip, Project, SourceInfo } from '../src/editor/core/types'

const SOURCE: SourceInfo = {
  url: 'blob:v',
  name: 'v.mp4',
  size: 1_000_000,
  duration: 40,
  width: 1920,
  height: 1080,
}

/** 造一条主轨：每段 `length` 秒，`gaps[id]` 指定该片段的 gapBefore。 */
function mainTrack(lengths: number[], overrides: Record<number, Partial<Clip>> = {}): Project {
  const base = createInitialProject({ url: SOURCE.url, duration: 40 }, 'c0')
  let cursor = 0
  const clips = lengths.map((length, index) => {
    const clip = createClip(
      SOURCE.url,
      cursor,
      cursor + length,
      { gapBefore: 0, ...(overrides[index] ?? {}) },
      `c${index}`,
    )
    cursor += length
    return clip
  })
  return { ...base, clips }
}

const durations = (project: Project): (number | null)[] =>
  project.clips.map((clip) => clipTransitionOut(clip)?.duration ?? null)

const types = (project: Project): (string | null)[] =>
  project.clips.map((clip) => clipTransitionOut(clip)?.type ?? null)

describe('createSetTransitionAllCommand / applyTransitionToAllJunctions', () => {
  it('全部可应用：4 段连续片段写入 3 处转场（单次命令）', () => {
    const project = mainTrack([4, 4, 4, 4])
    const result = applyTransitionToAllJunctions(project, { type: 'fade', duration: 0.8 })

    expect(result.applied).toBe(3)
    expect(result.skipped).toBe(0)
    expect(types(result.project)).toEqual(['fade', 'fade', 'fade', null])
    expect(durations(result.project)).toEqual([0.8, 0.8, 0.8, null])
    // 末段没有交界，保持原样
    expect(result.project.clips[3]).toBe(project.clips[3])

    // 命令 = 1 次执行，返回同一个新 project
    const command = createSetTransitionAllCommand({ type: 'fade', duration: 0.8 })
    expect(command.execute(project)).toEqual(result.project)
  })

  it('有空隙跳过：跨越 0.5s 空隙的交界被跳过且原片段不变', () => {
    const project = mainTrack([4, 4, 4, 4], { 2: { gapBefore: 0.5 } })
    const result = applyTransitionToAllJunctions(project, { type: 'wipeleft', duration: 1 })

    expect(result.applied).toBe(2)
    expect(result.skipped).toBe(1)
    // 转场写在交界左侧片段上：c0→c1 可用、c1→c2 因空隙跳过、c2→c3 可用
    expect(types(result.project)).toEqual(['wipeleft', null, 'wipeleft', null])
    expect(result.project.clips[1]).toBe(project.clips[1])
  })

  it('含定格跳过：任一侧是定格的交界全部跳过，全不可用时返回原 project', () => {
    const project = mainTrack([4, 4, 4], { 1: { type: 'freeze' } })
    const result = applyTransitionToAllJunctions(project, { type: 'circleopen', duration: 0.5 })

    // c0→c1 与 c1→c2 都涉及定格
    expect(result.applied).toBe(0)
    expect(result.skipped).toBe(2)
    expect(result.project).toBe(project)
    // 无变化 → 命令执行后仍是同一对象（不写历史）
    const command = createSetTransitionAllCommand({ type: 'circleopen', duration: 0.5 })
    expect(command.execute(project)).toBe(project)
  })

  it('末段跳过 + 时长按每处相邻片段重新夹取', () => {
    // 每段 1s，上限 = min(2, 1/2) = 0.5s；请求 2s 应被逐处夹到 0.5s
    const project = mainTrack([1, 1, 1])
    const result = applyTransitionToAllJunctions(project, { type: 'slideleft', duration: 2 })

    expect(result.applied).toBe(2) // 3 段 → 2 处交界，末段不属于交界
    expect(result.skipped).toBe(0)
    expect(durations(result.project)).toEqual([0.5, 0.5, null])

    // 单段工程没有交界
    const single = mainTrack([3])
    const singleResult = applyTransitionToAllJunctions(single, { type: 'fade', duration: 1 })
    expect(singleResult.applied).toBe(0)
    expect(singleResult.skipped).toBe(0)
    expect(singleResult.project).toBe(single)
  })

  it('短于最小转场时长的交界被跳过（不产生非法时长）', () => {
    // 两侧都只有 0.15s → 上限 0.075s < 0.1s 最小转场
    const project = mainTrack([0.15, 0.15])
    const result = applyTransitionToAllJunctions(project, { type: 'fade', duration: 2 })
    expect(result.applied).toBe(0)
    expect(result.skipped).toBe(1)
    expect(result.project).toBe(project)
    expect(TRANSITION_MIN_DURATION).toBe(0.1)
  })
})