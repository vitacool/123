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
  /**
   * 'ok' | 'hang'：load() 是否永久挂起。
   *
   * 真实成因：`@ffmpeg/ffmpeg` 的 load() 靠 worker 回消息才 settle，
   * 如果 **worker 脚本本身** 404 / 被 CSP 拦截，load() 永远不 resolve
   * —— 界面卡在「正在加载 FFmpeg…（0%）」。
   */
  loadMode: 'ok' as 'ok' | 'hang',
  /** deleteFile 是否永久挂起（验证「超时后不再 await worker」）。 */
  /** `-encoders` 的输出是否包含 libmp3lame（默认包含）。 */
  hasMp3Encoder: true,
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

    async load(): Promise<void> {
      if (hoisted.loadMode === 'hang') return new Promise<void>(() => undefined)
    }
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
    async exec(args: string[] = []): Promise<number> {
      hoisted.events.push(`enter:${this.id}`)
      if (hoisted.execMode === 'hang') {
        return new Promise<number>(() => undefined)
      }
      await Promise.resolve()
      // 模拟 ffmpeg 的日志输出（MP3 探测靠解析 `-encoders` 的日志）。
      const emit = (message: string) => {
        for (const handler of this.handlers.get('log') ?? []) handler({ message })
      }
      if (args.includes('-encoders')) {
        if (hoisted.hasMp3Encoder) {
          emit(' V..... libmp3lame      libmp3lame MP3 (MPEG audio layer 3)')
        } else {
          emit(' V..... aac            AAC (Advanced Audio Coding)')
        }
      }
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
  hoisted.loadMode = 'ok'
  hoisted.hasMp3Encoder = true
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

/**
 * load() 永久挂起（worker 脚本 404 / 被 CSP 拦截）时必须有超时兜底。
 *
 * 修前：`@ffmpeg/ffmpeg` 的 load() 靠 worker 回消息才 settle，worker 脚本加载失败
 * 就永远不 resolve —— 导出界面卡在「正在加载 FFmpeg…（0%）」，取消后重试也卡，
 * 用户只能刷新页面。
 */
describe('加载超时：核心资源不可用时不能永久卡在 0%', () => {
  it('load 永久挂起 → 在超时后 reject、terminate 实例，且下一次可以重试', async () => {
    const runtime = await loadRuntime()
    runtime.setLoadTimeoutMsForTests(50)
    hoisted.loadMode = 'hang'
    const started = Date.now()

    await expect(runtime.acquireRuntime()).rejects.toThrow(/加载超时/)

    expect(Date.now() - started).toBeLessThan(2000)
    // 卡住的 worker 必须被 terminate，否则会一直占着内存
    expect(fake(0).terminated).toBe(true)

    // 失败后状态被清掉（acquireRuntime 的 catch 分支），所以能重新尝试；
    // 这一次资源正常，应当成功拿到句柄。
    hoisted.loadMode = 'ok'
    await expect(runtime.acquireRuntime()).resolves.toMatchObject({ generation: expect.any(Number) })
    expect(runtime.currentGeneration()).toBeGreaterThanOrEqual(0)
  })

  it('多线程 load 挂起时不会被误判为「加载失败并降级」，而是直接报超时', async () => {
    const runtime = await loadRuntime()
    runtime.setLoadTimeoutMsForTests(50)
    hoisted.loadMode = 'hang'

    await expect(runtime.acquireRuntime()).rejects.toThrow(/加载超时/)
    // 超时是明确的失败信号，不该悄悄把 forcedSingleThread 置真
    expect(runtime.getRuntimeCapabilities().forcedSingleThread).toBe(false)
  })
})

/**
 * MP3 编码器探测：以前直接 `handle.ffmpeg.exec(...)`，绕过串行队列且没有超时。
 * exec 挂起时 Promise 永不 settle → 导出弹窗的 checkingMp3 永远为 true →
 * 格式按钮全部禁用，只能关窗重开。
 */
describe('MP3 编码器探测：不绕队列、不永久挂起、失败不缓存', () => {
  it('正常情况：解析 -encoders 日志里的 libmp3lame 与「无」两种结果', async () => {
    const runtime = await loadRuntime()
    await expect(runtime.isMp3EncoderAvailable()).resolves.toBe(true)

    // 换一个全新模块实例，模拟没有 libmp3lame 的构建
    hoisted.hasMp3Encoder = false
    const runtime2 = await loadRuntime()
    await expect(runtime2.isMp3EncoderAvailable()).resolves.toBe(false)
  })

  it('exec 挂起 → 在探测超时内返回 false（不永久挂起），且不缓存、下次可重试', async () => {
    const runtime = await loadRuntime()
    runtime.setProbeTimeoutMsForTests(50)
    hoisted.execMode = 'hang'
    const started = Date.now()

    await expect(runtime.isMp3EncoderAvailable()).resolves.toBe(false)
    expect(Date.now() - started).toBeLessThan(2000)

    // 关键：结果没有被缓存成 false —— 环境恢复后还能探测出 true
    hoisted.execMode = 'ok'
    await expect(runtime.isMp3EncoderAvailable()).resolves.toBe(true)
  })

  it('探测与其它 exec 串行（不打断正在跑的任务）', async () => {
    const runtime = await loadRuntime()
    hoisted.events = []
    await Promise.all([
      runtime.runFFmpegExec(['-i', 'x']),
      runtime.isMp3EncoderAvailable(),
      runtime.runFFmpegExec(['-i', 'y']),
    ])
    // 队列保证 enter/exit 严格交替，不会出现 enter:1 enter:1
    const sequence = hoisted.events.join(',')
    expect(sequence).not.toMatch(/enter:(\d+),enter:\1/)
  })
})

/**
 * 导出自检（probeRuntimeForExport / ForAudio）以前直接 `ffmpeg.exec(...)`：
 * 绕过串行队列，可能与导出/倒放/ASR **并发**抢同一个 worker；超时时
 * `terminateRuntime()` 又会把别人正在跑的任务一起杀掉。
 */
describe('导出自检：走队列 + 使用调用方句柄', () => {
  it('自检与其它 exec 串行，不会并发抢 worker', async () => {
    const runtime = await loadRuntime()
    hoisted.events = []
    await Promise.all([
      runtime.runFFmpegExec(['-i', 'a']),
      runtime.probeRuntimeForAudio(),
      runtime.runFFmpegExec(['-i', 'b']),
    ])
    const sequence = hoisted.events.join(',')
    expect(sequence).not.toMatch(/enter:(\d+),enter:\1/)
    // 三次任务都真的跑了
    expect(hoisted.events.filter((item) => item.startsWith('enter:')).length).toBe(3)
  })

  it('传入句柄时不重新 acquire（避免探测到另一个代次的实例）', async () => {
    const runtime = await loadRuntime()
    const handle = await runtime.acquireRuntime()
    const createdBefore = hoisted.instances.length
    await runtime.probeRuntimeForAudio(handle)
    // 没有再创建新实例 = 用的是调用方那个句柄
    expect(hoisted.instances.length).toBe(createdBefore)
  })

  it('自检超时后运行时被重建，后续任务能继续（不会永久卡死）', async () => {
    const runtime = await loadRuntime()
    runtime.setProbeTimeoutMsForTests(50)
    hoisted.execMode = 'hang'
    const handle = await runtime.acquireRuntime()

    await expect(runtime.probeRuntimeForAudio(handle)).resolves.toBe('timeout')

    // 运行时已被重启（代次 +1），下一次 exec 用新实例恢复正常
    hoisted.execMode = 'ok'
    await expect(runtime.runFFmpegExec(['-i', 'next'])).resolves.toBe(0)
    expect(runtime.currentGeneration()).toBeGreaterThan(handle.generation)
  })
})