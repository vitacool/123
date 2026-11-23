import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClip, createInitialProject } from '../src/editor/core/operations'
import { MASK_DEFAULTS } from '../src/editor/core/mask'
import { ExportResources, isAudioRelatedFailure } from '../src/editor/services/exportResources'
import type { Clip, Project, SourceInfo } from '../src/editor/core/types'

/**
 * 导出资源清理：
 * - ExportResources 自身：登记 / 幂等 dispose / 单项失败不影响其它项；
 * - 真流程：蒙版渲染抛错、导出中途取消，都必须把登记的文件 deleteFile、URL revoke；
 * - 无声重试只对「音频相关失败」生效，OOM / 滤镜图错误原样抛给用户。
 */

// ---------------------------------------------------------------------------
// 单元：ExportResources
// ---------------------------------------------------------------------------
describe('ExportResources：登记与幂等清理', () => {
  it('dispose 删除所有登记文件、回收所有登记 URL', async () => {
    const deleted: string[] = []
    const ffmpeg = { deleteFile: async (name: string) => void deleted.push(name) }
    const revoked: string[] = []
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
      revoked.push(url)
    })

    const resources = new ExportResources()
    resources.registerFile('a.mp4')
    resources.registerFiles(['b.png', 'c.txt'])
    resources.registerUrl('blob:one')
    resources.registerUrl('blob:two')
    // 重复登记无副作用
    resources.registerFile('a.mp4')
    resources.registerUrl('blob:one')

    expect(resources.pending.files.sort()).toEqual(['a.mp4', 'b.png', 'c.txt'])
    expect(resources.pending.urls.sort()).toEqual(['blob:one', 'blob:two'])

    await resources.dispose(ffmpeg)
    expect(deleted.sort()).toEqual(['a.mp4', 'b.png', 'c.txt'])
    expect(revoked.sort()).toEqual(['blob:one', 'blob:two'])
    expect(resources.pending).toEqual({ files: [], urls: [] })
    revoke.mockRestore()
  })

  it('dispose 幂等：第二次调用不会重复删除/回收', async () => {
    const deleted: string[] = []
    const revoked: string[] = []
    const ffmpeg = { deleteFile: async (name: string) => void deleted.push(name) }
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
      revoked.push(url)
    })

    const resources = new ExportResources()
    resources.registerFile('a.mp4')
    resources.registerUrl('blob:one')
    await resources.dispose(ffmpeg)
    await resources.dispose(ffmpeg)

    expect(deleted).toEqual(['a.mp4'])
    expect(revoked).toEqual(['blob:one'])
    revoke.mockRestore()
  })

  it('单个文件删除失败不影响其它文件与 URL', async () => {
    const deleted: string[] = []
    const revoked: string[] = []
    const ffmpeg = {
      deleteFile: async (name: string) => {
        deleted.push(name)
        if (name === 'bad.png') throw new Error('删除失败')
      },
    }
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
      revoked.push(url)
    })

    const resources = new ExportResources()
    resources.registerFiles(['bad.png', 'good.mp4'])
    resources.registerUrl('blob:x')
    await expect(resources.dispose(ffmpeg)).resolves.toBeUndefined()

    expect(deleted).toEqual(['bad.png', 'good.mp4'])
    expect(revoked).toEqual(['blob:x'])
    revoke.mockRestore()
  })

  it('ffmpeg 为 null 时只回收 URL 不报错', async () => {
    const revoked: string[] = []
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
      revoked.push(url)
    })
    const resources = new ExportResources()
    resources.registerFile('a.mp4')
    resources.registerUrl('blob:y')
    await resources.dispose(null)
    expect(revoked).toEqual(['blob:y'])
    revoke.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 单元：音频相关失败的识别（决定要不要静默重试）
