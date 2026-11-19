import { useEffect, useRef, useState } from 'react'

interface CommitSliderProps {
  value: number
  min: number
  max: number
  step: number
  ariaLabel: string
  onPreview: (value: number) => void
  onCommit: (value: number) => void
  format?: (value: number) => string
  disabled?: boolean
}

/**
 * A slider that only writes to project history when the pointer is released
 * (or keyboard editing blurs), so one drag equals one undo step.
 */
export function CommitSlider({
  value,
  min,
  max,
  step,
  ariaLabel,
  onPreview,
  onCommit,
  format,
  disabled,
}: CommitSliderProps) {
  const [draft, setDraft] = useState(value)
  const [dragging, setDragging] = useState(false)
  const dirty = useRef(false)
  const pointerActive = useRef(false)

  useEffect(() => {
    if (!pointerActive.current) setDraft(value)
  }, [value])

  const commit = (next: number) => {
    if (!dirty.current) return
    dirty.current = false
    onCommit(next)
  }

  return (
    <div className={`commit-slider${disabled ? ' is-disabled' : ''}`}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={draft}
        disabled={disabled}
        aria-label={ariaLabel}
        onPointerDown={() => {
          pointerActive.current = true
          setDragging(true)
        }}
        onChange={(event) => {
          const next = Number(event.target.value)
          dirty.current = true
          setDraft(next)
          onPreview(next)
        }}
        onPointerUp={() => {
          pointerActive.current = false
          setDragging(false)
          commit(draft)
        }}
        onPointerCancel={() => {
          pointerActive.current = false
          setDragging(false)
          commit(draft)
        }}
        onBlur={() => {
          pointerActive.current = false
          setDragging(false)
          commit(draft)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur()
          }
        }}
      />
      <span className={`commit-value${dragging ? ' is-live' : ''}`}>
        {format ? format(draft) : String(draft)}
      </span>
    </div>
  )
}