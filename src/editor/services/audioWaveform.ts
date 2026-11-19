import type { SourceInfo } from '../core/types'

export interface AudioPeaks {
  peaks: Float32Array
  duration: number
}

const BUCKETS = 600
const MAX_CACHE = 16
const cache = new Map<string, Promise<AudioPeaks>>()

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
    const peaks = new Float32Array(BUCKETS)
    const step = Math.max(1, Math.floor(channel.length / BUCKETS))
    for (let bucket = 0; bucket < BUCKETS; bucket += 1) {
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