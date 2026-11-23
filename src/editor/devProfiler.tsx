import { Profiler, type ReactNode, type ProfilerOnRenderCallback } from 'react'

/**
 * 播放性能基线/回归的测量钩子（**仅开发环境**，且只在 `?profile=1` 时启用）。
 *
 * 为什么不直接读 React DevTools：生产构建里没有 devtools 钩子，而 `React.Profiler`
 * 在 dev 构建里可用，正好够做「优化前后对比」这种一次性测量。它不参与生产路径：
 * 未带参数时 `withPlaybackProfiler()` 直接返回原节点，零开销。
 */

export interface PlaybackProfileTotals {
  /** 提交（commit）次数。 */
  commits: number
  /** 所有提交的 actualDuration 之和（ms）。 */
  totalActualDuration: number
  /** 所有提交的 baseDuration 之和（ms）。 */
  totalBaseDuration: number
  /** 单次提交最大 actualDuration（ms）。 */
  maxActualDuration: number
  /** 最后一次提交的时刻（performance.now）。 */
  lastCommitAt: number
  /** 本次测量窗口的起始时刻。 */
  startedAt: number
}

declare global {
  interface Window {
    __fcProfiler?: PlaybackProfileTotals & { reset: () => void }
  }
}

/** 是否处于「测量模式」（`?profile=1`，且为 dev 构建）。 */
export function isProfilingEnabled(): boolean {
  if (!import.meta.env.DEV) return false
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).has('profile')
}

function ensureTotals(): PlaybackProfileTotals & { reset: () => void } {
  const existing = window.__fcProfiler
  if (existing) return existing
  const totals: PlaybackProfileTotals & { reset: () => void } = {
    commits: 0,
    totalActualDuration: 0,
    totalBaseDuration: 0,
    maxActualDuration: 0,
    lastCommitAt: 0,
    startedAt: performance.now(),
    reset: () => {
      totals.commits = 0
      totals.totalActualDuration = 0
      totals.totalBaseDuration = 0
      totals.maxActualDuration = 0
      totals.lastCommitAt = 0
      totals.startedAt = performance.now()
    },
  }
  window.__fcProfiler = totals
  return totals
}

const onRender: ProfilerOnRenderCallback = (
  _id,
  _phase,
  actualDuration,
  baseDuration,
) => {
  const totals = ensureTotals()
  totals.commits += 1
  totals.totalActualDuration += actualDuration
  totals.totalBaseDuration += baseDuration
  if (actualDuration > totals.maxActualDuration) totals.maxActualDuration = actualDuration
  totals.lastCommitAt = performance.now()
}

/** 包一层 Profiler（仅在测量模式下，否则原样返回）。 */
export function withPlaybackProfiler(node: ReactNode): ReactNode {
  if (!isProfilingEnabled()) return node
  ensureTotals()
  return (
    <Profiler id="framecut-editor" onRender={onRender}>
      {node}
    </Profiler>
  )
}