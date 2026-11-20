import { describe, expect, it } from 'vitest'
import { evalAnimation } from '../src/editor/core/animation'
import {
  baseValueOf,
  leftTrimAnimation,
  rightTrimAnimation,
  splitAnimation,
  unchangedAnimation,
} from '../src/editor/core/animationEdit'
import type { AnimationMap, Easing, Keyframe } from '../src/editor/core/types'

const key = (t: number, value: number, ease: Easing = 'linear'): Keyframe => ({ t, value, ease })
const BASE = baseValueOf({ position: { x: 0, y: 0 }, scale: 1, rotation: 0, opacity: 1 })

const at = (anim: AnimationMap | undefined, prop: keyof AnimationMap, t: number): number =>
  evalAnimation(anim?.[prop], t, 0)

describe('左裁重映射', () => {
  it('t′ = (t·D₀ − delta)/D₁，丢弃落在区间外的帧', () => {
    // 原 4s，裁掉前 1s → 新 3s
    const anim: AnimationMap = { 'position.x': [key(0, 0), key(0.5, 1), key(1, 2)] }
    const next = leftTrimAnimation(anim, 1, 4, 3)
    const keys = next?.['position.x'] ?? []
    // 原 t=0 → (0*4-1)/3 <0 丢弃；0.5 → (2-1)/3=1/3；1 → (4-1)/3=1
    // 补了起点边界帧：0 → 原 t=0.25 的插值 0.5；随后是原 1/3、1
    expect(keys.map((item) => Number(item.t.toFixed(6)))).toEqual([0, 0.333333, 1])
    expect(keys.map((item) => item.value)).toEqual([0.5, 1, 2])
    // 裁剪后起点取值 == 裁剪前 delta 处的取值（验收 #5）
    expect(at(next, 'position.x', 0)).toBeCloseTo(evalAnimation([key(0, 0), key(0.5, 1), key(1, 2)], 0.25, 0), 6)
  })

  it('向左扩展（delta 为负）时帧被推入可见区间内', () => {
    const anim: AnimationMap = { scale: [key(0, 1), key(1, 2)] }
    // 原 3s，向左恢复 1s → 新 4s
    const next = leftTrimAnimation(anim, -1, 3, 4)
    const keys = next?.scale ?? []
    // 帧被推入区间：原 0、1 → 0.25、1；另在 t=0 补边界帧（取值=首帧值，因为扩展区在原动画之前）
    expect(keys.map((item) => Number(item.t.toFixed(6)))).toEqual([0, 0.25, 1])
    expect(keys.map((item) => item.value)).toEqual([1, 1, 2])
  })
})

describe('右裁重映射', () => {
  it('t′ = t·D₀/D₁，丢弃 t′ > 1 的帧', () => {
    const anim: AnimationMap = { rotation: [key(0, 0), key(0.5, 45), key(1, 90)] }
    // 原 4s → 新 2s（右裁 2s）
    const next = rightTrimAnimation(anim, 4, 2)
    const keys = next?.rotation ?? []
    // 0→0；0.5→1；1→2 (>1) 丢弃
    expect(keys.map((item) => Number(item.t.toFixed(6)))).toEqual([0, 1])
    expect(keys.map((item) => item.value)).toEqual([0, 45])
    expect(at(next, 'rotation', 1)).toBeCloseTo(45, 6)
  })

  it('结束时长的关键帧被保留在末帧位置外的会被丢弃', () => {
    const anim: AnimationMap = { opacity: [key(0.2, 0.5), key(0.9, 1)] }
    const next = rightTrimAnimation(anim, 10, 5) // 0.2→0.4 保留；0.9→1.8 丢弃
    expect(next?.opacity?.map((item) => Number(item.t.toFixed(6)))).toEqual([0.4, 1])
  })
})

describe('分割重映射', () => {
  it('两侧分别按 t/f 与 (t−f)/(1−f) 映射，并在分割点补边界帧', () => {
    const anim: AnimationMap = { 'position.x': [key(0, 0), key(0.5, 0.5), key(1, 0)] }
    const { left, right } = splitAnimation(anim, 0.5, BASE)
    expect(left?.['position.x']?.map((item) => Number(item.t.toFixed(6)))).toEqual([0, 1])
    expect(right?.['position.x']?.map((item) => Number(item.t.toFixed(6)))).toEqual([0, 1])
    // 两侧边界帧的值都等于分割点的插值结果
    expect(at(left, 'position.x', 1)).toBeCloseTo(0.5, 6)
    expect(at(right, 'position.x', 0)).toBeCloseTo(0.5, 6)
  })

  it('分割点两侧取值连续（左片末帧 = 右片首帧 = 原动画在该点的值）', () => {
    const anim: AnimationMap = { scale: [key(0, 1), key(0.25, 1.4), key(1, 0.8)] }
    const f = 0.6
    const { left, right } = splitAnimation(anim, f, BASE)
    const original = evalAnimation(anim.scale, f, 1)
    expect(at(left, 'scale', 1)).toBeCloseTo(original, 6)
    expect(at(right, 'scale', 0)).toBeCloseTo(original, 6)
    // 分割点之后的一小段也连续
    const originalAfter = evalAnimation(anim.scale, f + 0.01, 1)
    expect(at(right, 'scale', 0.01 / (1 - f))).toBeCloseTo(originalAfter, 5)
  })

  it('某侧原本没有关键帧时不凭空补帧', () => {
    const onlyLate: AnimationMap = { rotation: [key(0.8, 30), key(1, 60)] }
    const split = splitAnimation(onlyLate, 0.5, BASE)
    // 左片完全没有帧 → 不产生 left
    expect(split.left).toBeUndefined()
    expect(split.right?.rotation?.length).toBeGreaterThan(0)
    // 完全无动画时两侧都为空
    expect(splitAnimation(undefined, 0.5, BASE)).toEqual({})
  })
})

describe('不变的操作', () => {
  it('变速 / 改 gap / 移动片段：原样返回同一引用', () => {
    const anim: AnimationMap = { opacity: [key(0, 1), key(1, 0)] }
    expect(unchangedAnimation(anim)).toBe(anim)
  })
})