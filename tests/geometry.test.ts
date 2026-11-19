import { describe, expect, it } from 'vitest'
import {
  cropAspectFromPixels,
  cropRectForAspect,
  fillScaleFor,
  resizeCropRect,
  rotatedBounds,
  sourceCropPixels,
} from '../src/editor/core/geometry'
import { aspectValue } from '../src/editor/core/aspect'

const SOURCE_RATIO = 16 / 9

describe('crop presets & handles', () => {
  it('centers the largest crop with the requested display aspect', () => {
    const crop = cropRectForAspect(SOURCE_RATIO, 9 / 16)
    expect(crop.h).toBe(1)
    expect(crop.y).toBe(0)
    expect(crop.x + crop.w / 2).toBeCloseTo(0.5, 6)
    const displayAspect = (crop.w * 16) / (crop.h * 9)
    expect(displayAspect).toBeCloseTo(9 / 16, 6)
  })

  it('keeps the display aspect locked while dragging a side handle inward', () => {
    const start = cropRectForAspect(SOURCE_RATIO, 9 / 16)
    const next = resizeCropRect(start, 'e', -0.05, 0, 9 / 16, SOURCE_RATIO)
    const displayAspect = (next.w * 16) / (next.h * 9)
    expect(displayAspect).toBeCloseTo(9 / 16, 5)
    expect(next.w).toBeLessThan(start.w)
    expect(next.h).toBeLessThan(start.h)
    expect(next.x).toBeCloseTo(start.x, 6)
    expect(next.y + next.h / 2).toBeCloseTo(0.5, 6)
  })

  it('keeps the display aspect locked for corner handles', () => {
    const start = cropRectForAspect(SOURCE_RATIO, 1)
    const next = resizeCropRect(start, 'se', -0.03, -0.04, 1, SOURCE_RATIO)
    const displayAspect = (next.w * 16) / (next.h * 9)
    expect(displayAspect).toBeCloseTo(1, 5)
    expect(next.x).toBeCloseTo(start.x, 6)
    expect(next.y).toBeCloseTo(start.y, 6)
    expect(next.w).toBeLessThan(start.w)
    expect(next.h).toBeLessThan(start.h)
  })

  it('never escapes the source bounds when dragging outward', () => {
    const start = cropRectForAspect(SOURCE_RATIO, 1)
    for (const handle of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const) {
      const next = resizeCropRect(start, handle, 0.4, 0.4, 1, SOURCE_RATIO)
      expect(next.x).toBeGreaterThanOrEqual(0)
      expect(next.y).toBeGreaterThanOrEqual(0)
      expect(next.x + next.w).toBeLessThanOrEqual(1.0000001)
      expect(next.y + next.h).toBeLessThanOrEqual(1.0000001)
      const displayAspect = (next.w * 16) / (next.h * 9)
      expect(displayAspect).toBeCloseTo(1, 4)
    }
  })

  it('resizes freely when no ratio is requested', () => {
    const start = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }
    const next = resizeCropRect(start, 'se', 0.1, 0.05, null, SOURCE_RATIO)
    expect(next.x).toBeCloseTo(0.1, 6)
    expect(next.y).toBeCloseTo(0.1, 6)
    expect(next.w).toBeCloseTo(0.6, 6)
    expect(next.h).toBeCloseTo(0.55, 6)
  })

  it('converts normalized crop to even source pixels', () => {
    const pixels = sourceCropPixels({ x: 0.1, y: 0.1, w: 0.333, h: 0.333 }, 1920, 1080)
    expect(pixels.w % 2).toBe(0)
    expect(pixels.h % 2).toBe(0)
    expect(pixels.x + pixels.w).toBeLessThanOrEqual(1920)
    expect(pixels.y + pixels.h).toBeLessThanOrEqual(1080)
  })

  it('reports display aspect from source pixels', () => {
    expect(cropAspectFromPixels({ x: 0, y: 0, w: 0.5, h: 1 }, 1600, 900)).toBeCloseTo(0.888888, 5)
  })
})

describe('rotation & fill', () => {
  it('computes even rotated bounds for quarter turns', () => {
    expect(rotatedBounds(100, 50, 90)).toEqual({ w: 50, h: 100 })
    expect(rotatedBounds(100, 50, 45)).toEqual({ w: 106, h: 106 })
  })

  it('fills a 16:9 canvas with a portrait crop', () => {
    const source = { width: 1920, height: 1080 }
    const fill = fillScaleFor(
      { crop: { x: 0.3, y: 0, w: 0.3, h: 1 }, rotation: 0 },
      source,
      aspectValue('16:9', source),
    )
    expect(fill).toBeGreaterThan(1)
    expect(fill).toBeLessThanOrEqual(4)
  })
})