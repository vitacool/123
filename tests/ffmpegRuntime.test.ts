import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 运行时管理：任务队列 + 代次（generation）+ 超时/取消即重启。
 *
 * 关键回归点（对应这次修复的 4 个问题）：
 * - exec 永久挂起时，超时必须**在限定时间内 reject**（原来会 await deleteFile 变成永久挂起）；
 * - 超时/取消直接 terminate，代次 +1，其他任务的旧代次会收到明确的「运行时已重启，请重试」；
 * - 同一时刻只有一个 exec（队列）；
 * - 降级：多线程自检超时 → 自动切单线程重建实例。
 */

const hoisted = vi.hoisted(() => ({
  instances: [] as unknown[],
  /** 'ok' | 'hang'：exec 是否永久挂起。 */
  execMode: 'ok' as 'ok' | 'hang',
  /** deleteFile 是否永久挂起（验证「超时后不再 await worker」）。 */
  deleteHangs: false,
  /** 进入/离开 exec 的顺序（检查是否重叠）。 */
  events: [] as string[],
}))

vi.mock('@ffmpeg/ffmpeg', () => {
  let nextId = 0
  class FakeFFmpeg {
    readonly id = ++nextId
    readonly files = new Map<string, Uint8Array | string>()
    terminated = false
    private readonly handlers = new Map<string, Set<(payload: unknown) => void>>()

    constructor() {
      hoisted.instances.push(this)
    }

    async load(): Promise<void> {}
    async writeFile(name: string, data: Uint8Array | string): Promise<void> {
      this.files.set(name, data)
    }
    async readFile(name: string): Promise<Uint8Array | string> {
      return this.files.get(name) ?? new Uint8Array([1, 2, 3])
    }
    async deleteFile(name: string): Promise<void> {
      if (hoisted.deleteHangs) return new Promise<void>(() => undefined)
      this.files.delete(name)
    }
    on(event: string, handler: (payload: unknown) => void): void {
      const set = this.handlers.get(event) ?? new Set()
      set.add(handler)
      this.handlers.set(event, set)
    }
    off(event: string, handler: (payload: unknown) => void): void {
      this.handlers.get(event)?.delete(handler)
    }
    async exec(): Promise<number> {
      hoisted.events.push(`enter:${this.id}`)
      if (hoisted.execMode === 'hang') {
        return new Promise<number>(() => undefined)
      }
      await Promise.resolve()
      hoisted.events.push(`exit:${this.id}`)
      return 0
    }
    terminate(): void {
      this.terminated = true
    }
  }
  return { FFmpeg: FakeFFmpeg }
})

type RuntimeModule = typeof import('../src/editor/services/ffmpegRuntime')

async function loadRuntime(): Promise<RuntimeModule> {
  vi.resetModules()
  return import('../src/editor/services/ffmpegRuntime')
}

const fake = (index = 0) =>
  hoisted.instances[index] as { id: number; terminated: boolean; files: Map<string, unknown> }

