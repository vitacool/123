/**
 * 预览音量 > 100%：用 Web Audio 的 MediaElementAudioSourceNode + GainNode。
 *
 * `HTMLMediaElement.volume` 的合法范围只有 0–1，片段音量 / 轨道音量乘起来超过 1 时
 * 直接写 `element.volume` 会被截断（预览听不出和 100% 的差别，导出却是 2 倍）。
 * 这里把需要放大的元素接进 Web Audio 图，用 GainNode 承载 >1 的增益。
 *
 * 约束与处理：
 * - 每个 media 元素**只能** createMediaElementSource 一次（第二次会抛错），用 WeakMap
 *   按元素缓存；一旦接管就长期由 GainNode 控制，不再回写 element.volume。
 * - AudioContext 受自动播放策略限制：懒创建，`resume()` 只在用户手势里调用；
 *   另外接管时也会尝试 resume（此时通常已经在播放手势之后）。
 * - 跨域且没有 CORS 的媒体接管后会静音：只对 blob:/data:/同源 URL 接管，
 *   其余退回原生音量（最多 100%），不破坏声音。
 * - 浏览器不支持 Web Audio 或接管失败：退回原生音量，不抛错。
 */

export interface GainParamLike {
  value: number
}

export interface GainNodeLike {
  gain: GainParamLike
  connect(target: unknown): unknown
}

export interface MediaSourceNodeLike {
  connect(target: unknown): unknown
}

export interface PreviewAudioContextLike {
  state: string
  destination: unknown
  createMediaElementSource(element: HTMLMediaElement): MediaSourceNodeLike
  createGain(): GainNodeLike
  resume(): Promise<void>
  close(): Promise<void>
}

export interface PreviewGainOptions {
  /** 注入 AudioContext 工厂（测试用）；返回 null 表示不支持 Web Audio。 */
  createContext?: () => PreviewAudioContextLike | null
}

/** 判断元素能否安全接管（跨域无 CORS 的媒体接管后会变静音）。 */
function isRoutableElement(element: HTMLMediaElement): boolean {
  const src = element.currentSrc || element.src
  if (!src) return false
  if (src.startsWith('blob:') || src.startsWith('data:')) return true
  if (typeof window === 'undefined') return false
  try {
    return new URL(src, window.location.href).origin === window.location.origin
  } catch {
    return false
  }
}

export function defaultPreviewAudioContext(): PreviewAudioContextLike | null {
  if (typeof window === 'undefined') return null
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  return new Ctor() as unknown as PreviewAudioContextLike
}

export class PreviewGainController {
  private context: PreviewAudioContextLike | null = null
  private contextChecked = false
  private routed = new WeakMap<HTMLMediaElement, GainNodeLike>()
  /** 接管失败过（跨域 / 浏览器限制）的元素：不要再反复尝试。 */
  private unroutable = new WeakSet<HTMLMediaElement>()
  private readonly createContext: () => PreviewAudioContextLike | null

  constructor(options: PreviewGainOptions = {}) {
    this.createContext = options.createContext ?? defaultPreviewAudioContext
  }

  /** 当前是否已经接管了某个元素（测试/调试用）。 */
  isRouted(element: HTMLMediaElement): boolean {
    return this.routed.has(element)
  }

  /**
   * 应用音量。>1 的增益会接管到 GainNode；<=1 且尚未接管的元素沿用原生 volume。
   * 传入 0 表示静音（接管后写 gain=0，未接管时写 muted=true）。
   */
  setGain(element: HTMLMediaElement, gain: number): void {
    const value = Number.isFinite(gain) ? Math.max(0, gain) : 1
    const node = this.routed.get(element)
    if (node) {
      // 接管后声音只由 GainNode 决定，避免 element.muted/volume 在某些浏览器被忽略。
      element.muted = false
      element.volume = 1
      node.gain.value = value
      return
    }
    if (value <= 1 + 1e-6) {
      element.volume = Math.min(1, value)
      element.muted = value <= 0.001
      return
    }
    const created = this.route(element)
    if (!created) {
      // 无法放大：退回到 100%，至少保持可听（不要静音）。
      element.volume = 1
      element.muted = false
      return
    }
    element.muted = false
    element.volume = 1
    created.gain.value = value
  }

  /** 用户手势里调用，解除 AudioContext 的自动播放挂起。 */
  resume(): void {
    const context = this.context
    if (!context || context.state !== 'suspended') return
    void context.resume().catch(() => undefined)
  }

  dispose(): void {
    const context = this.context
    this.context = null
    this.contextChecked = false
    this.routed = new WeakMap()
    this.unroutable = new WeakSet()
    if (context) void context.close().catch(() => undefined)
  }

  private route(element: HTMLMediaElement): GainNodeLike | null {
    if (this.unroutable.has(element)) return null
    if (!isRoutableElement(element)) {
      this.unroutable.add(element)
      return null
    }
    const context = this.ensureContext()
    if (!context) {
      this.unroutable.add(element)
      return null
    }
    try {
      const source = context.createMediaElementSource(element)
      const gainNode = context.createGain()
      source.connect(gainNode)
      gainNode.connect(context.destination)
      this.routed.set(element, gainNode)
      this.resume()
      return gainNode
    } catch {
      // 已经创建过 source node（别处接管 / 重复调用）或浏览器拒绝：退回原生音量。
      this.unroutable.add(element)
      return null
    }
  }

  private ensureContext(): PreviewAudioContextLike | null {
    if (this.contextChecked) return this.context
    this.contextChecked = true
    try {
      this.context = this.createContext()
    } catch {
      this.context = null
    }
    return this.context
  }
}

/** 全局单例：Preview 的各个 media 元素共用同一个 AudioContext。 */
export const previewGain = new PreviewGainController()