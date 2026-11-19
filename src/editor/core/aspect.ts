import { EMPTY_PROJECT_ASPECT } from './constants'
import type { AspectRatioPreset, ExportFps, ExportResolution, Project, SourceInfo } from './types'

const RATIOS: Record<Exclude<AspectRatioPreset, 'original'>, number> = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1:1': 1,
  '4:3': 4 / 3,
  '3:4': 3 / 4,
}

export function aspectValue(preset: AspectRatioPreset, source?: Pick<SourceInfo, 'width' | 'height'> | null): number {
  if (preset === 'original') {
    if (source && source.width > 0 && source.height > 0) return source.width / source.height
    return EMPTY_PROJECT_ASPECT
  }
  return RATIOS[preset]
}

export function aspectLabel(preset: AspectRatioPreset): string {
  return preset === 'original' ? '原始' : preset
}

const QUALITY_SHORT_SIDE: Record<ExportResolution, number> = {
  '480p': 480,
  '720p': 720,
  '1080p': 1080,
  '4K': 2160,
}

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2)

/**
 * Computes an even-sized output frame for the selected canvas and quality,
 * capped by the source pixel dimensions so an export never upscales.
 */
export function getOutputDimensions(
  aspect: AspectRatioPreset,
  quality: ExportResolution,
  source: Pick<SourceInfo, 'width' | 'height'>,
): { width: number; height: number } {
  const ratio = aspectValue(aspect, source)
  const shortSide = QUALITY_SHORT_SIDE[quality]
  let width: number
  let height: number
  if (ratio >= 1) {
    height = shortSide
    width = even(height * ratio)
  } else {
    width = shortSide
    height = even(width / ratio)
  }

  const sourceW = Math.max(2, source.width)
  const sourceH = Math.max(2, source.height)
  const cap = Math.min(1, sourceW / width, sourceH / height)
  width = even(width * cap)
  height = even(height * cap)
  return { width, height }
}

export function qualitySummary(resolution: ExportResolution, fps: ExportFps): string {
  return `${resolution} · ${fps} fps`
}

export function createDefaultExportQuality(): Project['exportQuality'] {
  return { resolution: '1080p', fps: 30 }
}