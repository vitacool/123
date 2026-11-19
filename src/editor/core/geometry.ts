import { clamp } from './timeline'
import { SCALE_MAX, SCALE_MIN } from './constants'
import type { Clip, CropRect, SourceInfo } from './types'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface ClipGeometry {
  /** Source crop in video pixels, rounded and clamped for FFmpeg compatibility. */
  source: Rect
  /** Bounding box after crop + rotation. */
  rotated: { w: number; h: number }
  /** Drawn frame on the canvas, in canvas pixels. */
  rendered: Rect
  /** Visible sub-rect of the rendered frame and its canvas position. */
  visible: Rect
  /** The scale that fits the rotated frame in the canvas at clip.scale = 1. */
  fitScale: number
}

const evenFloor = (value: number): number => {
  const rounded = Math.max(2, Math.round(value))
  return Math.max(2, rounded % 2 === 0 ? rounded : rounded - 1)
}

export function sourceCropPixels(
  crop: CropRect,
  sourceW: number,
  sourceH: number,
): Rect {
  const width = Math.max(2, Math.round(sourceW))
  const height = Math.max(2, Math.round(sourceH))
  const x = clamp(Math.round(crop.x * width), 0, width - 2)
  const y = clamp(Math.round(crop.y * height), 0, height - 2)
  const w = clamp(evenFloor(crop.w * width), 2, width - x)
  const h = clamp(evenFloor(crop.h * height), 2, height - y)
  return { x, y, w: evenFloor(w), h: evenFloor(h) }
}

export function rotatedBounds(cw: number, ch: number, degrees: number): { w: number; h: number } {
  const radians = (degrees * Math.PI) / 180
  const cos = Math.abs(Math.cos(radians))
  const sin = Math.abs(Math.sin(radians))
  return {
    w: evenFloor(Math.ceil(cw * cos + ch * sin)),
    h: evenFloor(Math.ceil(cw * sin + ch * cos)),
  }
}

/**
 * Mirrors the Canvas preview and the FFmpeg graph:
 * source crop -> flips -> rotation -> contain-fit -> user scale/offset.
 */
export function computeClipGeometry(
  clip: Clip,
  source: Pick<SourceInfo, 'width' | 'height'>,
  canvasW: number,
  canvasH: number,
): ClipGeometry {
  const sourceRect = sourceCropPixels(clip.crop, source.width, source.height)
  const rotated = rotatedBounds(sourceRect.w, sourceRect.h, clip.rotation)
  const fitScale = Math.min(canvasW / rotated.w, canvasH / rotated.h)
  const scale = fitScale * clamp(clip.scale, SCALE_MIN, SCALE_MAX)
  const renderedW = Math.max(1, Math.round(rotated.w * scale))
  const renderedH = Math.max(1, Math.round(rotated.h * scale))
  const renderedX = Math.round(
    (canvasW - renderedW) / 2 + clamp(clip.position.x, -10, 10) * canvasW,
  )
  const renderedY = Math.round(
    (canvasH - renderedH) / 2 + clamp(clip.position.y, -10, 10) * canvasH,
  )

  const left = Math.max(0, -renderedX)
  const top = Math.max(0, -renderedY)
  const right = Math.min(renderedW, canvasW - renderedX)
  const bottom = Math.min(renderedH, canvasH - renderedY)

  return {
    source: sourceRect,
    rotated,
    rendered: { x: renderedX, y: renderedY, w: renderedW, h: renderedH },
    visible: {
      x: left,
      y: top,
      w: Math.max(0, right - left),
      h: Math.max(0, bottom - top),
    },
    fitScale,
  }
}

/** Scale value that covers the canvas with the current crop/rotation. */
export function fillScaleFor(
  clip: Pick<Clip, 'crop' | 'rotation'>,
  source: Pick<SourceInfo, 'width' | 'height'>,
  canvasAspect: number,
): number {
  const crop = sourceCropPixels(clip.crop, source.width, source.height)
  const rotated = rotatedBounds(crop.w, crop.h, clip.rotation)
  const canvasW = 1000
  const canvasH = canvasW / Math.max(0.01, canvasAspect)
  const contain = Math.min(canvasW / rotated.w, canvasH / rotated.h)
  const cover = Math.max(canvasW / rotated.w, canvasH / rotated.h)
  return clamp(cover / contain, 0.1, 4)
}

/** Fit source frame inside a canvas rect, used by the interactive crop editor. */
export function sourceFitRect(
  sourceW: number,
  sourceH: number,
  canvasW: number,
  canvasH: number,
): Rect {
  const scale = Math.min(canvasW / sourceW, canvasH / sourceH)
  const w = sourceW * scale
  const h = sourceH * scale
  return { x: (canvasW - w) / 2, y: (canvasH - h) / 2, w, h }
}

