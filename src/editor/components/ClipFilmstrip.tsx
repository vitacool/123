import { useEffect, useRef, useState } from 'react'
import type { Clip, SourceInfo } from '../core/types'
import { getClipFrames, type ClipFrames } from '../services/filmstrip'

interface ClipFilmstripProps {
  clip: Clip
  asset: SourceInfo
  /** Rendered width of the clip bar in CSS pixels. */
  width: number
}

const TILE_CSS_WIDTH = 64
const CLIP_HEIGHT = 62

/**
 * Paints a filmstrip for one clip: each tile asks the cached asset sprite for
 * the frame at that timeline position, so a trimmed clip shows its own range
 * instead of one repeated poster frame.
 */
export function ClipFilmstrip({ clip, asset, width }: ClipFilmstripProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [frames, setFrames] = useState<ClipFrames | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer = 0
    setFrames(null)

    const load = (attempt: number) => {
      void getClipFrames(asset, clip.sourceStart, clip.sourceEnd).then(
        (result) => {
          if (!cancelled) setFrames(result)
        },
        (error: unknown) => {
          if (cancelled) return
          if (attempt < 1) {
            timer = window.setTimeout(() => load(attempt + 1), 1200)
            return
          }
          console.warn(`[FrameCut] 无法生成胶片条：${asset.name}`, error)
        },
      )
    }
    load(0)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [asset.url, asset.name, clip.sourceStart, clip.sourceEnd])

  useEffect(() => {
    let raf = 0
    const paint = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const cssWidth = Math.max(4, width)
      const measuredHeight = canvas.getBoundingClientRect().height
      const cssHeight = measuredHeight > 0 ? measuredHeight : CLIP_HEIGHT
      const pixelWidth = Math.min(16384, Math.max(4, Math.round(cssWidth * ratio)))
      const pixelHeight = Math.max(2, Math.round(cssHeight * ratio))
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight
      const context = canvas.getContext('2d')
      if (!context) return
      context.clearRect(0, 0, pixelWidth, pixelHeight)
      if (!frames) return

      context.fillStyle = '#0b0b0a'
      context.fillRect(0, 0, pixelWidth, pixelHeight)
      const tileWidth = Math.max(1, Math.round(TILE_CSS_WIDTH * ratio))
      const tiles = Math.max(1, Math.ceil(pixelWidth / tileWidth))

      for (let index = 0; index < tiles; index += 1) {
        const destWidth = Math.min(tileWidth, pixelWidth - index * tileWidth)
        if (destWidth <= 0) break
        const frameIndex =
          frames.count <= 1
            ? 0
            : Math.min(
                frames.count - 1,
                Math.max(
                  0,
                  Math.round((index / Math.max(1, tiles - 1)) * (frames.count - 1)),
                ),
              )
        // Narrow tiles crop the sides rather than squeezing the frame, which
        // keeps faces/motion readable while fitting more frames per clip.
        const destAspect = destWidth / pixelHeight
        const sourceAspect = frames.tileWidth / frames.tileHeight
        let sourceX = 0
        let sourceY = 0
        let sourceW = frames.tileWidth
        let sourceH = frames.tileHeight
        if (sourceAspect > destAspect) {
          sourceW = frames.tileHeight * destAspect
          sourceX = (frames.tileWidth - sourceW) / 2
        } else {
          sourceH = frames.tileWidth / destAspect
          sourceY = (frames.tileHeight - sourceH) / 2
        }
        context.drawImage(
          frames.sprite,
          frameIndex * frames.tileWidth + sourceX,
          sourceY,
          sourceW,
          sourceH,
          index * tileWidth,
          0,
          destWidth,
          pixelHeight,
        )
      }
    }
    raf = requestAnimationFrame(paint)
    return () => cancelAnimationFrame(raf)
  }, [
    frames,
    width,
    clip.type,
    clip.sourceStart,
    clip.sourceEnd,
    clip.freezeFrameTime,
  ])

  return (
    <canvas
      ref={canvasRef}
      className="clip-thumb clip-filmstrip"
      aria-hidden="true"
      style={
        asset.thumbnail
          ? {
              backgroundImage: `url("${asset.thumbnail}")`,
            }
          : undefined
      }
    />
  )
}