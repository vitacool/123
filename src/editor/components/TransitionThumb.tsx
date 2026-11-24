import { useEffect, useMemo, useRef, useState } from 'react'
import { paintTransitionFrame } from '../core/transitionRender'
import type { TransitionType } from '../core/types'
import { useEditorStore } from '../store/EditorProvider'
import { clearThemeTokenCache, readThemeToken } from '../services/themeTokens'

interface TransitionThumbProps {
  type: TransitionType
  width?: number
  height?: number
}

/** 转场缩略图：静态显示 50% 进度，悬停时循环播放 0→1（prefers-reduced-motion 时不播放）。 */
export function TransitionThumb({ type, width = 56, height = 34 }: TransitionThumbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef(0)
  const [hovered, setHovered] = useState(false)
  const resolvedTheme = useEditorStore((state) => state.resolvedTheme)

  /**
   * 主题色只在主题切换时读一次。
   *
   * 旧实现每一帧 paint 里都 clearThemeTokenCache() + 3 次 readThemeToken()，
   * 每次都会 getComputedStyle(.framecut-root)：悬停期间约每秒 180 次强制样式重算。
   */
  const colors = useMemo(() => {
    // 显式引用主题值：CSS 变量读的是 DOM 当前值，ESLint 看不出这层依赖，
    // 但 `resolvedTheme` 确实是这条缓存的失效钥匙（主题切换后必须重读）。
    void resolvedTheme
    clearThemeTokenCache()
    return {
      muted: readThemeToken('--fc-muted', '#898277'),
      accent: readThemeToken('--fc-accent', '#3f8f5f'),
      ink: readThemeToken('--fc-on-solid', '#ffffff'),
    }
  }, [resolvedTheme])

  useEffect(() => {
    const reduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const animate = !reduced && hovered
    if (!animate) {
      // 静态帧：50% 进度。
      paint(0.5)
      return
    }
    const period = 1600
    const started = performance.now()
    /** 悬停预览只播两轮就停在 50% 帧：旧实现会一直 60fps 重绘，光标停在卡片上就持续吃 CPU。 */
    const maxElapsed = period * 2
    const tick = () => {
      const elapsed = performance.now() - started
      if (elapsed > maxElapsed) {
        paint(0.5)
        return
      }
      paint((elapsed % period) / period)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hovered, type, width, height, resolvedTheme, colors])

  /** 画一帧缩略图：A/B 两个色块 + 字母，交给共享的转场绘制函数合成。 */
  function paint(progress: number): void {
    const canvas = canvasRef.current
    if (!canvas) return
    const ratio = Math.min(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1, 2)
    const pixelWidth = Math.max(8, Math.round(width * ratio))
    const pixelHeight = Math.max(8, Math.round(height * ratio))
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.clearRect(0, 0, pixelWidth, pixelHeight)

    // 颜色跟随主题（界面色，不是作品内容）。颜色在 colors 里按主题缓存，
    // 这里不再每帧清缓存 / getComputedStyle。
    const { muted: colorA, accent: colorB, ink } = colors

    const block = (target: CanvasRenderingContext2D, color: string, letter: string) => {
      target.save()
      target.setTransform(1, 0, 0, 1, 0, 0)
      target.globalAlpha = 1
      target.globalCompositeOperation = 'source-over'
      target.fillStyle = color
      target.fillRect(0, 0, pixelWidth, pixelHeight)
      target.fillStyle = ink
      target.font = `700 ${Math.round(pixelHeight * 0.52)}px system-ui, sans-serif`
      target.textAlign = 'center'
      target.textBaseline = 'middle'
      target.fillText(letter, pixelWidth / 2, pixelHeight / 2)
      target.restore()
    }

    paintTransitionFrame({
      ctx,
      width: pixelWidth,
      height: pixelHeight,
      type,
      progress,
      drawLeft: (target) => block(target, colorA, 'A'),
      drawRight: (target) => block(target, colorB, 'B'),
      createCanvas: (w, h) => {
        const off = document.createElement('canvas')
        off.width = Math.max(1, Math.round(w))
        off.height = Math.max(1, Math.round(h))
        const inner = off.getContext('2d')
        return inner ? { canvas: off, ctx: inner } : null
      },
    })
  }

  return (
    <span
      className="transition-thumb"
      aria-hidden="true"
      style={{ width, height }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <canvas ref={canvasRef} style={{ width, height }} />
    </span>
  )
}