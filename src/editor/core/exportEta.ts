/**
 * 导出剩余时间的估算（纯函数，便于单测）。
 *
 * 为什么需要：FFmpeg.wasm 在浏览器里合成，1080p 大致是 4–5 倍实时 ——
 * 5 分钟的片子要 20 分钟以上。进度条虽然有百分比，但没有「还要多久」，
 * 用户很容易以为卡死了然后取消掉一个其实在正常推进的任务。
 *
 * 为什么不用「进度 × 总时长」反推：编码速度不是线性的（开头要准备、
 * 末尾要封装，中间才稳定），所以这里用**最近一段窗口的实际速率**外推。
 */

export interface ExportProgressSample {
  /** 采样时的墙钟毫秒（performance.now 或 Date.now，同一来源即可）。 */
  at: number
  /** 该时刻的进度（0–1）。 */
  progress: number
}

export interface EtaOptions {
  /** 只看最近这段时间内的样本（毫秒，默认 20 秒）。 */
  windowMs?: number
  /** 至少需要这么多个样本才给估计（默认 3）。 */
  minSamples?: number
  /** 估算上限（秒，默认 6 小时）：超过就不显示，免得给出荒谬数字。 */
  maxSeconds?: number
}

export const ETA_WINDOW_MS = 20_000
export const ETA_MIN_SAMPLES = 3
export const ETA_MAX_SECONDS = 6 * 60 * 60

/**
 * 估算「还要多久」（秒）。信息不足或进度没有推进时返回 null（调用方不显示）。
 */
export function estimateRemainingSeconds(
  samples: readonly ExportProgressSample[],
  now: number,
  options: EtaOptions = {},
): number | null {
  const windowMs = options.windowMs ?? ETA_WINDOW_MS
  const minSamples = options.minSamples ?? ETA_MIN_SAMPLES
  const maxSeconds = options.maxSeconds ?? ETA_MAX_SECONDS

  // 只保留窗口内的样本（而且必须在 now 之前）。
  const recent = samples.filter(
    (sample) => Number.isFinite(sample.at) && Number.isFinite(sample.progress) && sample.at <= now,
  )
  const cutoff = now - windowMs
  const windowed = recent.filter((sample) => sample.at >= cutoff)
  if (windowed.length < minSamples) return null

  const first = windowed[0]
  const last = windowed[windowed.length - 1]
  const elapsedMs = last.at - first.at
  const advance = last.progress - first.progress
  // 时间没走够 / 进度没推进（例如正在等 seek、正在封装）→ 不给估计。
  if (elapsedMs < 1000) return null
  if (advance <= 0.0005) return null

  const perMs = advance / elapsedMs
  const remainingProgress = 1 - last.progress
  if (remainingProgress <= 0) return 0

  const seconds = remainingProgress / perMs / 1000
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  if (seconds > maxSeconds) return null
  return Math.round(seconds)
}

/** 把秒数格式化成「约 X 分 Y 秒」/「约 X 秒」（不足 1 分钟时）。 */
export function formatEta(seconds: number): string {
  const total = Math.max(1, Math.round(seconds))
  if (total < 60) return `约 ${total} 秒`
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  if (minutes < 60) return rest === 0 ? `约 ${minutes} 分钟` : `约 ${minutes} 分 ${rest} 秒`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes === 0 ? `约 ${hours} 小时` : `约 ${hours} 小时 ${restMinutes} 分`
}