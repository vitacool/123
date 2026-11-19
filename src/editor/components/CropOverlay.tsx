import { useEffect, useMemo, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { CROP_PRESETS, type CropPresetId } from '../core/constants'
import {
  resizeCropRect,
  sourceFitRect,
  type CropHandle,
  type Rect,
} from '../core/geometry'
import { useEditorStore } from '../store/EditorProvider'
import type { CropRect, SourceInfo } from '../core/types'
import { Icon } from './Icon'

interface DragState {
  mode: 'move' | CropHandle
  pointerId: number
  startX: number
  startY: number
  startCrop: CropRect
}

interface CropOverlayProps {
  frameWidth: number
  frameHeight: number
  source: SourceInfo
}

const HANDLES: { id: CropHandle; left: string; top: string; cursor: string }[] = [
  { id: 'nw', left: '-6px', top: '-6px', cursor: 'nwse-resize' },
  { id: 'n', left: 'calc(50% - 6px)', top: '-6px', cursor: 'ns-resize' },
  { id: 'ne', left: 'calc(100% - 6px)', top: '-6px', cursor: 'nesw-resize' },
  { id: 'e', left: 'calc(100% - 6px)', top: 'calc(50% - 6px)', cursor: 'ew-resize' },
  { id: 'se', left: 'calc(100% - 6px)', top: 'calc(100% - 6px)', cursor: 'nwse-resize' },
  { id: 's', left: 'calc(50% - 6px)', top: 'calc(100% - 6px)', cursor: 'ns-resize' },
  { id: 'sw', left: '-6px', top: 'calc(100% - 6px)', cursor: 'nesw-resize' },
  { id: 'w', left: '-6px', top: 'calc(50% - 6px)', cursor: 'ew-resize' },
]

function parsePresetRatio(preset: CropPresetId, sourceRatio: number): number | null {
  if (preset === 'free') return null
  if (preset === 'original') return sourceRatio
  const item = CROP_PRESETS.find((entry) => entry.id === preset)
  if (!item) return null
  const [w, h] = item.label.split(':').map(Number)
  return w > 0 && h > 0 ? w / h : null
}

export function CropOverlay({ frameWidth, frameHeight, source }: CropOverlayProps) {
  const session = useEditorStore((state) => state.cropSession)
  const updateCropDraft = useEditorStore((state) => state.updateCropDraft)
  const applyCropPreset = useEditorStore((state) => state.applyCropPreset)
  const commitCrop = useEditorStore((state) => state.commitCrop)
  const cancelCrop = useEditorStore((state) => state.cancelCrop)
  const [drag, setDrag] = useState<DragState | null>(null)

  const fit = useMemo(
    () => sourceFitRect(source.width, source.height, frameWidth, frameHeight),
    [source.width, source.height, frameWidth, frameHeight],
  )
  const sourceRatio = source.width / source.height
  const targetRatio = session ? parsePresetRatio(session.preset, sourceRatio) : null

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        commitCrop()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        cancelCrop()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [commitCrop, cancelCrop])

  useEffect(() => {
    if (!drag) return
    const handleMove = (event: PointerEvent) => {
      if (event.pointerId !== drag.pointerId) return
      const dx = (event.clientX - drag.startX) / fit.w
      const dy = (event.clientY - drag.startY) / fit.h
      if (drag.mode === 'move') {
        const x = Math.min(1 - drag.startCrop.w, Math.max(0, drag.startCrop.x + dx))
        const y = Math.min(1 - drag.startCrop.h, Math.max(0, drag.startCrop.y + dy))
        updateCropDraft({ ...drag.startCrop, x, y })
      } else {
        updateCropDraft(
          resizeCropRect(
            drag.startCrop,
            drag.mode,
            dx,
            dy,
            targetRatio,
            sourceRatio,
          ),
        )
      }
    }
    const handleUp = () => setDrag(null)
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
    }
  }, [drag, fit.w, fit.h, targetRatio, sourceRatio, updateCropDraft])

  if (!session) return null

  const crop = session.draft
  const box: Rect = {
    x: fit.x + crop.x * fit.w,
    y: fit.y + crop.y * fit.h,
    w: crop.w * fit.w,
    h: crop.h * fit.h,
  }
  const pixelW = Math.round(crop.w * source.width)
  const pixelH = Math.round(crop.h * source.height)

  const startDrag = (event: ReactPointerEvent, mode: 'move' | CropHandle) => {
    event.preventDefault()
    event.stopPropagation()
    const next: DragState = {
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startCrop: { ...crop },
    }
    setDrag(next)
  }

  return (
    <div className="crop-layer">
      <div className="crop-topbar">
        <div className="crop-title">
          <Icon name="crop" size={15} />
          <span>画面裁剪</span>
        </div>
        <div className="crop-presets" role="group" aria-label="裁剪比例">
          {CROP_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={session.preset === preset.id ? 'is-active' : ''}
              onClick={() => applyCropPreset(preset.id)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <div
        className="crop-box"
        style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
        onPointerDown={(event) => startDrag(event, 'move')}
        role="presentation"
      >
        <span className="crop-thirds crop-thirds-v1" />
        <span className="crop-thirds crop-thirds-v2" />
        <span className="crop-thirds crop-thirds-h1" />
        <span className="crop-thirds crop-thirds-h2" />
        <span className="crop-size-label">
          {pixelW} × {pixelH}
        </span>
        {HANDLES.map((handle) => (
          <span
            key={handle.id}
            className="crop-handle"
            style={{ left: handle.left, top: handle.top, cursor: handle.cursor }}
            onPointerDown={(event) => startDrag(event, handle.id)}
            aria-hidden="true"
          />
        ))}
      </div>

      <div className="crop-actions">
        <p className="crop-help">
          <Icon name="mouse" size={14} />
          拖动边框或控制点 · <kbd>Enter</kbd> 确认 · <kbd>Esc</kbd> 取消
        </p>
        <div className="crop-buttons">
          <button type="button" className="button ghost" onClick={cancelCrop}>
            <Icon name="close" size={15} />
            取消
          </button>
          <button type="button" className="button primary" onClick={commitCrop}>
            <Icon name="check" size={15} />
            确认裁剪
          </button>
        </div>
      </div>
    </div>
  )
}