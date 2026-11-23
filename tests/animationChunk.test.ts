import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ANIMATION_CHUNK_FRAMES,
  createAnimationSourcePool,
  planAnimationChunks,
  renderAnimatedClipToFile,
} from '../src/editor/services/animationRenderer'
import { animationFrameCount } from '../src/editor/core/animationExport'
import { resetKeyerForTest, isKeyerAvailable } from '../src/editor/services/webglKeyer'
import type { Clip, Project, SourceInfo } from '../src/editor/core/types'

/**
 * 动画帧分块编码：
 * - 分块计划必须「不丢帧、不重复帧」，总帧数与时长严格等于动画本身；
 * - MEMFS 里同时存在的 PNG 不超过**一个块**（原来是把整段所有帧一次写进去）；
 * - 同一源只写一份（导出流程共用一个源文件池），流程结束统删除。
 *
 * WebGL：
 * - 着色器/链接失败后**缓存失败结果**，重复调用不再创建上下文；
 * - 失败路径必须 WEBGL_lose_context 释放。
 */

// ---------------------------------------------------------------- ffmpeg mock

const ffmpegState = vi.hoisted(() => ({
  live: new Set<string>(),
  writes: [] as string[],
  deletes: [] as string[],
  execs: [] as string[][],
  /** 每次 writeFile 之后记录当时仍存活的 PNG 数（用于断言峰值）。 */
  pngPeak: 0,
}))

vi.mock('@ffmpeg/ffmpeg', () => {
  class FakeFFmpeg {
    readonly files = new Map<string, Uint8Array | string>()
    async load(): Promise<void> {}
    async writeFile(name: string, data: Uint8Array | string): Promise<void> {
      this.files.set(name, data)
      ffmpegState.live.add(name)
      ffmpegState.writes.push(name)
      const pngs = [...ffmpegState.live].filter((file) => file.endsWith('.png')).length
      if (pngs > ffmpegState.pngPeak) ffmpegState.pngPeak = pngs
    }
    async readFile(name: string): Promise<Uint8Array | string> {
      return this.files.get(name) ?? new Uint8Array([1, 2, 3, 4])
    }
    async deleteFile(name: string): Promise<void> {
      this.files.delete(name)
      ffmpegState.live.delete(name)
      ffmpegState.deletes.push(name)
    }
    on(): void {}
    off(): void {}
    async exec(args: string[]): Promise<number> {
      ffmpegState.execs.push(args)
      return 0
    }
    terminate(): void {}
  }
  return { FFmpeg: FakeFFmpeg }
})

// ---------------------------------------------------------------- DOM stubs

const domState = vi.hoisted(() => ({
  canvases: 0,
  glContexts: 0,
  loseContextCalls: 0,
  /** getContext('webgl') 返回的假上下文是否可用。 */
  glAvailable: false,
  /** 着色器编译是否失败。 */
  shaderFails: false,
}))

function noop2d(): unknown {
  const target: Record<string, unknown> = {}
  return new Proxy(target, {
    get(_target, key) {
      if (key === 'canvas') return null
      return () => undefined
    },
    set() {
      return true
    },
  })
}

function fakeCanvas(): unknown {
  domState.canvases += 1
  const canvas: Record<string, unknown> = {
    width: 0,
    height: 0,
    getContext: (type: string) => {
      if (type === '2d') return noop2d()
      if (type === 'webgl') {
        if (!domState.glAvailable) return null
        domState.glContexts += 1
        return fakeGl(canvas)
      }
      return null
    },
    toBlob: (callback: (blob: Blob | null) => void) => {
      callback(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }))
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
  return canvas
}

