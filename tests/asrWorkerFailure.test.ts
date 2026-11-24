import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * ASR worker 的失败路径回归。
 *
 * 真实事故：`new Worker()` 的脚本加载失败（资源 404、宿主没部署 dist-lib/assets、
 * CSP 禁 module worker）**不会抛错**，只异步派发 `error` 事件。原来的 provider 只监听
 * `message`，于是 transcribe 的 Promise 永久 pending：
 * - 界面永远停在「正在识别」，没有任何错误；
 * - 取消后重试还是同一个坏 worker（单例），只能刷新页面。
 *
 * 这里锁住三件事：worker 级错误必须 reject、长时间无消息必须超时、中止必须是 AbortError。
 */

type Handler = (event: unknown) => void

const state = vi.hoisted(() => ({
  behavior: 'error' as 'error' | 'ok' | 'silent',
  instances: [] as unknown[],
}))

class FakeWorker {
  readonly listeners = new Map<string, Set<Handler>>()
  readonly messages: unknown[] = []
  terminated = false

  constructor() {
    state.instances.push(this)
    if (state.behavior === 'error') {
      // 真实浏览器里脚本加载失败是异步事件，且永远不会有 message。
      setTimeout(() => this.emit('error', { message: 'Failed to load worker script' }), 0)
    }
  }

  addEventListener(type: string, handler: Handler): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)?.add(handler)
  }

  removeEventListener(type: string, handler: Handler): void {
    this.listeners.get(type)?.delete(handler)
  }

  postMessage(message: unknown): void {
    this.messages.push(message)
    if (state.behavior !== 'ok') return
    const id = (message as { id?: number }).id
    setTimeout(() => this.emit('message', { data: { id, type: 'result', words: [{ text: '你好', start: 0, end: 0.4 }] } }), 0)
  }

  terminate(): void {
    this.terminated = true
  }

  emit(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }
}

beforeEach(() => {
  state.behavior = 'error'
  state.instances = []
  vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker)
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

/** 500ms 内必须结束；否则视为「永久挂起」。 */
async function within(promise: Promise<unknown>, ms = 500): Promise<string> {
  return Promise.race([
    promise.then(
      () => 'resolved',
      (error: Error) => `rejected:${error.name}:${error.message}`,
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('still-pending'), ms)),
  ])
}

describe('whisperProvider：worker 加载失败', () => {
  it('worker error 事件 → reject（不是永久 pending）', async () => {
    const { createWhisperProvider } = await import('../src/editor/services/asr/whisperProvider')
    const provider = createWhisperProvider('Xenova/whisper-tiny')
    const outcome = await within(provider.transcribe(new Float32Array(16000), { language: 'zh' }))
    expect(outcome).toContain('rejected:')
    expect(outcome).toContain('加载失败')
  })

  it('失败后丢弃 worker，下次调用重建（不会继续用坏 worker）', async () => {
    const { createWhisperProvider } = await import('../src/editor/services/asr/whisperProvider')
    const provider = createWhisperProvider('Xenova/whisper-tiny')
    await within(provider.transcribe(new Float32Array(16000), { language: 'zh' }))
    const first = state.instances[0] as FakeWorker
    expect(first.terminated).toBe(true)
    await within(provider.transcribe(new Float32Array(16000), { language: 'zh' }))
    expect(state.instances.length).toBe(2)
  })

  it('中止 → AbortError，并把 cancel 转给 worker', async () => {
    state.behavior = 'silent'
    const { createWhisperProvider } = await import('../src/editor/services/asr/whisperProvider')
    const provider = createWhisperProvider('Xenova/whisper-tiny')
    const controller = new AbortController()
    const pending = provider.transcribe(new Float32Array(16000), {
      language: 'zh',
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 5)
    const outcome = await within(pending)
    expect(outcome.startsWith('rejected:AbortError')).toBe(true)
    const worker = state.instances[0] as FakeWorker
    expect(worker.messages.some((message) => (message as { type?: string }).type === 'cancel')).toBe(true)
  })
})

describe('runSileroVad：worker 加载失败', () => {
  it('reject 而不是挂起，并锁定「不可用」避免每个素材重试', async () => {
    const { runSileroVad, resetVadWorkerForTest, vadUnavailableReason } = await import(
      '../src/editor/services/asr/sileroVad'
    )
    resetVadWorkerForTest()
    const first = await within(runSileroVad(new Float32Array(16000)))
    expect(first).toContain('rejected:')
    expect(vadUnavailableReason()).toContain('人声检测不可用')

    // 第二次立即失败（不再新建 worker、不再拉模型）。
    const instances = state.instances.length
    const second = await within(runSileroVad(new Float32Array(16000)), 200)
    expect(second).toContain('rejected:')
    expect(state.instances.length).toBe(instances)
  })

  it('中止不锁定不可用（取消不等于故障）', async () => {
    state.behavior = 'silent'
    const { runSileroVad, resetVadWorkerForTest, vadUnavailableReason } = await import(
      '../src/editor/services/asr/sileroVad'
    )
    resetVadWorkerForTest()
    const controller = new AbortController()
    const pending = runSileroVad(new Float32Array(16000), controller.signal)
    setTimeout(() => controller.abort(), 5)
    const outcome = await within(pending)
    expect(outcome.startsWith('rejected:AbortError')).toBe(true)
    expect(vadUnavailableReason()).toBeNull()
  })
})