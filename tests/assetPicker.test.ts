import { afterEach, describe, expect, it, vi } from 'vitest'
import { pickFilesWithCancel } from '../src/editor/services/assetPicker'

/**
 * 「取消选择素材」不能再把导入流程挂死：
 * - Chrome/Firefox/Safari 新版会在取消时触发 input 的 cancel 事件；
 * - 老浏览器没有 cancel，靠窗口重新聚焦 + 延迟检查 files 为空兜底；
 * - 任何情况下 Promise 都必须 resolve（而不是永远 pending）。
 */

/** 最小 input 替身：只需要 files/value + 事件监听。 */
class FakeInput extends EventTarget {
  files: File[] = []
  value = ''
}

const fileOf = (name: string): File => new File([new Uint8Array([1])], name, { type: 'video/mp4' })

afterEach(() => {
  vi.useRealTimers()
})

describe('pickFilesWithCancel：一定会 resolve', () => {
  it('选到文件时 resolve { files }（cancelled=false）', async () => {
    const input = new FakeInput()
    const pending = pickFilesWithCancel(input)
    input.files = [fileOf('clip.mp4')]
    input.dispatchEvent(new Event('change'))
    await expect(pending).resolves.toMatchObject({ cancelled: false })
    await expect(pending).resolves.toHaveProperty('files', [expect.objectContaining({ name: 'clip.mp4' })])
  })

  it('cancel 事件：宽限期后 resolve 为 cancelled（不再永久挂起）', async () => {
    vi.useFakeTimers()
    const input = new FakeInput()
    const pending = pickFilesWithCancel(input, { cancelGraceMs: 100 })
    let settled = false
    void pending.then(() => {
      settled = true
    })

    input.dispatchEvent(new Event('cancel'))
    await vi.advanceTimersByTimeAsync(50)
    expect(settled, '宽限期内应继续等 change，不立刻判取消').toBe(false)

    await vi.advanceTimersByTimeAsync(100)
    await expect(pending).resolves.toEqual({ files: [], cancelled: true })
  })

  it('cancel 后紧跟 change（自动化接管文件框时 Firefox 的时序）→ 以 change 为准', async () => {
    vi.useFakeTimers()
    const input = new FakeInput()
    const pending = pickFilesWithCancel(input, { cancelGraceMs: 100 })

    input.dispatchEvent(new Event('cancel'))
    input.files = [fileOf('clip.mp4')]
    input.dispatchEvent(new Event('change'))
    await vi.advanceTimersByTimeAsync(200)

    await expect(pending).resolves.toMatchObject({ cancelled: false })
  })

  it('老浏览器没有 cancel：窗口重新聚焦后检查 files 为空 → 判为取消', async () => {
    vi.useFakeTimers()
    const input = new FakeInput()
    const focusTarget = new EventTarget()
    let outcome: { cancelled: boolean } | null = null
    void pickFilesWithCancel(input, { focusTarget, cancelFallbackDelay: 50 }).then((result) => {
      outcome = result
    })

    focusTarget.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(60)

    expect(outcome).toEqual({ files: [], cancelled: true })
  })

  it('窗口重新聚焦但已经选到文件 → 不误判为取消', async () => {
    vi.useFakeTimers()
    const input = new FakeInput()
    const focusTarget = new EventTarget()
    const pending = pickFilesWithCancel(input, { focusTarget, cancelFallbackDelay: 50 })

    input.files = [fileOf('clip.mp4')]
    input.dispatchEvent(new Event('change'))
    focusTarget.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(60)

    await expect(pending).resolves.toMatchObject({ cancelled: false })
  })

  it('重复事件不会二次 resolve（监听在 settle 后移除）', async () => {
    const input = new FakeInput()
    const pending = pickFilesWithCancel(input)
    input.files = [fileOf('a.mp4')]
    input.dispatchEvent(new Event('change'))
    // 再触发一次 cancel：已经 settle 的 Promise 不会改变结果。
    input.dispatchEvent(new Event('cancel'))
    await expect(pending).resolves.toMatchObject({ cancelled: false })
  })
})