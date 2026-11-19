import { useEffect, useMemo, useRef, useState } from 'react'
import { MARKER_COLORS } from '../core/constants'
import { formatClock } from '../core/format'
import type { Marker } from '../core/types'
import { useEditorStore } from '../store/EditorProvider'
import { Icon } from './Icon'

interface MarkerPopoverProps {
  marker: Marker
  anchor: DOMRect
  onClose: () => void
  onPointerEnter: () => void
  onPointerLeave: () => void
}

const WIDTH = 278
const ESTIMATED_HEIGHT = 268

export function MarkerPopover({
  marker,
  anchor,
  onClose,
  onPointerEnter,
  onPointerLeave,
}: MarkerPopoverProps) {
  const updateMarker = useEditorStore((state) => state.updateMarker)
  const deleteMarker = useEditorStore((state) => state.deleteMarker)
  const [note, setNote] = useState(marker.note)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const noteRef = useRef(note)
  noteRef.current = note

  useEffect(() => setNote(marker.note), [marker.id, marker.note])

  const left = Math.max(12, Math.min(window.innerWidth - WIDTH - 12, anchor.left + anchor.width / 2 - WIDTH / 2))
  const below = anchor.bottom + 10
  const top =
    below + ESTIMATED_HEIGHT > window.innerHeight - 12
      ? Math.max(12, anchor.top - ESTIMATED_HEIGHT - 10)
      : below

  const saveNote = () => {
    if (noteRef.current === marker.note) return
    updateMarker({ ...marker, note: noteRef.current })
  }

  const closeWithSave = () => {
    saveNote()
    onClose()
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeWithSave()
      }
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (popoverRef.current?.contains(event.target as Node)) return
      if (target?.closest('.marker-flag')) return
      closeWithSave()
    }
    window.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  })

  const style = useMemo(
    () => ({
      position: 'fixed' as const,
      left,
      top,
      width: WIDTH,
      zIndex: 120,
    }),
    [left, top],
  )

  return (
    <div
      className="marker-popover"
      style={style}
      ref={popoverRef}
      role="dialog"
      aria-label="标记编辑"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <div className="marker-popover-head">
        <span className="marker-popover-icon" style={{ color: marker.color }}>
          <Icon name="marker" size={17} />
        </span>
        <div>
          <strong>标记</strong>
          <span>{formatClock(marker.time)}</span>
        </div>
        <button type="button" className="icon-button" onClick={closeWithSave} aria-label="关闭标记编辑">
          <Icon name="close" size={15} />
        </button>
      </div>

      <div className="marker-popover-body">
        <div className="marker-color-row">
          <span>颜色</span>
          <div className="marker-colors">
            {MARKER_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={`marker-color${marker.color === color ? ' is-active' : ''}`}
                style={{ background: color }}
                aria-label={`使用颜色 ${color}`}
                onClick={() => updateMarker({ ...marker, color, note })}
              />
            ))}
          </div>
        </div>
        <label className="marker-note">
          <span>
            备注
            <em>{note.length}/160</em>
          </span>
          <textarea
            value={note}
            maxLength={160}
            rows={3}
            placeholder="写一条剪辑笔记…"
            onChange={(event) => setNote(event.target.value)}
            onBlur={saveNote}
          />
        </label>
      </div>

      <div className="marker-popover-foot">
        <button
          type="button"
          className="text-button danger"
          onClick={() => {
            deleteMarker(marker.id)
            onClose()
          }}
        >
          <Icon name="trash" size={14} />
          删除标记
        </button>
        <button
          type="button"
          className="button mini"
          onClick={() => {
            saveNote()
            onClose()
          }}
        >
          保存备注
        </button>
      </div>
    </div>
  )
}