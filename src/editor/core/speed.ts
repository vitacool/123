import { clipTimelineDuration } from './clipTime'
import type { Clip, Project } from './types'

/** 变速范围与默认值。 */
export const SPEED_MIN = 0.1
export const SPEED_MAX = 10
export const DEFAULT_SPEED = 1
/** 常用档位。 */
export const SPEED_PRESETS = [0.5, 1, 1.5, 2, 3] as const

/** 把倍率夹到允许范围；非法值回退 1。 */
export function clampSpeed(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_SPEED
  return Math.max(SPEED_MIN, Math.min(SPEED_MAX, value))
}

/** 片段倍率（缺省 1）。 */
export function clipSpeedValue(clip: Pick<Clip, 'speed'>): number {
  return clampSpeed(clip.speed ?? DEFAULT_SPEED)
}

/** 是否保持音调（缺省 true）。 */
export function clipKeepsPitch(clip: Pick<Clip, 'keepPitch'>): boolean {
  return clip.keepPitch !== false
}

/** 变速后的时间轴时长（源跨度 / 倍率）。 */
export function speedAdjustedDuration(clip: Clip): number {
  return clipTimelineDuration(clip)
}

/**
 * 生成 FFmpeg `atempo` 链：单级只支持 0.5–2，超出时拆成多级连乘。
 * 例：4x → atempo=2,atempo=2；0.25x → atempo=0.5,atempo=0.5。
 */
export function atempoChain(speed: number): string[] {
  const target = clampSpeed(speed)
  const filters: string[] = []
  if (Math.abs(target - 1) < 1e-6) return filters
  let remaining = target
  // 大于 2 时逐级折半，小于 0.5 时逐级翻倍。
  while (remaining > 2 + 1e-9) {
    filters.push('atempo=2')
    remaining /= 2
  }
  while (remaining < 0.5 - 1e-9) {
    filters.push('atempo=0.5')
    remaining /= 0.5
  }
  filters.push(`atempo=${Number(remaining.toFixed(6))}`)
  return filters
}

/**
 * keepPitch=false 时的音频变速：asetrate 改变采样率实现「改变音调」的变速，
 * 后面用 aresample 回到 48k。
 */
export function asetrateChain(speed: number, sampleRate = 48000): string[] {
  const target = clampSpeed(speed)
  if (Math.abs(target - 1) < 1e-6) return []
  return [`asetrate=${Math.round(sampleRate * target)}`, `aresample=${sampleRate}`]
}

/** 按 keepPitch 选择音频变速滤镜链。 */
export function speedAudioFilters(speed: number, keepPitch: boolean, sampleRate = 48000): string[] {
  return keepPitch ? atempoChain(speed) : asetrateChain(speed, sampleRate)
}

/** 视频变速滤镜：PTS 除以倍率（>1 变快、<1 变慢）。 */
export function speedVideoFilter(speed: number): string | null {
  const target = clampSpeed(speed)
  if (Math.abs(target - 1) < 1e-6) return null
  return `setpts=PTS/${Number(target.toFixed(6))}`
}

/** 浏览器 `HTMLMediaElement.playbackRate` 的规格支持区间。 */
export const PLAYBACK_RATE_MIN = 0.0625
export const PLAYBACK_RATE_MAX = 16

/**
 * 把倍率收敛到浏览器实际支持的播放速率区间。
 * 独立于 SPEED_MIN/MAX 判断（否则 0.01 会先被抬到 0.1，永远检不出越界）；
 * `clamped` 为 true 表示视图速率被钳制，供上层提示。
 */
export function clampPlaybackRate(speed: number): { rate: number; clamped: boolean } {
  const raw = typeof speed === 'number' && Number.isFinite(speed) && speed > 0 ? speed : 1
  if (raw < PLAYBACK_RATE_MIN) return { rate: PLAYBACK_RATE_MIN, clamped: true }
  if (raw > PLAYBACK_RATE_MAX) return { rate: PLAYBACK_RATE_MAX, clamped: true }
  return { rate: raw, clamped: false }
}

/** 该片段是否允许变速（定格与图片是静帧，没有可变速的播放行为）。 */
export function canChangeClipSpeed(clip: { type?: Clip['type'] }): boolean {
  return clip.type !== 'freeze' && clip.type !== 'image'
}

/**
 * 实时预览：返回一个「只改目标片段倍率」的新工程，用于时间轴/预览的拖动反馈。
 * 纯函数、不改原对象、不进撤销栈（由 store 的 previewPatch 承担）。
 */
export function applySpeedPreview(project: Project, clipId: string, speed: number): Project {
  const target = clampSpeed(speed)
  const patch = (clip: Clip): Clip => (clip.id === clipId ? { ...clip, speed: target } : clip)
  const touchedMain = project.clips.some((clip) => clip.id === clipId)
  const touchedOverlay = (project.overlayTracks ?? []).some((track) =>
    track.clips.some((clip) => clip.id === clipId),
  )
  if (!touchedMain && !touchedOverlay) return project
  return {
    ...project,
    clips: touchedMain ? project.clips.map(patch) : project.clips,
    overlayTracks: touchedOverlay
      ? (project.overlayTracks ?? []).map((track) => ({
          ...track,
          clips: track.clips.map(patch),
        }))
      : project.overlayTracks,
  }
}