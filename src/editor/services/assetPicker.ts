/**
 * 一次性「选择本地文件」封装：保证 Promise **一定会 resolve**。
 *
 * 背景（真实 bug）：`<input type="file">` 被取消时浏览器不会触发 `change`，
 * 只监听 change 的 Promise 会永久挂起，导入流程随之卡死。这里同时监听：
 * - `change`：选到文件；
 * - `cancel`：用户点了取消（Chrome 113+ / Firefox 91+ / Safari 16.4+）；
 * - 窗口重新获得焦点的兜底：老浏览器没有 cancel 事件，延迟检查 files 是否为空。
 *
 * 另一个约束：调用 `input.click()` 必须发生在用户手势里。对话框里每个「选择文件」
 * 按钮由用户点击触发，就不会踩到「await 之后手势过期、选择框静默不打开」的问题。
 */

export interface PickFileOutcome {
  files: File[]
  cancelled: boolean
}

/** 只依赖 addEventListener/removeEventListener 的最小 input 接口（便于单测）。 */
export interface PickInputLike {
  files: ArrayLike<File> | null
  value: string
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void
}

export interface PickFocusTargetLike {
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void
}

/** 窗口重新聚焦后等待多久再检查 files（给 change 事件留出时间）。 */
export const PICK_CANCEL_FALLBACK_MS = 400

/**
 * cancel 之后的宽限期：个别环境（如自动化接管文件框的 Firefox）会先发 cancel、
 * 紧接着才发 change。真实用户取消后不会再有 change，因此等一小会儿再判定取消，
 * 既不会误伤「cancel 后马上 change」的时序，取消的体感也没有可感知的延迟。
 */
export const PICK_CANCEL_GRACE_MS = 250

export interface PickFilesOptions {
  /** 用于「焦点回来」兜底的 window；不传则不启用兜底。 */
  focusTarget?: PickFocusTargetLike | null
  /** 兜底延迟（毫秒），测试可调小。 */
  cancelFallbackDelay?: number
  /** cancel 后等待 change 的宽限期（毫秒）。 */
  cancelGraceMs?: number
}

/**
 * 等待用户在 input 上完成选择；取消时返回 `{ files: [], cancelled: true }`。
 * 监听器在 settle 时全部移除，重复事件不会二次 resolve。
 */
export function pickFilesWithCancel(
  input: PickInputLike,
  options: PickFilesOptions = {},
): Promise<PickFileOutcome> {
  const focusTarget = options.focusTarget ?? null
  const fallbackDelay = options.cancelFallbackDelay ?? PICK_CANCEL_FALLBACK_MS
  const cancelGrace = options.cancelGraceMs ?? PICK_CANCEL_GRACE_MS
  return new Promise<PickFileOutcome>((resolve) => {
    let settled = false
    let focusTimer: ReturnType<typeof setTimeout> | null = null
    let cancelTimer: ReturnType<typeof setTimeout> | null = null

    const cleanup = (): void => {
      input.removeEventListener('change', onInputChanged)
      input.removeEventListener('cancel', onInputCancelled)
      focusTarget?.removeEventListener('focus', onWindowFocus)
      if (focusTimer !== null) {
        clearTimeout(focusTimer)
        focusTimer = null
      }
      if (cancelTimer !== null) {
        clearTimeout(cancelTimer)
        cancelTimer = null
      }
    }

    const settle = (outcome: PickFileOutcome): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(outcome)
    }

    const onInputChanged = (): void => {
      if (settled) return
      // 先到的 cancel 可能是环境噪声（cancel 后紧跟 change）：change 优先。
      if (cancelTimer !== null) {
        clearTimeout(cancelTimer)
        cancelTimer = null
      }
      settle({ files: Array.from(input.files ?? []), cancelled: false })
    }

    const onInputCancelled = (): void => {
      if (settled || cancelTimer !== null) return
      cancelTimer = setTimeout(() => {
        cancelTimer = null
        settle({ files: [], cancelled: true })
      }, cancelGrace)
    }

    const onWindowFocus = (): void => {
      if (settled) return
      if (focusTimer !== null) clearTimeout(focusTimer)
      focusTimer = setTimeout(() => {
        focusTimer = null
        if (settled) return
        // 没有 change、也没有 cancel（老浏览器）：files 为空就当作取消。
        if (Array.from(input.files ?? []).length === 0) settle({ files: [], cancelled: true })
      }, fallbackDelay)
    }

    input.addEventListener('change', onInputChanged)
    input.addEventListener('cancel', onInputCancelled)
    focusTarget?.addEventListener('focus', onWindowFocus)
  })
}