import { describe, expect, it } from 'vitest'
import {
  animatedProps,
  easeValue,
  evalAnimation,
  hasAnimation,
  normalizedTime,
  resolveClipOverrides,
} from '../src/editor/core/animation'
import { createClip } from '../src/editor/core/operations'
import type { Clip, Easing, Keyframe } from '../src/editor/core/types'

const key = (t: number, value: number, ease: Easing = 'linear'): Keyframe => ({ t, value, ease })

const clipWith = (anim: Clip['anim'], patch: Partial<Clip> = {}): Clip => ({
  ...createClip('blob:x', 0, 4, {}, 'c1'),
  ...patch,
  ...(anim ? { anim } : {}),
})

describe('evalAnimation', () => {
  it('空数组 / undefined 返回 fallback', () => {
    expect(evalAnimation(undefined, 0.5, 7)).toBe(7)
    expect(evalAnimation([], 0.5, 7)).toBe(7)
  })

  it('单帧在整段内恒定', () => {
    const keys = [key(0.5, 3)]
    expect(evalAnimation(keys, 0, 99)).toBe(3)
    expect(evalAnimation(keys, 0.5, 99)).toBe(3)
    expect(evalAnimation(keys, 1, 99)).toBe(3)
  })

  it('两端夹取：首帧前取首值、末帧后取末值', () => {
    const keys = [key(0.2, 10), key(0.8, 20)]
    expect(evalAnimation(keys, 0, 99)).toBe(10)
    expect(evalAnimation(keys, 0.2, 99)).toBe(10)
    expect(evalAnimation(keys, 0.8, 99)).toBe(20)
    expect(evalAnimation(keys, 1, 99)).toBe(20)
  })

  it('线性插值：中点等于两帧均值，且按后一帧的 ease', () => {
    const keys = [key(0, 0), key(1, 10, 'linear')]
    expect(evalAnimation(keys, 0.5, 0)).toBeCloseTo(5, 6)
    // ease 取自后一帧：把后一帧改成 easeIn 后中点应更小
    const eased = [key(0, 0), key(1, 10, 'easeIn')]
    expect(evalAnimation(eased, 0.5, 0)).toBeCloseTo(10 * 0.125, 6)
  })

  it('四种缓动在 p=0.25/0.5/0.75 的取值符合公式', () => {
    const cases: Record<Exclude<Easing, 'hold'>, [number, number, number]> = {
      linear: [0.25, 0.5, 0.75],
      easeIn: [0.25 ** 3, 0.5 ** 3, 0.75 ** 3],
      easeOut: [1 - 0.75 ** 3, 1 - 0.5 ** 3, 1 - 0.25 ** 3],
      easeInOut: [4 * 0.25 ** 3, 0.5, 1 - 4 * 0.25 ** 3],
    }
    for (const [ease, expected] of Object.entries(cases) as [Exclude<Easing, 'hold'>, number[]][]) {
      expect(easeValue(ease, 0.25)).toBeCloseTo(expected[0], 6)
      expect(easeValue(ease, 0.5)).toBeCloseTo(expected[1], 6)
      expect(easeValue(ease, 0.75)).toBeCloseTo(expected[2], 6)
    }
  })

  it('hold 保持前一帧的值直到该帧', () => {
    const keys = [key(0, 1), key(0.5, 2, 'hold'), key(1, 3, 'linear')]
    expect(evalAnimation(keys, 0.25, 0)).toBe(1)
    expect(evalAnimation(keys, 0.4999, 0)).toBe(1)
    // 到达第二帧后立刻取第二帧的值
    expect(evalAnimation(keys, 0.5, 0)).toBe(2)
    expect(evalAnimation(keys, 0.75, 0)).toBeCloseTo(2.5, 6)
  })

  it('乱序输入按时间排序后求值', () => {
    const keys = [key(1, 20), key(0, 10)]
    expect(evalAnimation(keys, 0.5, 0)).toBeCloseTo(15, 6)
  })
})

describe('hasAnimation / animatedProps', () => {
  it('没有 anim 或全为空数组时视为无动画', () => {
    expect(hasAnimation(clipWith(undefined))).toBe(false)
    expect(hasAnimation(clipWith({ scale: [] }))).toBe(false)
    expect(animatedProps(clipWith({ scale: [] }))).toEqual([])
  })

  it('按固定顺序列出带关键帧的属性', () => {
    const clip = clipWith({
      opacity: [key(0, 0), key(1, 1)],
      'position.x': [key(0, 0), key(1, 0.5)],
      rotation: [key(0, 0), key(1, 90)],
    })
    expect(hasAnimation(clip)).toBe(true)
    expect(animatedProps(clip)).toEqual(['position.x', 'rotation', 'opacity'])
  })
})

describe('resolveClipOverrides', () => {
  it('只动 position.x 时 y 保持基础值', () => {
    const clip = clipWith({ 'position.x': [key(0, 0), key(1, 0.4)] }, { position: { x: 0.1, y: -0.3 } })
    const at0 = resolveClipOverrides(clip, 0, 2)
    const at1 = resolveClipOverrides(clip, 1, 2)
    const at2 = resolveClipOverrides(clip, 2, 2)
    expect(at0.position.x).toBeCloseTo(0, 6)
    expect(at1.position.x).toBeCloseTo(0.2, 6)
    expect(at2.position.x).toBeCloseTo(0.4, 6)
    for (const point of [at0, at1, at2]) expect(point.position.y).toBeCloseTo(-0.3, 6)
  })

  it('无关键帧的属性回落基础值；归一化时间按片段时长换算', () => {
    const clip = clipWith({ scale: [key(0, 1), key(1, 2)] }, { scale: 0.5, rotation: 30 })
    const mid = resolveClipOverrides(clip, 2, 4) // localTime 2s / 总时长 4s = 0.5
    expect(mid.scale).toBeCloseTo(1.5, 6)
    expect(mid.rotation).toBeCloseTo(30, 6)
    expect(mid.opacity).toBeCloseTo(1, 6)
  })

  it('normalizedTime 夹取到 0…1', () => {
    expect(normalizedTime(-1, 4)).toBe(0)
    expect(normalizedTime(2, 4)).toBeCloseTo(0.5, 6)
    expect(normalizedTime(99, 4)).toBe(1)
    expect(normalizedTime(1, 0)).toBe(0)
  })
})