function fakeGl(canvas: Record<string, unknown>): unknown {
  const constant = (name: string): number => name.length
  const gl: Record<string, unknown> = {
    canvas,
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    TEXTURE_2D: 7,
    TEXTURE_WRAP_S: 8,
    TEXTURE_WRAP_T: 9,
    TEXTURE_MIN_FILTER: 10,
    TEXTURE_MAG_FILTER: 11,
    CLAMP_TO_EDGE: 12,
    LINEAR: 13,
    TEXTURE0: 14,
    RGBA: 15,
    UNSIGNED_BYTE: 16,
    TRIANGLE_STRIP: 17,
  }
  const obj = () => ({ id: Math.random() })
  Object.assign(gl, {
    createShader: obj,
    shaderSource: () => undefined,
    compileShader: () => undefined,
    getShaderParameter: () => !domState.shaderFails,
    deleteShader: () => undefined,
    createProgram: obj,
    attachShader: () => undefined,
    linkProgram: () => undefined,
    getProgramParameter: () => true,
    deleteProgram: () => undefined,
    useProgram: () => undefined,
    createBuffer: obj,
    bindBuffer: () => undefined,
    bufferData: () => undefined,
    getAttribLocation: () => 0,
    enableVertexAttribArray: () => undefined,
    vertexAttribPointer: () => undefined,
    getUniformLocation: () => obj(),
    createTexture: obj,
    bindTexture: () => undefined,
    texParameteri: () => undefined,
    deleteTexture: () => undefined,
    getExtension: (name: string) =>
      name === 'WEBGL_lose_context'
        ? { loseContext: () => void (domState.loseContextCalls += 1) }
        : null,
  })
  void constant
  return gl
}

type Listeners = Map<string, Set<(...args: unknown[]) => void>>

function fakeVideo(): unknown {
  const listeners: Listeners = new Map()
  const emit = (type: string): void => {
    for (const handler of listeners.get(type) ?? []) handler({ type })
  }
  const video: Record<string, unknown> = {
    muted: false,
    playsInline: false,
    preload: '',
    crossOrigin: '',
    readyState: 4,
    videoWidth: 320,
    videoHeight: 180,
    addEventListener: (type: string, handler: (...args: unknown[]) => void) => {
      const set = listeners.get(type) ?? new Set()
      set.add(handler)
      listeners.set(type, set)
      // 真实浏览器里 seek() 会先等上一次 seek 的 'seeked'（元素本身可能已在 seek 中），
      // 所以这里注册监听后立刻异步补发一次，避免测试死等。
      if (type === 'seeked') queueMicrotask(() => handler({ type }))
    },
    removeEventListener: (type: string, handler: (...args: unknown[]) => void) => {
      listeners.get(type)?.delete(handler)
    },
    pause: () => undefined,
    load: () => undefined,
    removeAttribute: () => undefined,
  }
  let currentTime = 0
  Object.defineProperty(video, 'currentTime', {
    get: () => currentTime,
    set: (value: number) => {
      currentTime = value
      emit('seeked')
    },
  })
  Object.defineProperty(video, 'src', {
    get: () => 'blob:video',
    set: () => {
      queueMicrotask(() => emit('loadeddata'))
    },
  })
  return video
}

