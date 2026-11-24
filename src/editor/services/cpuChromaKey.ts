import { keyChromaImageData, type ChromaKey } from '../core/chromaKey'

let sharedCanvas: HTMLCanvasElement | null = null
let sharedContext: CanvasRenderingContext2D | null = null

/**
 * WebGL 不可用时的 CPU 抠像兜底。
 *
 * 返回一张已抠像、带 alpha 的画布；失败（CORS 污染 / 无 2D 上下文）返回 null，
 * 调用方继续退回原画面。1080p 下单帧是百万级像素循环，预览会明显变慢，
 * 所以只在 WebGL 不可用时启用；导出始终走 FFmpeg。
 */
export function cpuKeyFrame(
  source: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  width: number,
  height: number,
  key: ChromaKey,
): CanvasImageSource | null {
  if (typeof document === 'undefined') return null
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  try {
    if (!sharedCanvas) {
      sharedCanvas = document.createElement('canvas')
      sharedContext = sharedCanvas.getContext('2d', { willReadFrequently: true })
    }
    const canvas = sharedCanvas
    const context = sharedContext
    if (!canvas || !context) return null
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    context.clearRect(0, 0, w, h)
    context.drawImage(source, sx, sy, sw, sh, 0, 0, w, h)
    const image = context.getImageData(0, 0, w, h)
    keyChromaImageData(image.data, w, h, key)
    context.putImageData(image, 0, 0)
    return canvas
  } catch {
    return null
  }
}