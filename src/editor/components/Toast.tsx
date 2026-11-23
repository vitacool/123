import { matchesPointer } from './pointerDrag'
import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useEditorStore } from '../store/EditorProvider'

export function Toast() {
  const toast = useEditorStore((state) => state.toast)
  const clearToast = useEditorStore((state) => state.clearToast)

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => clearToast(), 3200)
    return () => window.clearTimeout(timer)
  }, [toast, clearToast])

  if (!toast) return null
  return (
    <div className={`toast toast-${toast.kind}`} role="status" aria-live="polite">
      <span className="toast-dot" />
      <span>{toast.message}</span>
    </div>
  )
}

interface CommitNumberProps {
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  ariaLabel: string
  onCommit: (value: number) => void
  onPreview?: (value: number) => void
  disabled?: boolean
}

export function CommitNumber({
  value,
  min,
  max,
  step = 1,
  unit,
  ariaLabel,
  onCommit,
  onPreview,
  disabled,
}: CommitNumberProps) {
  const [text, setText] = useState(String(value))
  const [focused, setFocused] = useState(false)
  /** 越界截断时的可见提示（aria-live），1.5s 后自动消失。 */
  const [limitHint, setLimitHint] = useState<string | null>(null)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const hintTimer = useRef<number | null>(null)
  const dragRef = useRef<{ pointerId: number; startX: number; startValue: number; moved: boolean } | null>(
    null,
  )
  /** 滚轮连续调节：先预览，停止滚动 320ms 后一次性提交（1 条历史）。 */
  const wheelPending = useRef<number | null>(null)
  const wheelTimer = useRef<number | null>(null)

  useEffect(() => {
    if (!focused) setText(String(value))
  }, [value, focused])

  useEffect(() => {
    return () => {
      if (hintTimer.current !== null) window.clearTimeout(hintTimer.current)
      if (wheelTimer.current !== null) window.clearTimeout(wheelTimer.current)
    }
  }, [])

  const align = (raw: number): number => {
    const snapped = Math.round(raw / step) * step
    return Number(snapped.toFixed(6))
  }

  /** 解析时容忍单位后缀（"50%" → 50），并回传是否发生了越界截断。 */
  const parse = (raw: string): { value: number; clamped: boolean } | null => {
    // 去掉除数字/正负号/小数点/指数以外的字符：%、°、s、px、x 等单位都被剥掉。
    const cleaned = raw.replace(/[^0-9+\-.]/g, '').trim()
    if (cleaned === '' || cleaned === '-' || cleaned === '+' || cleaned === '.') return null
    const next = Number(cleaned)
    if (!Number.isFinite(next)) return null
    const clampedValue = Math.min(max, Math.max(min, next))
    return { value: clampedValue, clamped: Math.abs(clampedValue - next) > 1e-9 }
  }

  const showLimit = (next: number) => {
    setLimitHint(`已限制为 ${next}${unit ?? ''}`)
    if (hintTimer.current !== null) window.clearTimeout(hintTimer.current)
    hintTimer.current = window.setTimeout(() => setLimitHint(null), 1500)
  }

  const commit = () => {
    const parsed = parse(text)
    if (!parsed) {
      setText(String(value))
      return
    }
    setText(String(parsed.value))
    if (parsed.clamped) showLimit(parsed.value)
    onCommit(parsed.value)
  }

  // 滚轮调值：用原生非 passive 监听，才能 preventDefault 阻止外层面板一起滚动。
  useEffect(() => {
    const element = rootRef.current
    if (!element || disabled) return
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const direction = event.deltaY > 0 ? -1 : 1
      const multiplier = event.shiftKey ? 10 : event.altKey ? 0.1 : 1
      const base = wheelPending.current ?? value
      const next = align(Math.min(max, Math.max(min, base + direction * step * multiplier)))
      wheelPending.current = next
      setText(String(next))
      onPreview?.(next)
      if (wheelTimer.current !== null) window.clearTimeout(wheelTimer.current)
      wheelTimer.current = window.setTimeout(() => {
        const final = wheelPending.current
        wheelPending.current = null
        wireCommit(final)
      }, 320)
    }
    element.addEventListener('wheel', handleWheel, { passive: false })
    return () => element.removeEventListener('wheel', handleWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, step, min, max, disabled, onPreview, onCommit])

  /** 滚轮/拖拽的收尾提交（只写 1 条历史）。 */
  function wireCommit(next: number | null) {
    if (next === null) return
    setText(String(next))
    onCommit(next)
  }

  const handleGripDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (disabled || event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startValue: value,
      moved: false,
    }
  }

  const handleGripMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const drag = dragRef.current
    if (!matchesPointer(drag, event)) return
    const deltaPx = event.clientX - drag.startX
    if (Math.abs(deltaPx) < 3) return
    drag.moved = true
    const multiplier = event.shiftKey ? 10 : event.altKey ? 0.1 : 1
    const steps = Math.round(deltaPx / 4)
    const next = align(
      Math.min(max, Math.max(min, drag.startValue + steps * step * multiplier)),
    )
    setText(String(next))
    onPreview?.(next)
  }

  const handleGripUp = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const drag = dragRef.current
    if (!matchesPointer(drag, event)) return
    dragRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // 指针已被系统释放时忽略。
    }
    if (!drag.moved) return
    const deltaPx = event.clientX - drag.startX
    const multiplier = event.shiftKey ? 10 : event.altKey ? 0.1 : 1
    const steps = Math.round(deltaPx / 4)
    wireCommit(
      align(Math.min(max, Math.max(min, drag.startValue + steps * step * multiplier))),
    )
  }

  return (
    <span
      ref={rootRef}
      className={`commit-number${limitHint ? ' is-limit' : ''}`}
    >
      <span
        className="commit-number-grip"
        aria-hidden="true"
        title="左右拖动调值（Shift ×10，Alt ÷10）"
        onPointerDown={handleGripDown}
        onPointerMove={handleGripMove}
        onPointerUp={handleGripUp}
        onPointerCancel={handleGripUp}
      />
      <input
        type="number"
        value={text}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-label={ariaLabel}
        onFocus={() => setFocused(true)}
        onChange={(event) => {
          setText(event.target.value)
          const parsed = parse(event.target.value)
          if (parsed !== null) onPreview?.(parsed.value)
        }}
        onBlur={() => {
          setFocused(false)
          commit()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
          }
        }}
      />
      {unit && <span className="commit-number-unit">{unit}</span>}
      {limitHint && (
        <span className="commit-number-hint" role="status" aria-live="assertive">
          {limitHint}
        </span>
      )}
    </span>
  )
}