import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  playheadListenerCount,
  publishPlayheadTime,
  subscribePlayheadTime,
  subscribePlayheadTimeThrottled,
} from '../src/editor/components/playheadClock'
import {
  isEditorShortcut,
  isEditableTarget,
  isInsideEditor,
} from '../src/editor/components/keyboardScope'

/**
 * 播放性能相关的两个新模块：
 * - playheadClock：播放头每帧走 DOM 的高频通道（不走 React）；
 * - keyboardScope：快捷键只在编辑器根节点内、且不在输入控件里生效。
 */

describe('playheadClock：高频通道', () => {
  it('每帧广播给所有订阅者，取消后不再收到', () => {
    const first: number[] = []
    const second: number[] = []
    const offFirst = subscribePlayheadTime((time) => first.push(time))
    const offSecond = subscribePlayheadTime((time) => second.push(time))

    publishPlayheadTime(1.5)
    publishPlayheadTime(1.6)
    offFirst()
    publishPlayheadTime(1.7)
    offSecond()

    expect(first).toEqual([1.5, 1.6])
    expect(second).toEqual([1.5, 1.6, 1.7])
    expect(playheadListenerCount()).toBe(0)
  })

  it('单个订阅者抛错不影响其它订阅者与播放循环', () => {
    const received: number[] = []
    const offBad = subscribePlayheadTime(() => {
      throw new Error('boom')
    })
    const offGood = subscribePlayheadTime((time) => received.push(time))
    expect(() => publishPlayheadTime(2)).not.toThrow()
    expect(received).toEqual([2])
    offBad()
    offGood()
  })

  it('节流订阅：10Hz 下 1 秒内最多约 10 次，且尾部值不丢', () => {
    vi.useFakeTimers()
    try {
      const received: number[] = []
      const off = subscribePlayheadTimeThrottled((time) => received.push(time), 10)
      // 模拟 60fps：每 16ms 一帧，共 1 秒
      for (let index = 0; index < 60; index += 1) {
        publishPlayheadTime(index / 60)
        vi.advanceTimersByTime(16)
      }
      vi.advanceTimersByTime(120)
      off()
      // 明显少于 60 次（节流到 ~10Hz），但收到过多次
      expect(received.length).toBeGreaterThanOrEqual(8)
      expect(received.length).toBeLessThanOrEqual(14)
      // 尾部值被投递过（最后一次接近 59/60）
      expect(Math.max(...received)).toBeGreaterThan(0.9)
      expect(playheadListenerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('keyboardScope：快捷键只在编辑器内生效', () => {
  const insideRoot = { closest: (selector: string) => (selector === '.framecut-root' ? {} : null) }
  const outsideRoot = { closest: () => null }

  it('编辑器内部的事件才算编辑器快捷键', () => {
    expect(isEditorShortcut({ target: insideRoot })).toBe(true)
    expect(isInsideEditor({ target: outsideRoot })).toBe(false)
    expect(isEditorShortcut({ target: outsideRoot })).toBe(false)
  })

  it('输入控件里不生效（input / textarea / contentEditable / role=textbox）', () => {
    expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isEditableTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isEditableTarget({ isContentEditable: true })).toBe(true)
    expect(isEditableTarget({ getAttribute: () => 'textbox' })).toBe(true)
    expect(isEditableTarget({ tagName: 'DIV' })).toBe(false)

    expect(isEditorShortcut({ target: { ...insideRoot, tagName: 'INPUT' } })).toBe(false)
    expect(
      isEditorShortcut({ target: { ...insideRoot, isContentEditable: true } }),
    ).toBe(false)
  })

  it('带组合键时默认不抢占（除非允许）', () => {
    expect(isEditorShortcut({ target: insideRoot, ctrlKey: true })).toBe(false)
    expect(isEditorShortcut({ target: insideRoot, metaKey: true })).toBe(false)
    expect(isEditorShortcut({ target: insideRoot, altKey: true })).toBe(false)
    expect(isEditorShortcut({ target: insideRoot, ctrlKey: true }, { allowModifiers: true })).toBe(
      true,
    )
  })

  it('目标不是元素时退回「焦点是否在编辑器内」', () => {
    // node 里没有 document：安全地返回 false，不抛错
    expect(isInsideEditor({ target: null })).toBe(false)
  })
})

/**
 * 结构契约（只剩 3 条）。
 *
 * 为什么保留"读源码"这种脆弱的断言：这几条守的是**跨文件的接线**，单元测试与 E2E
 * 都测不到 —— 比如"Timeline 播放头用 DOM 更新而不是 React 重渲染"，行为上完全正常，
 * 只有实现方式变了性能才会退化（播放时整树 60Hz 重渲染）。
 *
 * 只保留真正跨文件、且退化后没有其它测试能发现的三条；其余曾经放在这里的断言
 * （memo 化、快捷键接线、时钟数学）已经替换成行为测试：
 * - 时钟数学 → tests/playbackClock.test.ts（core/playbackClock.ts 的纯函数）
 * - 快捷键作用域 → 本文件里 keyboardScope 的行为测试
 * - 重播 → e2e/replay.spec.ts
 */
describe('播放性能：结构契约（仅跨文件接线）', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')
  const preview = () => read('src/editor/components/Preview.tsx')

  it('播放循环把播放头交给 10Hz 的 commitTime，不逐帧写 store', () => {
    const source = preview()
    expect(source).toContain('publishPlayheadTime(time)')
    // 逐帧 setPlayhead 会让整树 60Hz 重渲染（实测 59.9 commit/s）。
    expect(source).not.toContain('state.setPlayhead(time)')
    expect(source).toMatch(/now - lastStoreSync >= 100/)
  })

  it('Timeline 的播放头位置直接改 DOM（订阅时钟），不依赖 React 重渲染', () => {
    const timeline = read('src/editor/components/Timeline.tsx')
    expect(timeline).toContain('subscribePlayheadTime(')
    expect(timeline).toMatch(/playheadRef\.current/)
    expect(timeline).toMatch(/element\.style\.left/)
  })

  it('Toolbar 订阅 playhead（按钮可用性依赖它），MediaLibrary 不订阅', () => {
    // Toolbar 若不订阅，拖动播放头后「分割/裁剪」按钮不会解除 disabled
    // —— 这是提示词 13 引入、提示词 14 的 E2E 抓到的真实回归。
    expect(read('src/editor/components/Toolbar.tsx')).toMatch(
      /useEditorStore\(\(state\) => state\.playhead\)/,
    )
    expect(read('src/editor/components/MediaLibrary.tsx')).not.toMatch(
      /useEditorStore\(\(state\) => state\.playhead\)/,
    )
  })
})
