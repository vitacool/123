import { describe, expect, it, vi } from 'vitest'
import { PreviewGainController, type PreviewAudioContextLike } from '../src/editor/services/previewGain'

/**
 * 预览音量 > 100%：`element.volume` 只能到 1，必须用 GainNode。
 * 这些用例锁住三件事：
 * 1. <=1 仍然走原生 volume（不无谓接管）；
 * 2. >1 接管一次、之后由 GainNode 承载（每个元素只能 createMediaElementSource 一次）；
 * 3. 不支持 / 跨域 / 接管失败时退回原生音量，不静音、不抛错。
 */

interface FakeAudioContext extends PreviewAudioContextLike {
  created: HTMLMediaElement[]
  gains: { gain: { value: number }; connect: () => void }[]
}

function fakeContext(state = 'running'): FakeAudioContext {
  const created: HTMLMediaElement[] = []
  const gains: { gain: { value: number }; connect: () => void }[] = []
  return {
    state,
    destination: {},
    created,
    gains,
    createMediaElementSource(element) {
      created.push(element)
      return { connect: () => undefined }
    },
    createGain() {
      const node = { gain: { value: 1 }, connect: () => undefined }
      gains.push(node)
      return node
    },
    resume: vi.fn(async () => undefined) as unknown as PreviewAudioContextLike['resume'],
    close: vi.fn(async () => undefined) as unknown as PreviewAudioContextLike['close'],
  }
}

function fakeElement(src = 'blob:clip'): HTMLMediaElement {
  return { src, currentSrc: src, volume: 1, muted: false } as unknown as HTMLMediaElement
}

describe('PreviewGainController', () => {
  it('音量 <= 1：不接管，直接写 element.volume', () => {
    const context = fakeContext()
    const controller = new PreviewGainController({ createContext: () => context })
    const element = fakeElement()

    controller.setGain(element, 0.4)
    expect(element.volume).toBe(0.4)
    expect(element.muted).toBe(false)
    expect(controller.isRouted(element)).toBe(false)
    expect(context.created).toHaveLength(0)
  })

  it('音量 200%：接管一次，GainNode=2，element.volume 固定 1', () => {
    const context = fakeContext()
    const controller = new PreviewGainController({ createContext: () => context })
    const element = fakeElement()

    controller.setGain(element, 2)
    expect(controller.isRouted(element)).toBe(true)
    expect(element.volume).toBe(1)
    expect(element.muted).toBe(false)
    expect(context.gains[0].gain.value).toBe(2)

    // 再设一次不能重复创建 source node（浏览器第二次会抛错）。
    controller.setGain(element, 3)
    expect(context.created).toHaveLength(1)
    expect(context.gains).toHaveLength(1)
    expect(context.gains[0].gain.value).toBe(3)
  })

  it('接管后再降到 <1 / 0：仍然由 GainNode 控制（不写 element.volume）', () => {
    const context = fakeContext()
    const controller = new PreviewGainController({ createContext: () => context })
    const element = fakeElement()
    controller.setGain(element, 2)

    controller.setGain(element, 0.5)
    expect(element.volume).toBe(1)
    expect(context.gains[0].gain.value).toBe(0.5)

    controller.setGain(element, 0)
    // 静音必须作用在 GainNode 上：接管后 element.muted 不保证生效。
    expect(context.gains[0].gain.value).toBe(0)
    expect(element.muted).toBe(false)
  })

  it('跨域素材不接管（否则会静音），退回原生音量最多 100%', () => {
    const context = fakeContext()
    const controller = new PreviewGainController({ createContext: () => context })
    const element = fakeElement('https://cdn.example.com/video.mp4')

    controller.setGain(element, 2)
    expect(controller.isRouted(element)).toBe(false)
    expect(element.volume).toBe(1)
    expect(context.created).toHaveLength(0)
  })

  it('浏览器不支持 Web Audio：退回原生音量，不抛错', () => {
    const controller = new PreviewGainController({ createContext: () => null })
    const element = fakeElement()
    expect(() => controller.setGain(element, 2)).not.toThrow()
    expect(controller.isRouted(element)).toBe(false)
    expect(element.volume).toBe(1)
  })

  it('createMediaElementSource 抛错（已被接管过）：退回原生音量且不反复重试', () => {
    const context = fakeContext()
    context.createMediaElementSource = () => {
      throw new Error('InvalidStateError')
    }
    const controller = new PreviewGainController({ createContext: () => context })
    const element = fakeElement()

    expect(() => controller.setGain(element, 2)).not.toThrow()
    expect(controller.isRouted(element)).toBe(false)
    expect(element.volume).toBe(1)
  })

  it('AudioContext 被自动播放策略挂起时，接管后调用 resume', () => {
    const context = fakeContext('suspended')
    const controller = new PreviewGainController({ createContext: () => context })
    controller.setGain(fakeElement(), 2)
    expect(context.resume).toHaveBeenCalled()
  })

  it('dispose 关闭 AudioContext（组件卸载时）', () => {
    const context = fakeContext()
    const controller = new PreviewGainController({ createContext: () => context })
    controller.setGain(fakeElement(), 2)
    controller.dispose()
    expect(context.close).toHaveBeenCalled()
  })
})