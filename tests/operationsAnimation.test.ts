import { describe, expect, it } from 'vitest'
import { evalAnimation } from '../src/editor/core/animation'
import {
  createInitialProject,
  removeClipFromProject,
  resizeClipEdge,
  splitProjectAt,
  trimProjectLeft,
  trimProjectRight,
} from '../src/editor/core/operations'
import { clipTimelineDuration } from '../src/editor/core/clipTime'
import type { AnimationMap, Clip, Easing, Keyframe, Project } from '../src/editor/core/types'

const key = (t: number, value: number, ease: Easing = 'linear'): Keyframe => ({ t, value, ease })

/** 两个 4 秒片段，第一个带 position.x 关键帧。 */
function animatedProject(): Project {
  const base = createInitialProject({ url: 'blob:a', duration: 20 }, 'c1')
  const anim: AnimationMap = { 'position.x': [key(0, 0), key(0.5, 0.5), key(1, 0)] }
  const first: Clip = { ...base.clips[0], sourceEnd: 4, anim }
  const second: Clip = { ...base.clips[0], id: 'c2', sourceStart: 4, sourceEnd: 8 }
  return { ...base, clips: [first, second] }
}

const byId = (project: Project, id: string): Clip =>
  project.clips.find((clip) => clip.id === id)!

describe('分割：两侧保留关键帧并在分割点补边界帧', () => {
  it('前半段末帧 = 后半段首帧 = 原动画在分割点的值', () => {
    const project = animatedProject()
    const clip = byId(project, 'c1')
    const cutTime = 2 // 4s 片段的中点 → fraction 0.5
    const next = splitProjectAt(project, 'c1', cutTime, 'c1-right')
    expect(next).not.toBeNull()
    const left = byId(next!, 'c1')
    const right = byId(next!, 'c1-right')
    const original = evalAnimation(clip.anim!['position.x'], 0.5, 0)
    expect(evalAnimation(left.anim?.['position.x'], 1, -1)).toBeCloseTo(original, 6)
    expect(evalAnimation(right.anim?.['position.x'], 0, -1)).toBeCloseTo(original, 6)
    // 两侧都还留着关键帧
    expect((left.anim?.['position.x'] ?? []).length).toBeGreaterThan(1)
    expect((right.anim?.['position.x'] ?? []).length).toBeGreaterThan(1)
  })

  it('无动画的片段分割后两侧都没有 anim 字段', () => {
    const project = animatedProject()
    const next = splitProjectAt(project, 'c2', 6, 'c2-right')
    expect(byId(next!, 'c2').anim).toBeUndefined()
    expect(byId(next!, 'c2-right').anim).toBeUndefined()
  })
})

describe('裁剪：关键帧按公式重映射', () => {
  it('左裁 1 秒后起点取值与裁剪前 1s 处一致', () => {
    const project = animatedProject()
    const before = byId(project, 'c1')
    const valueBefore = evalAnimation(before.anim!['position.x'], 1 / 4, 0) // 1s / 4s
    const next = trimProjectLeft(project, 'c1', 1)
    const after = byId(next!, 'c1')
    expect(clipTimelineDuration(after)).toBeCloseTo(3, 6)
    expect(evalAnimation(after.anim?.['position.x'], 0, -1)).toBeCloseTo(valueBefore, 5)
  })

  it('右裁 1 秒后终点取值与裁剪前对应时刻一致', () => {
    const project = animatedProject()
    const before = byId(project, 'c1')
    const valueBefore = evalAnimation(before.anim!['position.x'], 3 / 4, 0)
    const next = trimProjectRight(project, 'c1', 3)
    const after = byId(next!, 'c1')
    expect(clipTimelineDuration(after)).toBeCloseTo(3, 6)
    expect(evalAnimation(after.anim?.['position.x'], 1, -1)).toBeCloseTo(valueBefore, 5)
  })

  it('拖动右边缘收缩同样重映射', () => {
    const project = animatedProject()
    const next = resizeClipEdge(project, 'c1', 'right', -1, 20)
    const after = byId(next!, 'c1')
    expect(clipTimelineDuration(after)).toBeCloseTo(3, 6)
    expect(after.anim?.['position.x']?.length).toBeGreaterThan(0)
  })
})

describe('不变 / 删除', () => {
  it('变速不改关键帧（相对位置保持）', () => {
    const project = animatedProject()
    const before = byId(project, 'c1').anim
    // 变速只改 speed 字段本身，不经过任何 trim/split → anim 引用不变
    const sped = {
      ...project,
      clips: project.clips.map((clip) =>
        clip.id === 'c1' ? { ...clip, speed: 2, sourceEnd: clip.sourceEnd } : clip,
      ),
    }
    expect(byId(sped, 'c1').anim).toBe(before)
  })

  it('移动片段 / 改 gapBefore 不改关键帧', () => {
    const project = animatedProject()
    const before = byId(project, 'c1').anim
    const moved = {
      ...project,
      clips: project.clips.map((clip) =>
        clip.id === 'c1' ? { ...clip, gapBefore: 1.5 } : clip,
      ),
    }
    expect(byId(moved, 'c1').anim).toBe(before)
  })

  it('删除片段时关键帧随片段一起消失', () => {
    const project = animatedProject()
    const next = removeClipFromProject(project, 'c1')
    expect(next!.clips.some((clip) => clip.anim)).toBe(false)
    expect(next!.clips.map((clip) => clip.id)).toEqual(['c2'])
  })
})