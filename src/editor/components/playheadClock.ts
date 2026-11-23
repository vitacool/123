/**
 * 播放头的**高频**通道：播放时每帧发布一次时间，订阅者直接改 DOM，
 * 不经过 React 渲染。
 *
 * 为什么需要它：原来 Preview 的 rAF 每帧 `setPlayhead(time)`，而 Timeline（2205 行）、
 * MediaLibrary、Toolbar 都订阅了 `playhead`，于是播放时整棵树每秒重渲染约 60 次
 * （实测 59.9 commit/s、1.87 ms/commit）。播放头位置本质上是「一个 CSS 值」，
 * 让它走 DOM 就能把 60 次/秒的 React 提交压到只有必要的低频提交。
 *
 * 约定：
 * - {@link publishPlayheadTime} 只在播放中由 Preview 的 rAF 调用；
 * - 订阅者必须自己**廉价**地更新 DOM（改 transform/left、写文本），不要在里面 setState；
 * - 需要低频 UI 更新（例如时间码 10Hz）的组件自己做节流；
 * - store 里的 `playhead` 仍然存在（低频同步，见 Preview 的 10Hz 提交），
 *   这样按钮可用性、导出区间等逻辑读到的值依然接近真实播放位置。
 */

export type PlayheadListener = (time: number) => void

const listeners = new Set<PlayheadListener>()

/** 订阅每帧播放头时间，返回取消订阅函数。 */
export function subscribePlayheadTime(listener: PlayheadListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 播放中每帧调用（Preview 的 rAF tick）。 */
export function publishPlayheadTime(time: number): void {
  for (const listener of listeners) {
    try {
      listener(time)
    } catch {
      // 单个订阅者出错不能影响播放循环。
    }
  }
}

/** 订阅者数量（测试用）。 */
export function playheadListenerCount(): number {
  return listeners.size
}

/** 以固定频率转发播放头时间（用于时间码这类需要节流的 UI）。 */
export function subscribePlayheadTimeThrottled(
  listener: PlayheadListener,
  hz = 10,
): () => void {
  const interval = Math.max(1, 1000 / Math.max(1, hz))
  let lastEmittedAt = 0
  let pending = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = (): void => {
    timer = null
    lastEmittedAt = performance.now()
    listener(pending)
  }

  const unsubscribe = subscribePlayheadTime((time) => {
    pending = time
    const now = performance.now()
    if (now - lastEmittedAt >= interval) {
      listener(time)
      lastEmittedAt = now
      return
    }
    // 低频组件：把最新值攒到下一个节流点，避免丢尾部。
    if (timer === null) {
      timer = setTimeout(flush, interval - (now - lastEmittedAt))
    }
  })

  return () => {
    unsubscribe()
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
}