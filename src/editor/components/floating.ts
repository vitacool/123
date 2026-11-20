import { useLayoutEffect, useRef, useState } from 'react'

/** 浮层与视口边缘的最小间距（与 ContextMenu 一致）。 */
export const FLOATING_MARGIN = 8

/**
 * 浮层的视口避让：先按锚点放置，量到实际尺寸后若超出右/下就向左/上翻转，
 * 最后夹到视口内。用 offsetWidth/offsetHeight 而不是 getBoundingClientRect：
 * 后者会被入场动画的 transform 缩放影响，量出来偏小，贴边时仍会溢出几个像素。
 *
 * ContextMenu 与关键帧的缓动/曲线浮层共用这一套定位逻辑。
 */
export function useFloatingPosition(
  x: number,
  y: number,
  margin = FLOATING_MARGIN,
): {
  ref: React.RefObject<HTMLDivElement>
  style: { left: number; top: number }
} {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const width = el.offsetWidth
    const height = el.offsetHeight
    let left = x
    let top = y
    if (x + width > viewportWidth - margin) left = x - width
    if (y + height > viewportHeight - margin) top = y - height
    left = Math.max(margin, Math.min(left, viewportWidth - width - margin))
    top = Math.max(margin, Math.min(top, viewportHeight - height - margin))
    setPos((current) => (current.left === left && current.top === top ? current : { left, top }))
  })

  return { ref, style: pos }
}

/** 缓动/曲线浮层共用的关闭行为：Esc + 点空白。 */
export function useDismiss(onClose: () => void, active = true): void {
  useLayoutEffect(() => {
    if (!active) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.kf-popover')) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [onClose, active])
}