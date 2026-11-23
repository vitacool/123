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

describe('源码守卫：播放期间不再逐帧触发 React 渲染', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

  it('Preview 的播放循环用 commitTime（DOM + 10Hz store），不再每帧 setPlayhead', () => {
    const preview = read('src/editor/components/Preview.tsx')
    expect(preview).toContain('publishPlayheadTime(time)')
    // 逐帧写 store 的旧写法必须消失
    expect(preview).not.toContain('state.setPlayhead(time)')
    // store 同步是节流的
    expect(preview).toMatch(/now - lastStoreSync >= 100/)
  })

  it('Timeline 播放头位置直接改 DOM（订阅时钟），不依赖 React 重渲染', () => {
    const timeline = read('src/editor/components/Timeline.tsx')
    expect(timeline).toContain('subscribePlayheadTime(')
    expect(timeline).toMatch(/playheadRef\.current/)
    expect(timeline).toMatch(/element\.style\.left/)
  })

  it('MediaLibrary 不订阅 playhead；Toolbar 必须订阅（按钮可用性依赖它）', () => {
    // MediaLibrary 只在点击时用播放头 → 不订阅，播放期间零重渲染。
    expect(read('src/editor/components/MediaLibrary.tsx')).not.toMatch(
      /useEditorStore\(\(state\) => state\.playhead\)/,
    )
    // Toolbar 的「能否分割/裁剪」是按播放头位置算的：必须订阅，
    // 否则拖动播放头后按钮不会解除 disabled（E2E 抓到的真实回归）。
    // 播放期间的开销由 store 的 10Hz 节流兜住（见 Preview 的 commitTime）。
    expect(read('src/editor/components/Toolbar.tsx')).toMatch(
      /useEditorStore\(\(state\) => state\.playhead\)/,
    )
    expect(read('src/editor/components/Preview.tsx')).toMatch(/now - lastStoreSync >= 100/)
  })

  it('缩略图条与关键帧条已 memo 化', () => {
    expect(read('src/editor/components/ClipFilmstrip.tsx')).toContain('memo(ClipFilmstripInner)')
    expect(read('src/editor/components/ClipKeyframeBand.tsx')).toContain(
      'memo(ClipKeyframeBandInner)',
    )
  })

  it('快捷键使用统一作用域守卫', () => {
    expect(read('src/editor/components/CropOverlay.tsx')).toContain('isEditorShortcut(event)')
    expect(read('src/editor/components/MediaLibrary.tsx')).toContain('isEditorShortcut(event)')
  })

  it('时钟以主视频推进为准：不推进时冻结墙钟，并处理 visibilitychange', () => {
    const preview = read('src/editor/components/Preview.tsx')
    expect(preview).toMatch(/anchorWall/)
    expect(preview).toMatch(/stalledSince/)
    expect(preview).toContain("document.addEventListener('visibilitychange'")
    expect(preview).toContain("document.removeEventListener('visibilitychange'")
  })
})