// ---------------------------------------------------------------------------
describe('isAudioRelatedFailure：只认得音频问题', () => {
  it('引用音频流但输入没有 → 算音频问题', () => {
    expect(
      isAudioRelatedFailure(new Error('FFmpeg 合成失败（退出码 1）。'), [
        "[AVFilterGraph @ 0x1] Stream specifier ':a' in filtergraph description matches no streams.",
      ]),
    ).toBe(true)
    expect(
      isAudioRelatedFailure(new Error('ffmpeg exited 1'), [
        'Stream map \'1:a\' matches no streams.',
      ]),
    ).toBe(true)
  })

  it('音频滤镜/编码器初始化失败 → 算音频问题', () => {
    expect(
      isAudioRelatedFailure(new Error('x'), ['[atempo @ 0x1] Error while filtering: Invalid argument']),
    ).toBe(true)
    expect(
      isAudioRelatedFailure(new Error('x'), ['Error initializing output stream 1:0 -- Error while opening encoder for output stream #1:0']),
    ).toBe(false) // 没点名音频流，不能猜
  })

  it('OOM / 滤镜图语法 / 一般错误 → 不算（不能掩盖真实错误）', () => {
    expect(isAudioRelatedFailure(new Error('Out of memory'), ['[libx264 @ 0x1] out of memory'])).toBe(false)
    expect(isAudioRelatedFailure(new Error('No such filter: nonexist'), ['No such filter: nonexist'])).toBe(false)
    expect(isAudioRelatedFailure(new Error('退出码 1'), ['Invalid argument'])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 流程级：用假的 @ffmpeg/ffmpeg 跑 exportProject，验证失败/取消时清理
// ---------------------------------------------------------------------------
const hoisted = vi.hoisted(() => ({
  /** 每次 new 出来的假 ffmpeg 实例（按创建顺序）。 */
  created: [] as unknown[],
  /** exec 行为：'ok' | 'fail' | 'hang'；`failFirstExec` 只让第一次失败（模拟重试后成功）。 */
  execMode: 'ok' as 'ok' | 'fail' | 'hang',
  failFirstExec: false,
  logLines: [] as string[],
}))

vi.mock('@ffmpeg/ffmpeg', () => {
  class FakeFFmpeg {
    readonly files = new Map<string, Uint8Array | string>()
    readonly deleted: string[] = []
    readonly execArgs: string[][] = []
    terminated = false
    private readonly handlers = new Map<string, Set<(payload: unknown) => void>>()

    constructor() {
      hoisted.created.push(this)
    }

    async load(): Promise<void> {}
    async writeFile(name: string, data: Uint8Array | string): Promise<void> {
      this.files.set(name, data)
    }
    async readFile(name: string): Promise<Uint8Array | string> {
      return this.files.get(name) ?? new Uint8Array([1, 2, 3])
    }
    async deleteFile(name: string): Promise<void> {
      this.deleted.push(name)
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
    emit(event: string, payload: unknown): void {
      for (const handler of this.handlers.get(event) ?? []) handler(payload)
    }
    async exec(args: string[]): Promise<number> {
      this.execArgs.push(args)
      for (const line of hoisted.logLines) this.emit('log', { message: line })
      if (hoisted.execMode === 'hang') return new Promise<number>(() => undefined)
      if (hoisted.failFirstExec && this.execArgs.length === 1) return 1
      if (hoisted.execMode === 'fail') return 1
      return 0
    }
    terminate(): void {
      this.terminated = true
    }
  }
  return { FFmpeg: FakeFFmpeg }
})

type FakeInstance = {
  files: Map<string, Uint8Array | string>
  deleted: string[]
  execArgs: string[][]
  terminated: boolean
}

const fakeInstance = (index = 0): FakeInstance => hoisted.created[index] as FakeInstance

const SOURCE: SourceInfo = {
  url: 'blob:src',
  name: 'src.mp4',
  size: 1024,
  duration: 20,
  width: 1920,
  height: 1080,
  kind: 'video',
  hasAudio: true,
}

const clip = (extra: Partial<Clip> = {}): Clip =>
  createClip(SOURCE.url, 0, 6, { ...extra }, 'clip-1')

const projectOf = (clips: Clip[]): Project => ({
  ...createInitialProject({ url: SOURCE.url, duration: 20 }, clips[0]?.id ?? 'clip-1'),
  aspectRatio: '16:9',
  exportQuality: { resolution: '480p', fps: 30 },
  clips,
})

/** 带 file 的素材，readSource 直接读 Byte 数组，不走网络。 */
const sourceWithFile = (): SourceInfo => ({
  ...SOURCE,
  file: new File([new Uint8Array([0, 1, 2, 3])], 'src.mp4', { type: 'video/mp4' }),
})

async function loadExporter(): Promise<typeof import('../src/editor/services/ffmpegExporter')> {
  vi.resetModules()
  return import('../src/editor/services/ffmpegExporter')
}

beforeEach(() => {
  hoisted.created.length = 0
  hoisted.execMode = 'ok'
  hoisted.failFirstExec = false
  hoisted.logLines = []
  // 导出流程是浏览器代码（coreUrl 用 window.location、蒙版/封面用 canvas）：
  // node 环境下注入最小 window 即可跑通；document 由各用例按需覆盖。
  vi.stubGlobal('window', {
    location: { href: 'http://localhost/' },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('动画中间视频的 objectURL：源码守卫', () => {
  it('URL 在创建处立即登记，且全流程只有一个统一 dispose', () => {
    const text = readFileSync(join(process.cwd(), 'src/editor/services/ffmpegExporter.ts'), 'utf8')
    // 中间视频一渲染完就登记（中途抛错/取消也能回收）
    expect(text).toMatch(/resources\.registerUrl\(url\)/)
    // 准备阶段与渲染阶段共用同一个 finally 的 dispose
    expect(text.match(/resources\.dispose\(/g)).toHaveLength(1)
    // prepareAnimatedProject 必须接收清理器，而不是自己攒一个局部数组
    expect(text).toMatch(/resources: ExportResources/)
    expect(text).not.toMatch(/const animationUrls: string[]/)
  })
})

describe('流程级：蒙版渲染抛错也要清理', () => {
  it('蒙版写入失败 → 已登记的文件全部 deleteFile（蒙版名 / 输入 / 滤镜图 / 输出）', async () => {
    // 模拟「蒙版渲染失败」：canvas 创建即抛错（等价于节点环境没有 canvas 能力）
    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        throw new Error(`无法创建 ${tag}（模拟蒙版渲染失败）`)
      },
    })
    const exporter = await loadExporter()
    const project = projectOf([clip({ mask: { ...MASK_DEFAULTS } })])
    const revoked: string[] = []
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
      revoked.push(url)
    })

    await expect(
      exporter.exportProject(project, sourceWithFile(), [], {}, {}),
    ).rejects.toThrow(/蒙版渲染失败/)

    const fake = fakeInstance()
    expect(fake).toBeTruthy()
    const deleted = fake.deleted
    // 蒙版 PNG 现在会被登记清理（原来从不清理，每次导出都累积在共享 MEMFS 里）
    expect(deleted).toContain('framecut-mask-clip-1.png')
    // 其它登记项也被尝试删除（删不存在的文件是安全的）
    expect(deleted).toContain('framecut-filtergraph.txt')
    expect(deleted).toContain('framecut-output.mp4')
    expect(deleted).toContain('framecut-cover.png')
    expect(deleted).toContain('framecut-selftest.mp4')
    // 输入文件名由 plan 决定（input0.mp4）
    expect(deleted.some((name) => name.startsWith('input'))).toBe(true)
    // 没有动画中间视频 → 不该有 URL 需要回收
    expect(revoked).toEqual([])
  })
})

describe('流程级：中途取消也要清理', () => {
  it('exec 挂起时取消 → 清理已写文件、终止运行时，且不误报成功', async () => {
    const exporter = await loadExporter()
    hoisted.execMode = 'hang'
    const controller = new AbortController()
    const promise = exporter.exportProject(
      projectOf([clip()]),
      sourceWithFile(),
      [],
      {},
      { signal: controller.signal },
    )
    // 让流程走到 exec（输入/滤镜图都写完了），再取消
    await new Promise((done) => setTimeout(done, 30))
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })

    const fake = fakeInstance()
    const deleted = fake.deleted
    expect(deleted.some((name) => name.startsWith('input'))).toBe(true)
    expect(deleted).toContain('framecut-filtergraph.txt')
    expect(deleted).toContain('framecut-output.mp4')
    expect(fake.terminated).toBe(true)
  })

  it('取消后再次导出可以正常进行（activeExportSignal 已清空）', async () => {
    const exporter = await loadExporter()
    hoisted.execMode = 'hang'
    const controller = new AbortController()
    const promise = exporter.exportProject(
      projectOf([clip()]),
      sourceWithFile(),
      [],
      {},
      { signal: controller.signal },
    )
    await new Promise((done) => setTimeout(done, 30))
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })

    // 新一次导出（新的实例、不挂起）应当能跑完，而不是被上一次的 signal 立刻中止
    hoisted.execMode = 'ok'
    const result = await exporter.exportProject(projectOf([clip()]), sourceWithFile(), [], {}, {})
    expect(result.blob.size).toBeGreaterThan(0)
  })
})

describe('流程级：无声重试只对音频相关失败触发', () => {
  it('音频相关失败 → 自动重试无声导出（exec 调用两次，结果带 warning）', async () => {
    const exporter = await loadExporter()
    hoisted.failFirstExec = true
    hoisted.logLines = ["Stream map '1:a' matches no streams."]
    const result = await exporter.exportProject(
      projectOf([clip()]),
      sourceWithFile(),
      [],
      {},
      {},
    )
    expect(result.warning).toContain('无声')
    const fake = fakeInstance()
    expect(fake.execArgs.length).toBe(2)
  })

  it('OOM / 非音频错误 → 不重试，原样抛出', async () => {
    const exporter = await loadExporter()
    hoisted.execMode = 'fail'
    hoisted.logLines = ['[libx264 @ 0x1] out of memory']
    await expect(
      exporter.exportProject(projectOf([clip()]), sourceWithFile(), [], {}, {}),
    ).rejects.toThrow(/退出码 1/)
    const fake = fakeInstance()
    expect(fake.execArgs.length).toBe(1)
  })
})