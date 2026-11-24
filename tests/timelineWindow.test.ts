import { describe, expect, it } from 'vitest'
import { isSegmentVisible, timelineWindow } from '../src/editor/core/timelineWindow'

describe('timelineWindow（时间轴虚拟化窗口）', () => {
  it('按滚动/视口/缩放换算，并带前后 overscan', () => {
    const window = timelineWindow(0, 500, 100, 50, 500)
    expect(window.start).toBe(0)
    expect(window.end).toBeCloseTo(9.5)
  })

  it('滚动后窗口跟着移动，且不会出现负时间', () => {
    const window = timelineWindow(1050, 500, 100, 50, 0)
    expect(window.start).toBeCloseTo(10)
    expect(window.end).toBeCloseTo(15)
    expect(timelineWindow(0, 500, 100, 50, 1000).start).toBe(0)
  })

  it('非法输入不产生 NaN', () => {
    const window = timelineWindow(Number.NaN, 500, 0, 0)
    expect(Number.isFinite(window.start)).toBe(true)
    expect(Number.isFinite(window.end)).toBe(true)
    expect(window.start).toBe(0)
  })
})

describe('isSegmentVisible', () => {
  const window = { start: 10, end: 20 }

  it('完全在内/相交/贴边可见', () => {
    expect(isSegmentVisible({ start: 11, end: 19 }, window)).toBe(true)
    expect(isSegmentVisible({ start: 9, end: 11 }, window)).toBe(true)
    expect(isSegmentVisible({ start: 20, end: 25 }, window)).toBe(true)
  })

  it('完全在外不可见', () => {
    expect(isSegmentVisible({ start: 0, end: 9.9 }, window)).toBe(false)
    expect(isSegmentVisible({ start: 20.1, end: 30 }, window)).toBe(false)
  })
})