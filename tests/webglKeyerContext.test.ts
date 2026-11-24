import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isKeyerAvailable, resetKeyerForTest } from '../src/editor/services/webglKeyer'

/**
 * webglKeyer 的上下文生命周期回归。
 *
 * 真实事故：`webglcontextlost` 时把 `state` 置空、`webglcontextrestored` 时也置空，
 * 于是恢复后下一次 `isKeyerAvailable()` 会**新建** canvas + 新 WebGL 上下文，
 * 而浏览器已经把**原来那个**上下文恢复可用了 —— 每次 GPU 复位都泄漏一个活跃上下文
 * （上限约 8–16 个，超了会开始回收**其它**画布的上下文 → 预览黑屏）。
 *
 * 这里锁住：
 * 1. 丢失期间不可用（退回原画面）、且不新建上下文；
 * 2. 恢复后**复用同一个** canvas/上下文（多次丢失-恢复也不增长）；
 * 3. 「拿不到上下文」这类瞬时失败按冷却重试，而不是整个会话永久禁用；
 * 4. 着色器编译失败仍然永久缓存（每帧重建上下文反而更糟）。
 */

interface FakeCanvas {
  width: number
  height: number
  listeners: Map<string, (event: unknown) => void>
  addEventListener: (type: string, handler: (event: unknown) => void) => void
  removeEventListener: () => void
  getContext: (type: string) => unknown
}

const dom = {
  canvases: 0,
  glContexts: 0,
  loseContextCalls: 0,
  glAvailable: false,
  shaderFails: false,
  lastCanvas: null as FakeCanvas | null,
}

function fakeGl(canvas: FakeCanvas): Record<string, unknown> {
  const obj = (): Record<string, unknown> => ({})
  return {
    canvas,
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    TEXTURE_2D: 8,
    RGBA: 9,
    UNSIGNED_BYTE: 10,
    TEXTURE_WRAP_S: 11,
    TEXTURE_WRAP_T: 12,
    CLAMP_TO_EDGE: 13,
    TEXTURE_MIN_FILTER: 14,
    TEXTURE_MAG_FILTER: 15,
    LINEAR: 16,
    TRIANGLE_STRIP: 17,
    TEXTURE0: 18,
    createShader: obj,
    shaderSource: () => undefined,
    compileShader: () => undefined,
    getShaderParameter: () => !dom.shaderFails,
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
    getUniformLocation: obj,
    createTexture: obj,
    bindTexture: () => undefined,
    texParameteri: () => undefined,
    deleteTexture: () => undefined,
    deleteBuffer: () => undefined,
    viewport: () => undefined,
    activeTexture: () => undefined,
    texImage2D: () => undefined,
    uniform1i: () => undefined,
    uniform1f: () => undefined,
    uniform2f: () => undefined,
    drawArrays: () => undefined,
    getExtension: (name: string) =>
      name === 'WEBGL_lose_context' && dom.glAvailable
        ? { loseContext: () => void (dom.loseContextCalls += 1) }
        : null,
  }
}

function makeCanvas(): FakeCanvas {
  dom.canvases += 1
  const canvas: FakeCanvas = {
    width: 0,
    height: 0,
    listeners: new Map(),
    addEventListener(type, handler) {
      canvas.listeners.set(type, handler)
    },
    removeEventListener() {},
    getContext(type: string) {
      if (type === '2d') {
        return { drawImage: () => undefined, clearRect: () => undefined, setTransform: () => undefined }
      }
      if (type === 'webgl') {
        if (!dom.glAvailable) return null
        dom.glContexts += 1
        return fakeGl(canvas)
      }
      return null
    },
  }
  dom.lastCanvas = canvas
  return canvas
}

function resetDom(options: { gl?: boolean; shaderFails?: boolean } = {}): void {
  // 顺序很重要：resetKeyerForTest() 会释放上一个用例遗留的上下文，而释放本身会调
  // WEBGL_lose_context.loseContext()。若先清零计数器再重置，这一次释放会被记到
  // 当前用例头上（断言 loseContextCalls === 0 就会假失败）。
  resetKeyerForTest()
  dom.canvases = 0
  dom.glContexts = 0
  dom.loseContextCalls = 0
  dom.glAvailable = options.gl ?? false
  dom.shaderFails = options.shaderFails ?? false
  dom.lastCanvas = null
  vi.stubGlobal('document', { createElement: () => makeCanvas() })
}