/**
 * The largest centered crop rectangle with the requested display aspect.
 * `sourceRatio` is width / height of the original frame.
 */
export function cropRectForAspect(
  sourceRatio: number,
  targetRatio: number | null,
): CropRect {
  if (targetRatio === null) return { x: 0, y: 0, w: 1, h: 1 }
  let w = 1
  let h = 1
  if (sourceRatio > targetRatio) {
    w = targetRatio / sourceRatio
  } else {
    h = sourceRatio / targetRatio
  }
  w = clamp(w, 0.02, 1)
  h = clamp(h, 0.02, 1)
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h }
}

export function cropAspectFromPixels(crop: CropRect, sourceW: number, sourceH: number): number {
  const pixelW = crop.w * sourceW
  const pixelH = crop.h * sourceH
  return pixelH <= 0 ? 1 : pixelW / pixelH
}

export type CropHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/**
 * Resizes a normalized crop rect from one of eight handles. When `targetRatio`
 * is set it is a *display* aspect; source dimensions are used to convert it to
 * normalized coordinates.
 */
export function resizeCropRect(
  start: CropRect,
  handle: CropHandle,
  dx: number,
  dy: number,
  targetRatio: number | null,
  sourceRatio: number,
  minSize = 0.04,
): CropRect {
  let x0 = start.x
  let y0 = start.y
  let x1 = start.x + start.w
  let y1 = start.y + start.h

  if (targetRatio === null) {
    if (handle.includes('w')) x0 = clamp(x0 + dx, 0, x1 - minSize)
    if (handle.includes('e')) x1 = clamp(x1 + dx, x0 + minSize, 1)
    if (handle.includes('n')) y0 = clamp(y0 + dy, 0, y1 - minSize)
    if (handle.includes('s')) y1 = clamp(y1 + dy, y0 + minSize, 1)
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  }

  // Locked aspect ratio. `normalizedRatio` is width / height in normalized
  // crop coordinates, so a display ratio of 16:9 on a 16:9 source is 1.
  const normalizedRatio = Math.max(0.02, targetRatio / Math.max(0.02, sourceRatio))
  const directionX = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0
  const directionY = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0
  const centerX = (start.x + start.x + start.w) / 2
  const centerY = (start.y + start.y + start.h) / 2
  const anchorX = directionX === 1 ? start.x : start.x + start.w
  const anchorY = directionY === 1 ? start.y : start.y + start.h

  let width = start.w
  let height = start.h

  if (directionX !== 0 && directionY !== 0) {
    const widthDelta = Math.max(0, start.w + directionX * dx)
    const heightDelta = Math.max(0, start.h + directionY * dy)
    if (Math.abs(dx) >= Math.abs(dy) * normalizedRatio) {
      width = widthDelta
      height = width / normalizedRatio
    } else {
      height = heightDelta
      width = height * normalizedRatio
    }
  } else if (directionX !== 0) {
    width = Math.max(0, start.w + directionX * dx)
    height = width / normalizedRatio
  } else {
    height = Math.max(0, start.h + directionY * dy)
    width = height * normalizedRatio
  }

  const availableWidth =
    directionX === 1
      ? 1 - start.x
      : directionX === -1
        ? start.x + start.w
        : 2 * Math.min(centerX, 1 - centerX)
  const availableHeight =
    directionY === 1
      ? 1 - start.y
      : directionY === -1
        ? start.y + start.h
        : 2 * Math.min(centerY, 1 - centerY)

  width = clamp(width, Math.min(minSize, availableWidth), availableWidth)
  height = width / normalizedRatio
  if (height > availableHeight) {
    height = availableHeight
    width = height * normalizedRatio
  }
  height = clamp(height, Math.min(minSize, availableHeight), availableHeight)
  width = height * normalizedRatio
  if (width > availableWidth) {
    width = availableWidth
    height = width / normalizedRatio
  }

  const nextX =
    directionX === 1
      ? anchorX
      : directionX === -1
        ? anchorX - width
        : clamp(centerX - width / 2, 0, 1 - width)
  const nextY =
    directionY === 1
      ? anchorY
      : directionY === -1
        ? anchorY - height
        : clamp(centerY - height / 2, 0, 1 - height)

  return {
    x: clamp(nextX, 0, 1 - width),
    y: clamp(nextY, 0, 1 - height),
    w: clamp(width, 0.02, 1),
    h: clamp(height, 0.02, 1),
  }
}