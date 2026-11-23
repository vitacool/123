import { isDragging, matchesPointer } from './pointerDrag'
import { useEffect, useRef, useState } from 'react'
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { clamp } from '../core/timeline'
import { isTextLocked } from '../core/tracks'
import type { TextClip, TextTrack } from '../core/types'
import { useEditorStore, useEditorStoreApi } from '../store/EditorProvider'
import { Icon } from './Icon'

const PAD = 12

interface DragState {
  trackId: string
  clipId: string
  pointerId: number
  startX: number
  originalStart: number
  start: number
  duration: number
}

interface EdgeState {
  trackId: string
  clipId: string
  pointerId: number
  edge: 'left' | 'right'
  startX: number
  delta: number
  minDelta: number
  maxDelta: number
}

export function TextTracks({
  onClipContextMenu,
  pad = PAD,
}: {
  /** 左侧留白：与标尺/主轨共用（有封面块时是 76，不是 12）。 */
  pad?: number
  /** 右键片段：由 Timeline 统一弹菜单（这里只上报目标）。 */
  onClipContextMenu?: (event: ReactMouseEvent<HTMLElement>, clipId: string) => void
} = {}) {
  const store = useEditorStoreApi()
  const tracks = useEditorStore((state) => state.project.textTracks) ?? []
  const pps = useEditorStore((state) => state.timelineZoom)
  const selectedClipId = useEditorStore((state) => state.selectedClipId)
  const selectClip = useEditorStore((state) => state.selectClip)
  const moveTextClip = useEditorStore((state) => state.moveTextClip)
  const resizeTextClipEdge = useEditorStore((state) => state.resizeTextClipEdge)

  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const [edge, setEdge] = useState<EdgeState | null>(null)
  const edgeRef = useRef<EdgeState | null>(null)

  useEffect(() => {
    if (!isDragging(drag)) return
    const handleMove = (event: PointerEvent) => {
      const current = dragRef.current
      if (!matchesPointer(current, event)) return
      const next = {
        ...current,
        start: Math.max(0, current.originalStart + (event.clientX - current.startX) / pps),
      }
      dragRef.current = next
      setDrag(next)
    }
    const finish = (event: PointerEvent) => {
      const current = dragRef.current
      // 只认发起这次拖拽的指针（多指/笔场景）。
      if (!matchesPointer(current, event)) return
      // 像素阈值（5px），与视频/音频片段一致；见 AudioTracks 里同名说明。
      if (current && Math.abs(current.start - current.originalStart) * pps >= 5) {
        moveTextClip(current.trackId, current.clipId, current.start)
      }
      dragRef.current = null
      setDrag(null)
    }
    const cancel = () => {
      dragRef.current = null
      setDrag(null)
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancel)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancel)
    }
  }, [isDragging(drag), pps, moveTextClip])

  useEffect(() => {
    if (!isDragging(edge)) return
    const handleMove = (event: PointerEvent) => {
      const current = edgeRef.current
      if (!matchesPointer(current, event)) return
      const delta = clamp(
        (event.clientX - current.startX) / pps,
        current.minDelta,
        current.maxDelta,
      )
      const next = { ...current, delta }
      edgeRef.current = next
      setEdge(next)
    }
    const finish = (event: PointerEvent) => {
      const current = edgeRef.current
      if (!matchesPointer(current, event)) return
      if (current && Math.abs(current.delta) > 0.002) {
        resizeTextClipEdge(current.trackId, current.clipId, current.edge, current.delta)
      }
      edgeRef.current = null
      setEdge(null)
    }
    const cancel = () => {
      edgeRef.current = null
      setEdge(null)
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancel)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancel)
    }
  }, [isDragging(edge), pps, resizeTextClipEdge])

  const startDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    track: TextTrack,
    clip: TextClip,
  ) => {
    if (event.button !== 0 || isTextLocked(track)) return
    event.preventDefault()
    event.stopPropagation()
    selectClip(clip.id)
    store.getState().setPlaying(false)
    const next: DragState = {
      trackId: track.id,
      clipId: clip.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      originalStart: clip.start,
      start: clip.start,
      duration: clip.end - clip.start,
    }
    dragRef.current = next
    setDrag(next)
  }

  const startEdge = (
    event: ReactPointerEvent<HTMLSpanElement>,
    track: TextTrack,
    clip: TextClip,
    edgeName: 'left' | 'right',
  ) => {
    if (isTextLocked(track)) return
    event.preventDefault()
    event.stopPropagation()
    selectClip(clip.id)
    store.getState().setPlaying(false)
    const duration = clip.end - clip.start
    const next: EdgeState = {
      trackId: track.id,
      clipId: clip.id,
      pointerId: event.pointerId,
      edge: edgeName,
      startX: event.clientX,
      delta: 0,
      minDelta: edgeName === 'left' ? -clip.start : -(duration - 0.2),
      maxDelta: edgeName === 'left' ? duration - 0.2 : Number.POSITIVE_INFINITY,
    }
    edgeRef.current = next
    setEdge(next)
  }

  if (tracks.length === 0) return null

  return (
    <div className="text-tracks">
      {tracks.map((track) => (
        <div
          key={track.id}
          className={`text-track${track.hidden ? ' is-hidden' : ''}${
            isTextLocked(track) ? ' is-locked' : ''
          }`}
          data-text-track-id={track.id}
        >
          <div className="text-track-lane">
            {track.clips.map((clip) => {
              const dragging = drag?.clipId === clip.id ? drag : null
              const trimming = edge?.clipId === clip.id ? edge : null
              let start = dragging ? dragging.start : clip.start
              let end = clip.end
              if (trimming) {
                if (trimming.edge === 'left') start += trimming.delta
                else end += trimming.delta
              }
              const width = Math.max(4, (end - start) * pps - 2)
              return (
                <div
                  key={clip.id}
                  className={`text-clip${clip.id === selectedClipId ? ' is-selected' : ''}`}
                  style={{ left: pad + start * pps + 1, width }}
                  role="option"
                  aria-selected={clip.id === selectedClipId}
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
                    // 阻止冒泡，避免触发编辑器的 Space=播放/暂停
                    event.preventDefault()
                    event.stopPropagation()
                    selectClip(clip.id)
                  }}
                  aria-label={`文本片段 ${clip.text.slice(0, 20)}`}
                  title={clip.text}
                  onPointerDown={(event) => startDrag(event, track, clip)}
                  onContextMenu={(event) => onClipContextMenu?.(event, clip.id)}
                >
                  <span className="text-clip-kind">
                    <Icon name="text" size={11} />
                  </span>
                  <span className="text-clip-copy">{clip.text || '空文本'}</span>
                  <span
                    className="clip-trim-handle is-left"
                    role="separator"
                    aria-label="拖动修改文本入点"
                    onPointerDown={(event) => startEdge(event, track, clip, 'left')}
                  ><span /></span>
                  <span
                    className="clip-trim-handle is-right"
                    role="separator"
                    aria-label="拖动修改文本出点"
                    onPointerDown={(event) => startEdge(event, track, clip, 'right')}
                  ><span /></span>
                </div>
              )
            })}
            {track.clips.length === 0 && (
              <span className="text-track-empty">空文本轨</span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}