import { memo, useEffect, useRef, useState } from 'react'
import type { Clip, SourceInfo } from '../core/types'
import { clipFilmstripRange } from '../core/clipTime'
import { getClipFrames, type ClipFrames } from '../services/filmstrip'
import { useEditorStore } from '../store/EditorProvider'
import { readThemeToken } from '../services/themeTokens'

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
function ClipFilmstripInner({ clip, asset, width }: ClipFilmstripProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [frames, setFrames] = useState<ClipFrames | null>(null)
  // 主题变化时重绘（胶片条底色是界面色，从 CSS 变量读取）。
  const resolvedTheme = useEditorStore((state) => state.resolvedTheme)
  // 定格片段取样「冻结帧」这一个点，否则会把停留时长当成播放区间。
  const sampleRange = clipFilmstripRange(clip)

  useEffect(() => {
    let cancelled = false
    let timer = 0
    setFrames(null)

    const load = (attempt: number) => {
      void getClipFrames(asset, sampleRange.start, sampleRange.end).then(
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
  }, [asset.url, asset.name, sampleRange.start, sampleRange.end])

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

      context.fillStyle = readThemeToken('--fc-filmstrip-bg', '#0b0b0a')
      context.fillRect(0, 0, pixelWidth, pixelHeight)
      const tileWidth = Math.max(1, Math.round(TILE_CSS_WIDTH * ratio))
      const tiles = Math.max(1, Math.ceil(pixelWidth / tileWidth))

      for (let index = 0; index < tiles; index += 1) {
        const destWidth = Math.min(tileWidth, pixelWidth - index * tileWidth)
        if (destWidth <= 0) break
        // 定格片段整条只用第 0 格：取样点就是冻结帧，而 20ms 的最小取样窗口
        // 在 30fps 素材上可能跨到下一帧，逐格取不同帧会让「定格」看起来在动。
        const frozen = clip.type === 'freeze'
        const frameIndex = frozen
          ? 0
          : frames.count <= 1
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
    sampleRange.start,
    sampleRange.end,
    resolvedTheme,
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
/**
 * 片段缩略图条：每个片段一块 canvas，是时间轴里最重的子组件。
 *
 * memo 化后，父组件（Timeline）因为别的原因重渲染时（例如 10Hz 的播放头同步、
 * 悬浮/拖拽状态变化），只要 (clip, asset, width) 没变就不会重绘 canvas。
 * 用默认浅比较即可：clip/asset 都是只在真正编辑时换引用的对象。
 */
export const ClipFilmstrip = memo(ClipFilmstripInner)
