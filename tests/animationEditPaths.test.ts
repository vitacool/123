import { describe, expect, it } from 'vitest'
import { evalAnimation } from '../src/editor/core/animation'
import { createUpdateAnyClipCommand } from '../src/editor/core/commands'
import { clipTimelineDuration } from '../src/editor/core/clipTime'
import { createInitialProject, resizeClipEdge } from '../src/editor/core/operations'
import type { AnimationMap, Clip, Easing, Keyframe, Project } from '../src/editor/core/types'

const key = (t: number, value: number, ease: Easing = 'linear'): Keyframe => ({ t, value, ease })
const ANIM: AnimationMap = { 'position.x': [key(0, 0), key(0.5, 0.5), key(1, 0)] }

/** 两个 4s 片段；第二个带关键帧（首个片段的左边缘没有前序空隙可消耗，编辑时是 no-op）。 */
function twoClips(): Project {
  const base = createInitialProject({ url: 'blob:a', duration: 20 }, 'c1')
  return {
    ...base,
    clips: [
      { ...base.clips[0], id: 'c1', sourceEnd: 4 },
      // 左边缘裁剪需要「可消耗的前序空隙」（app 的非破坏性裁剪模型），所以这里给 1.5s 空隙。
      { ...base.clips[0], id: 'c2', sourceStart: 4, sourceEnd: 8, gapBefore: 1.5, anim: ANIM } as Clip,
    ],
  }
}

const byId = (project: Project, id: string): Clip => project.clips.find((c) => c.id === id)!

/**
 * 验收 #5：左裁后关键帧按 t′=(t·D₀−delta)/D₁ 重映射，
 * 且裁剪后起点取值 = 裁剪前对应时刻取值。这里走 store 的 UI 拖拽路径
 * （store.resizeClipEdge → operations.resizeClipEdge）。
 */
describe('验收 #5：拖动左边缘裁剪时的关键帧重映射（UI 同路径）', () => {
  it('第二个片段左裁 1s：关键帧重映射且起点取值与裁剪前一致', () => {
    const project = twoClips()
    const before = byId(project, 'c2')
    const valueAt1s = evalAnimation(before.anim!['position.x'], 1 / 4, 0) // 1s / 4s

    const next = resizeClipEdge(project, 'c2', 'left', 1, 20)
    expect(next).not.toBeNull()
    const after = byId(next!, 'c2')
    expect(clipTimelineDuration(after)).toBeCloseTo(3, 6)

    // 起点边界帧 = 裁剪前 1s 处的插值
    expect(evalAnimation(after.anim?.['position.x'], 0, -1)).toBeCloseTo(valueAt1s, 5)
    // 关键帧被压缩到新时长内（原 0.5 → (0.5·4−1)/3 = 1/3）
    const times = (after.anim?.['position.x'] ?? []).map((k) => Number(k.t.toFixed(4)))
    expect(times).toContain(0.3333)
  })

  it('收缩后终点取值也保持不变（末帧补边界）', () => {
    const project = twoClips()
    const next = resizeClipEdge(project, 'c2', 'right', -1, 20)
    const after = byId(next!, 'c2')
    expect(clipTimelineDuration(after)).toBeCloseTo(3, 6)
    const before = byId(project, 'c2')
    const valueAtEnd = evalAnimation(before.anim!['position.x'], 0.75, 0)
    expect(evalAnimation(after.anim?.['position.x'], 1, -1)).toBeCloseTo(valueAtEnd, 5)
  })
})

/**
 * 验收 #6：变速不改关键帧（相对位置保持）。
 * setClipSpeed 内部就是 createUpdateAnyClipCommand(clipId, { speed, keepPitch })。
 */
describe('验收 #6：变速不触碰关键帧（UI 同路径）', () => {
  it('写入 speed 后 anim 引用与内容都不变', () => {
    const project = twoClips()
    const before = byId(project, 'c2').anim
    const next = createUpdateAnyClipCommand('c2', { speed: 2, keepPitch: true }, '变速').execute(project)
    const after = byId(next, 'c2')
    expect(after.speed).toBe(2)
    expect(after.anim).toBe(before)
    expect(after.anim?.['position.x']?.map((k) => [k.t, k.value])).toEqual([
      [0, 0],
      [0.5, 0.5],
      [1, 0],
    ])
  })

  it('变速后动画整体压缩：时间线 2 倍速时同一归一化时刻对应更短的秒数', () => {
    const project = twoClips()
    const next = createUpdateAnyClipCommand('c2', { speed: 2 }, '变速').execute(project)
    const before = byId(project, 'c2')
    const after = byId(next, 'c2')
    // 归一化时间不变 → 动画曲线形状不变；实际时长减半由 clipTimelineDuration 体现
    expect(clipTimelineDuration(after)).toBeCloseTo(clipTimelineDuration(before) / 2, 3)
    expect(evalAnimation(after.anim?.['position.x'], 0.5, 0)).toBeCloseTo(
      evalAnimation(before.anim?.['position.x'], 0.5, 0),
      6,
    )
  })
})