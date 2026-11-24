import type { ExportFps, SourceInfo } from './types'

export function formatPlayhead(seconds: number, fps: ExportFps = 30): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  const whole = Math.floor(safe)
  const frames = Math.min(fps - 1, Math.floor((safe - whole) * fps + 1e-6))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const secs = whole % 60
  const pad = (value: number) => value.toString().padStart(2, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}:${pad(frames)}`
}

export function formatClock(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  const minutes = Math.floor(safe / 60)
  const secs = Math.floor(safe % 60)
  return `${minutes}:${secs.toString().padStart(2, '0')}`
}

/** 顶栏「已保存 HH:MM」用的本地时钟；非法/空值返回空串。 */
export function formatSavedAt(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return ''
  const date = new Date(at)
  const hh = date.getHours().toString().padStart(2, '0')
  const mm = date.getMinutes().toString().padStart(2, '0')
  return `${hh}:${mm}`
}

export function formatRulerTime(seconds: number, step: number): string {
  const total = Math.max(0, seconds)
  if (step < 1) {
    return `${Math.floor(total / 60)}:${(total % 60).toFixed(1).padStart(4, '0')}`
  }
  const minutes = Math.floor(total / 60)
  const secs = Math.floor(total % 60)
  return `${minutes}:${secs.toString().padStart(2, '0')}`
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export function secondsFromSource(source: Pick<SourceInfo, 'duration'>): number {
  return Number.isFinite(source.duration) ? Math.max(0, source.duration) : 0
}

/** Choose a readable ruler interval from zoom (pixels per second). */
export function getRulerStep(pixelsPerSecond: number): number {
  const candidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]
  const minPixels = 64
  return candidates.find((step) => step * pixelsPerSecond >= minPixels) ?? 600
}