function fire(type: 'webglcontextlost' | 'webglcontextrestored'): void {
  const handler = dom.lastCanvas?.listeners.get(type)
  if (!handler) throw new Error(`没有挂 ${type} 监听`)
  handler({ preventDefault: () => undefined })
}

beforeEach(() => {
  resetDom({ gl: true })
})

describe('webglKeyer：上下文丢失与恢复', () => {
  it('成功路径挂上 contextlost/restored 监听，只建 1 个上下文', () => {
    expect(isKeyerAvailable()).toBe(true)
    expect(dom.canvases).toBe(1)
    expect(dom.glContexts).toBe(1)
    expect(dom.lastCanvas?.listeners.has('webglcontextlost')).toBe(true)
    expect(dom.lastCanvas?.listeners.has('webglcontextrestored')).toBe(true)
  })

  it('丢失期间不可用（退回原画面），且不新建上下文', () => {
    expect(isKeyerAvailable()).toBe(true)
    fire('webglcontextlost')
    expect(isKeyerAvailable()).toBe(false)
    // 每帧都会调用：丢失期间一次都不该再建 canvas/上下文。
    for (let index = 0; index < 10; index += 1) expect(isKeyerAvailable()).toBe(false)
    expect(dom.canvases).toBe(1)
    expect(dom.glContexts).toBe(1)
  })

  it('恢复后立刻可用，并复用同一个 canvas/上下文（不泄漏新上下文）', () => {
    expect(isKeyerAvailable()).toBe(true)
    fire('webglcontextlost')
    fire('webglcontextrestored')
    expect(isKeyerAvailable()).toBe(true)
    expect(dom.canvases).toBe(1)
    expect(dom.glContexts).toBe(1)
  })

  it('连续 3 次丢失-恢复也不新增上下文（原实现每次都新建）', () => {
    expect(isKeyerAvailable()).toBe(true)
    for (let round = 0; round < 3; round += 1) {
      fire('webglcontextlost')
      expect(isKeyerAvailable()).toBe(false)
      fire('webglcontextrestored')
      expect(isKeyerAvailable()).toBe(true)
    }
    expect(dom.canvases).toBe(1)
    expect(dom.glContexts).toBe(1)
    expect(dom.loseContextCalls).toBe(0)
  })
})

describe('webglKeyer：失败缓存语义', () => {
  it('着色器编译失败永久缓存：即使过了冷却也不重建', () => {
    resetDom({ gl: true, shaderFails: true })
    expect(isKeyerAvailable()).toBe(false)
    expect(dom.canvases).toBe(1)
    expect(dom.glContexts).toBe(1)
    expect(dom.loseContextCalls).toBe(1)

    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    for (let index = 0; index < 5; index += 1) expect(isKeyerAvailable()).toBe(false)
    expect(dom.canvases).toBe(1)
    expect(dom.glContexts).toBe(1)
  })

  it('拿不到上下文是瞬时失败：冷却期内不重试，冷却后允许再试一次', () => {
    resetDom({ gl: false })
    let now = 1_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)

    expect(isKeyerAvailable()).toBe(false)
    expect(dom.canvases).toBe(1)

    // 冷却期内（每帧调用）不再新建。
    for (let index = 0; index < 5; index += 1) expect(isKeyerAvailable()).toBe(false)
    expect(dom.canvases).toBe(1)

    // 过了冷却（> 3s）且上下文已可用 → 允许恢复，而不是整个会话永久禁用。
    now += 4_000
    dom.glAvailable = true
    clock.mockImplementation(() => now)
    expect(isKeyerAvailable()).toBe(true)
    expect(dom.canvases).toBe(2)
    expect(dom.glContexts).toBe(1)
  })
})