beforeEach(() => {
  ffmpegState.live.clear()
  ffmpegState.writes = []
  ffmpegState.deletes = []
  ffmpegState.execs = []
  ffmpegState.pngPeak = 0
  domState.canvases = 0
  domState.glContexts = 0
  domState.loseContextCalls = 0
  domState.glAvailable = false
  domState.shaderFails = false
  resetKeyerForTest()

  vi.stubGlobal('window', {
    location: { href: 'http://localhost/' },
    crossOriginIsolated: false,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    requestAnimationFrame: (cb: () => void) => globalThis.setTimeout(cb, 0),
  })
  vi.stubGlobal('document', {
    createElement: (tag: string) => (tag === 'canvas' ? fakeCanvas() : fakeVideo()),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetKeyerForTest()
})

// ---------------------------------------------------------------- 公共数据

const VIDEO_ASSET: SourceInfo = {
  url: 'blob:src',
  name: 'src.mp4',
  size: 1024,
  duration: 10,
  width: 320,
  height: 180,
  kind: 'video',
  hasAudio: true,
  file: new File([new Uint8Array([9, 9, 9])], 'src.mp4', { type: 'video/mp4' }),
}

const clipOf = (duration: number, id = 'clip-1'): Clip =>
  ({
    id,
    sourceUrl: VIDEO_ASSET.url,
    sourceStart: 0,
    sourceEnd: duration,
    type: 'video',
    rotation: 0,
    flipH: false,
    flipV: false,
    crop: { x: 0, y: 0, width: 1, height: 1 },
    scale: 1,
    position: { x: 0, y: 0 },
    gapBefore: 0,
    anim: { 'position.x': [{ t: 0, value: 0, ease: 'linear' }] },
  }) as unknown as Clip

const projectOf = (clip: Clip): Project =>
  ({
    aspectRatio: '16:9',
    exportQuality: { resolution: '480p', fps: 30 },
    clips: [clip],
    markers: [],
  }) as unknown as Project

const runtimeOf = async () => {
  const runtime = await import('../src/editor/services/ffmpegRuntime')
  const handle = await runtime.acquireRuntime()
  return { runtime: runtime as typeof import('../src/editor/services/ffmpegRuntime'), handle }
}

// ---------------------------------------------------------------- 分块计划

describe('planAnimationChunks：不丢帧、不重复帧', () => {
  it('整块切分：总帧数守恒，块之间首尾相接', () => {
    const chunks = planAnimationChunks(90, 30)
    expect(chunks).toEqual([
      { start: 0, count: 30 },
      { start: 30, count: 30 },
      { start: 60, count: 30 },
    ])
    expect(chunks.reduce((sum, chunk) => sum + chunk.count, 0)).toBe(90)
  })

  it('残块：最后一块只取剩下的帧', () => {
    const chunks = planAnimationChunks(65, 30)
    expect(chunks).toEqual([
      { start: 0, count: 30 },
      { start: 30, count: 30 },
      { start: 60, count: 5 },
    ])
    // 严格连续：下一块的 start = 上一块 start + count
    for (let index = 1; index < chunks.length; index += 1) {
      expect(chunks[index].start).toBe(chunks[index - 1].start + chunks[index - 1].count)
    }
  })

  it('少于一块 / 零帧', () => {
    expect(planAnimationChunks(0, 30)).toEqual([])
    expect(planAnimationChunks(12, 30)).toEqual([{ start: 0, count: 12 }])
  })

  it('块大小非法时按 1 处理（不会死循环）', () => {
    expect(planAnimationChunks(3, 0)).toEqual([
      { start: 0, count: 1 },
      { start: 1, count: 1 },
      { start: 2, count: 1 },
    ])
  })
})

// ---------------------------------------------------------------- 渲染流程

describe('渲染流程：MEMFS 峰值 ≤ 一个块', () => {
  it('90 帧动画分 3 块编码，PNG 峰值不超过 30，总帧数严格等于动画帧数', async () => {
    const { handle } = await runtimeOf()
    const clip = clipOf(3)
    const fps = 30
    const total = animationFrameCount(clip, fps)
    expect(total).toBe(90)

    const file = await renderAnimatedClipToFile({
      clip,
      asset: VIDEO_ASSET,
      trackId: null,
      project: projectOf(clip),
      width: 320,
      height: 180,
      fps,
      index: 0,
      runtime: handle,
      signal: null,
    })

    expect(file.name).toBe('anim_0.mp4')
    // PNG 峰值就是一个块的量（原来会是 90）
    expect(ffmpegState.pngPeak).toBeLessThanOrEqual(ANIMATION_CHUNK_FRAMES)
    expect(ffmpegState.pngPeak).toBe(ANIMATION_CHUNK_FRAMES)

    // 分块编码命令：每块 -frames:v = 该块帧数，合计 = 总帧数
    const chunkExecs = ffmpegState.execs.filter((args) => args.includes('-frames:v'))
    expect(chunkExecs).toHaveLength(3)
    const encodedFrames = chunkExecs.reduce((sum, args) => {
      const at = args.indexOf('-frames:v') + 1
      return sum + Number(args[at])
    }, 0)
    expect(encodedFrames).toBe(total)

    // 块内 PNG 编码完就被删除（不是留到最后）
    expect(ffmpegState.deletes.filter((name) => name.endsWith('.png'))).toHaveLength(90)

    // 多块 → concat，再混音；视频流 copy 不重编码
    const concat = ffmpegState.execs.find((args) => args.includes('concat'))
    expect(concat).toBeTruthy()
    const mux = ffmpegState.execs[ffmpegState.execs.length - 1]
    expect(mux).toContain('-c:v')
    expect(mux[mux.indexOf('-c:v') + 1]).toBe('copy')

    // 收尾：所有临时 PNG/分块都清掉
    expect([...ffmpegState.live].filter((name) => name.endsWith('.png'))).toHaveLength(0)
  })

  it('短片段只分一块：不 concat，直接混音', async () => {
    const { handle } = await runtimeOf()
    const clip = clipOf(1)
    const fps = 30
    const total = animationFrameCount(clip, fps)
    expect(total).toBeLessThanOrEqual(ANIMATION_CHUNK_FRAMES)

    await renderAnimatedClipToFile({
      clip,
      asset: VIDEO_ASSET,
      trackId: null,
      project: projectOf(clip),
      width: 320,
      height: 180,
      fps,
      index: 0,
      runtime: handle,
      signal: null,
    })
    expect(ffmpegState.execs.some((args) => args.includes('concat'))).toBe(false)
    expect(ffmpegState.pngPeak).toBe(total)
  })
})

describe('源文件：同一源只写一份（引用计数 + 池）', () => {
  it('两个片段共用同一个池 → 源文件只写一次，dispose 后删除', async () => {
    const { runtime, handle } = await runtimeOf()
    const fps = 30
    const pool = createAnimationSourcePool()

    const clipA = clipOf(1, 'clip-a')
    for (const [index, clip] of [clipA, clipOf(1, 'clip-b')].entries()) {
      await renderAnimatedClipToFile({
        clip,
        asset: VIDEO_ASSET,
        trackId: null,
        project: projectOf(clip),
        width: 320,
        height: 180,
        fps,
        index,
        runtime: handle,
        signal: null,
        sources: pool,
      })
    }

    const sourceWrites = ffmpegState.writes.filter((name) => name.startsWith('anim-src-'))
    expect(sourceWrites).toHaveLength(1)
    expect(pool.files).toHaveLength(1)

    await pool.dispose(handle)
    expect(ffmpegState.deletes).toContain(sourceWrites[0])
    expect(pool.files).toHaveLength(0)
    void runtime
  })

  it('不传池（单片段）：自建并释放，结束时源文件被删除', async () => {
    const { handle } = await runtimeOf()
    const clip = clipOf(1)
    await renderAnimatedClipToFile({
      clip,
      asset: VIDEO_ASSET,
      trackId: null,
      project: projectOf(clip),
      width: 320,
      height: 180,
      fps: 30,
      index: 0,
      runtime: handle,
      signal: null,
    })
    const sourceWrites = ffmpegState.writes.filter((name) => name.startsWith('anim-src-'))
    expect(sourceWrites).toHaveLength(1)
    expect(ffmpegState.deletes).toContain(sourceWrites[0])
    expect([...ffmpegState.live].filter((name) => name.startsWith('anim-src-'))).toHaveLength(0)
  })
})

// ---------------------------------------------------------------- WebGL

describe('webglKeyer：失败结果缓存 + 释放上下文', () => {
  it('着色器编译失败后重复调用不再创建上下文，且已用 lose_context 释放', () => {
    domState.glAvailable = true
    domState.shaderFails = true

    expect(isKeyerAvailable()).toBe(false)
    const canvasesAfterFirst = domState.canvases
    const contextsAfterFirst = domState.glContexts
    expect(canvasesAfterFirst).toBe(1)
    expect(contextsAfterFirst).toBe(1)
    expect(domState.loseContextCalls).toBe(1)

    // 再调 10 次（模拟每帧调用）：不该再新建 canvas / WebGL 上下文
    for (let index = 0; index < 10; index += 1) {
      expect(isKeyerAvailable()).toBe(false)
    }
    expect(domState.canvases).toBe(canvasesAfterFirst)
    expect(domState.glContexts).toBe(contextsAfterFirst)
  })

  it('拿不到 webgl 上下文时同样缓存失败（且不再重试）', () => {
    domState.glAvailable = false
    expect(isKeyerAvailable()).toBe(false)
    const canvases = domState.canvases
    for (let index = 0; index < 5; index += 1) isKeyerAvailable()
    expect(domState.canvases).toBe(canvases)
  })

  it('成功时只创建一个上下文（多次调用复用）', () => {
    domState.glAvailable = true
    domState.shaderFails = false
    expect(isKeyerAvailable()).toBe(true)
    for (let index = 0; index < 5; index += 1) expect(isKeyerAvailable()).toBe(true)
    expect(domState.canvases).toBe(1)
    expect(domState.glContexts).toBe(1)
    expect(domState.loseContextCalls).toBe(0)
  })
})