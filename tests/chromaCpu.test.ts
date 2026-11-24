import { describe, expect, it } from 'vitest'
import { CHROMA_KEY_DEFAULTS, keyChromaImageData } from '../src/editor/core/chromaKey'

function pixels(rows: [number, number, number][]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(rows.length * 4)
  rows.forEach((rgb, index) => {
    data[index * 4] = rgb[0]
    data[index * 4 + 1] = rgb[1]
    data[index * 4 + 2] = rgb[2]
    data[index * 4 + 3] = 255
  })
  return data
}

describe('keyChromaImageData（CPU 抠像兜底）', () => {
  it('纯绿被抠成透明，非绿保留', () => {
    const data = pixels([
      [0, 255, 0],
      [255, 0, 0],
    ])
    keyChromaImageData(data, 2, 1, { ...CHROMA_KEY_DEFAULTS, similarity: 0.1, blend: 0.05 })
    expect(data[3]).toBe(0)
    expect(data[7]).toBe(255)
  })

  it('despill 会压低绿色分量', () => {
    const data = pixels([[100, 220, 100]])
    keyChromaImageData(data, 1, 1, {
      ...CHROMA_KEY_DEFAULTS,
      similarity: 0.01,
      blend: 0.05,
      spill: 1,
    })
    expect(data[1]).toBeLessThan(220)
    expect(data[0]).toBe(100)
  })

  it('长度不足/尺寸非法时不越界', () => {
    const data = new Uint8ClampedArray(4)
    expect(() => keyChromaImageData(data, 10, 10, CHROMA_KEY_DEFAULTS)).not.toThrow()
    expect(() => keyChromaImageData(data, 0, 0, CHROMA_KEY_DEFAULTS)).not.toThrow()
  })
})