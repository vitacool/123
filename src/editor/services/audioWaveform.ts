import type { SourceInfo } from '../core/types'

export interface AudioPeaks {
  peaks: Float32Array
  duration: number
}

/**
 * 把一段源区间的峰值采样成 `columns` 个 0…1 的振幅，供音频/视频片段画波形。
 * 与具体画布尺寸无关，便于单测；区间非法（end <= start）时返回全 0。
 */
export function samplePeakRange(
  peaks: AudioPeaks,
  start: number,
  end: number,
  columns: number,
): number[] {
  const count = Math.max(1, Math.floor(columns))
  const total = peaks.peaks.length
  if (total === 0 || peaks.duration <= 0 || end <= start) {
    return new Array<number>(count).fill(0)
  }
  const clampRatio = (seconds: number): number =>
    Math.min(1, Math.max(0, seconds / peaks.duration))
  const from = clampRatio(start)
  const to = clampRatio(end)
  const values: number[] = []
  for (let index = 0; index < count; index += 1) {
    const ratio =
      count === 1 ? from : from + ((to - from) * index) / (count - 1)
    const peakIndex = Math.min(
      total - 1,
      Math.max(0, Math.round(ratio * (total - 1))),
    )
    const value = peaks.peaks[peakIndex] ?? 0
    values.push(Math.min(1, Math.max(0, value)))
  }
  return values
}

const MAX_CACHE = 16
const cache = new Map<string, Promise<AudioPeaks>>()

/**
 * 峰值桶数：固定 600 桶时，1 小时素材每桶约 6 秒，10 秒片段只落在 1–2 个桶里，
 * 波形就是一条平线。改为按「约 40 桶/秒」给分辨率，上限 12 万桶（约 480KB），
 * 长素材也能画出片段级细节；短素材仍至少 600 桶。
 */
export function peakBucketsForDuration(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 600
  return Math.min(120_000, Math.max(600, Math.round(duration * 40)))
}

/** Decodes duration through Web Audio when the media element cannot. */
export async function decodeAudioDuration(file: File): Promise<number> {
  const data = await file.arrayBuffer()
  const AudioContextClass =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextClass) throw new Error('浏览器不支持 Web Audio。')
  const context = new AudioContextClass()
  try {
    const decoded = await context.decodeAudioData(data.slice(0))
    return decoded.duration
  } finally {
    void context.close().catch(() => undefined)
  }
}

export function getAudioPeaks(asset: SourceInfo): Promise<AudioPeaks> {
  const cached = cache.get(asset.url)
  if (cached) return cached
  while (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value
    if (!oldest) break
    cache.delete(oldest)
  }
  const pending = buildPeaks(asset)
  cache.set(asset.url, pending)
  pending.catch(() => {
    if (cache.get(asset.url) === pending) cache.delete(asset.url)
  })
  return pending
}

async function buildPeaks(asset: SourceInfo): Promise<AudioPeaks> {
  const data = asset.file
    ? await asset.file.arrayBuffer()
    : await (await fetch(asset.url)).arrayBuffer()
  const AudioContextClass =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextClass) throw new Error('浏览器不支持 Web Audio。')
  const context = new AudioContextClass()
  try {
    const decoded = await context.decodeAudioData(data.slice(0))
    const channel = decoded.getChannelData(0)
    const buckets = peakBucketsForDuration(decoded.duration)
    const peaks = new Float32Array(buckets)
    const step = Math.max(1, Math.floor(channel.length / buckets))
    for (let bucket = 0; bucket < buckets; bucket += 1) {
      let max = 0
      const start = bucket * step
      const end = Math.min(channel.length, start + step)
      for (let index = start; index < end; index += 1) {
        const value = Math.abs(channel[index])
        if (value > max) max = value
      }
      peaks[bucket] = max
    }
    return { peaks, duration: decoded.duration }
  } finally {
    void context.close().catch(() => undefined)
  }
}