beforeEach(() => {
  hoisted.instances.length = 0
  hoisted.execMode = 'ok'
  hoisted.deleteHangs = false
  hoisted.events = []
  vi.stubGlobal('window', {
    location: { href: 'http://localhost/' },
    crossOriginIsolated: false,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('超时：exec 永久挂起也必须在限定时间内 reject', () => {
  it('runFFmpegExec 超时 → 立即 reject、terminate 运行时、代次 +1', async () => {
    const runtime = await loadRuntime()
    hoisted.execMode = 'hang'
    const started = Date.now()

    await expect(
      runtime.runFFmpegExec(['-i', 'x'], { timeoutMs: 50 }),
    ).rejects.toThrow(/执行超时/)

    expect(Date.now() - started).toBeLessThan(2000)
    // 超时后共享运行时被销毁（worker 卡在 exec 里只能这样）
    expect(fake(0).terminated).toBe(true)
    expect(runtime.currentGeneration()).toBe(1)
  })

  it('超时后不再 await worker：deleteFile 永久挂起也不影响 reject', async () => {
    const runtime = await loadRuntime()
    hoisted.execMode = 'hang'
    hoisted.deleteHangs = true
    const started = Date.now()
    await expect(runtime.runFFmpegExec(['-i', 'x'], { timeoutMs: 50 })).rejects.toThrow(/执行超时/)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('重启后下一次 exec 会用新实例（自动恢复），不需要人工干预', async () => {
    const runtime = await loadRuntime()
    hoisted.execMode = 'hang'
    await expect(runtime.runFFmpegExec(['-i', 'x'], { timeoutMs: 50 })).rejects.toThrow()

    hoisted.execMode = 'ok'
    await expect(runtime.runFFmpegExec(['-i', 'y'])).resolves.toBe(0)
    expect(hoisted.instances.length).toBe(2)
    expect(fake(1).id).not.toBe(fake(0).id)
  })
})

describe('取消：AbortSignal 立即生效并重启运行时', () => {
  it('exec 挂起时 abort → AbortError，且运行时被 terminate', async () => {
    const runtime = await loadRuntime()
    hoisted.execMode = 'hang'
    const controller = new AbortController()
    const promise = runtime.runFFmpegExec(['-i', 'x'], { signal: controller.signal })
    await new Promise((done) => setTimeout(done, 20))
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(fake(0).terminated).toBe(true)
    expect(runtime.currentGeneration()).toBe(1)
  })

  it('已经 abort 的 signal 不会进入队列', async () => {
    const runtime = await loadRuntime()
    const controller = new AbortController()
    controller.abort()
    await expect(
      runtime.runFFmpegExec(['-i', 'x'], { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(hoisted.events).toEqual([])
  })
})

describe('队列：同一时刻只有一个 exec', () => {
  it('并发调用串行执行，不会出现 enter/enter', async () => {
    const runtime = await loadRuntime()
    await Promise.all([
      runtime.runFFmpegExec(['-i', 'a']),
      runtime.runFFmpegExec(['-i', 'b']),
      runtime.runFFmpegExec(['-i', 'c']),
    ])
    const pattern = hoisted.events.map((event) => event.split(':')[0])
    expect(pattern).toEqual(['enter', 'exit', 'enter', 'exit', 'enter', 'exit'])
  })
})

describe('代次：旧代次任务收到明确的「运行时已重启，请重试」', () => {
  it('运行时重启后，用旧句柄再 exec → RuntimeRestartedError（消息明确）', async () => {
    const runtime = await loadRuntime()
    const handle = await runtime.acquireRuntime()
    runtime.terminateRuntime('测试重启')
    expect(runtime.currentGeneration()).toBe(handle.generation + 1)

    await expect(runtime.execOnRuntime(handle, ['-i', 'x'])).rejects.toThrow('运行时已重启，请重试')
  })

  it('exec 在飞时运行时被重启 → 立刻收到 RuntimeRestartedError（不等 worker 应答）', async () => {
    const runtime = await loadRuntime()
    const handle = await runtime.acquireRuntime()
    hoisted.execMode = 'hang'
    const started = Date.now()
    const promise = runtime.execOnRuntime(handle, ['-i', 'x'])
    await new Promise((done) => setTimeout(done, 20))

    // 显式重启（不是超时/取消路径）：在飞任务也必须立刻收到明确错误
    runtime.terminateRuntime('测试重启')
    await expect(promise).rejects.toThrow('运行时已重启，请重试')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('retryOnRestartOnce：重启错误会重做一次整个流程', async () => {
    const runtime = await loadRuntime()
    let attempts = 0
    const result = await runtime.retryOnRestartOnce(async () => {
      attempts += 1
      if (attempts === 1) throw new runtime.RuntimeRestartedError(runtime.currentGeneration())
      return 'done'
    })
    expect(result).toBe('done')
    expect(attempts).toBe(2)
  })

  it('retryOnRestartOnce：其它错误不重试', async () => {
    const runtime = await loadRuntime()
    let attempts = 0
    await expect(
      runtime.retryOnRestartOnce(async () => {
        attempts += 1
        throw new Error('别的错误')
      }),
    ).rejects.toThrow('别的错误')
    expect(attempts).toBe(1)
  })
})

describe('降级：多线程自检超时 → 自动切单线程重建', () => {
  it('loadExecRuntime 在多线程 exec 挂起时切到单线程', async () => {
    // 模拟支持跨源隔离的环境，走多线程加载路径
    vi.stubGlobal('window', {
      location: { href: 'http://localhost/' },
      crossOriginIsolated: true,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    })
    const runtime = await loadRuntime()
    runtime.setProbeTimeoutMsForTests(50)
    hoisted.execMode = 'hang'

    const handle = await runtime.loadExecRuntimeHandle()
    // 多线程实例自检超时后被销毁，降级为单线程的新实例
    expect(handle.mode).toBe('single-thread')
    expect(hoisted.instances.length).toBeGreaterThanOrEqual(2)
    expect(fake(0).terminated).toBe(true)

    // 降级后 exec 恢复正常（不再挂起）
    hoisted.execMode = 'ok'
    await expect(runtime.runFFmpegExec(['-i', 'x'])).resolves.toBe(0)
    expect(runtime.getRuntimeCapabilities().forcedSingleThread).toBe(true)
  })
})