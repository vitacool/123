import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { audioClipDuration } from '../core/audio'
import { isAudioLocked } from '../core/tracks'
import { clamp } from '../core/timeline'
import type { AudioClip, AudioTrack } from '../core/types'
import { useEditorStore, useEditorStoreApi } from '../store/EditorProvider'
import { Icon } from './Icon'
import { CommitSlider } from './CommitSlider'
import { AudioWaveform } from './AudioWaveform'

const PAD = 12
const MIN_DURATION = 0.05
const EMPTY_TRACKS: AudioTrack[] = []

interface DragState {
  trackId: string
  clipId: string
  pointerId: number
  startX: number
  originalStart: number
  start: number
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

function AudioTrackHead({ track }: { track: AudioTrack }) {
  const setVolume = useEditorStore((state) => state.setAudioTrackVolume)
  const setPreviewPatch = useEditorStore((state) => state.setPreviewPatch)
  const toggleMuted = useEditorStore((state) => state.toggleAudioTrackMuted)
  const toggleHidden = useEditorStore((state) => state.toggleAudioTrackVisibility)
  const removeTrack = useEditorStore((state) => state.removeAudioTrack)

  return (
    <div className="audio-track-head">
      <span className="audio-track-name">
        <Icon name="music" size={12} />
        {track.name}
      </span>
      <CommitSlider
        value={Math.round(track.volume * 100)}
        min={0}
        max={200}
        step={5}
        ariaLabel={`${track.name}音量`}
        onPreview={(value) =>
          setPreviewPatch({
            patch: {},
            trackVolume: { trackId: track.id, volume: value / 100 },
          })
        }
        onCommit={(value) => setVolume(track.id, value / 100)}
        format={(value) => `${Math.round(value)}%`}
      />
      <button
        type="button"
        className={`track-control${track.muted ? ' is-off' : ''}`}
        aria-label={track.muted ? '取消静音' : '静音'}
        title={track.muted ? '取消静音' : '静音音频轨'}
        onClick={() => toggleMuted(track.id)}
      >
        <Icon name={track.muted ? 'volumeOff' : 'volume'} size={12} />
      </button>
      <button
        type="button"
        className={`track-control${track.hidden ? ' is-off' : ''}`}
        aria-label={track.hidden ? '显示音频轨' : '隐藏音频轨'}
        title={track.hidden ? '显示音频轨' : '隐藏音频轨（导出同样生效）'}
        onClick={() => toggleHidden(track.id)}
      >
        <Icon name={track.hidden ? 'eyeOff' : 'eye'} size={12} />
      </button>
      <button
        type="button"
        className="overlay-track-remove"
        aria-label={`删除${track.name}`}
        title="删除音频轨（可撤销）"
        onClick={() => removeTrack(track.id)}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  )
}

export function AudioTracks({
  pps,
  onClipContextMenu,
}: {
  pps: number
  /** 右键片段：由 Timeline 统一弹菜单（这里只上报目标）。 */
  onClipContextMenu?: (event: ReactMouseEvent<HTMLElement>, clipId: string) => void
}) {
  const store = useEditorStoreApi()
  const audioTracks = useEditorStore((state) => state.project.audioTracks)
  const tracks = audioTracks ?? EMPTY_TRACKS
  const assets = useEditorStore((state) => state.assets)
  const selectedClipId = useEditorStore((state) => state.selectedClipId)
  const selectClip = useEditorStore((state) => state.selectClip)
  const moveAudioClip = useEditorStore((state) => state.moveAudioClip)
  const resizeAudioClipEdge = useEditorStore((state) => state.resizeAudioClipEdge)

  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const [edge, setEdge] = useState<EdgeState | null>(null)
  const edgeRef = useRef<EdgeState | null>(null)

  useEffect(() => {
    if (!drag?.pointerId) return
    const handleMove = (event: PointerEvent) => {
      const current = dragRef.current
      if (!current || event.pointerId !== current.pointerId) return
      const next = {
        ...current,
        start: Math.max(0, current.originalStart + (event.clientX - current.startX) / pps),
      }
      dragRef.current = next
      setDrag(next)
    }
    const finish = () => {
      const current = dragRef.current
      if (current && Math.abs(current.start - current.originalStart) > 0.002) {
        moveAudioClip(current.trackId, current.clipId, current.start)
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
  }, [drag?.pointerId, pps, moveAudioClip])

  useEffect(() => {
    if (!edge?.pointerId) return
    const handleMove = (event: PointerEvent) => {
      const current = edgeRef.current
      if (!current || event.pointerId !== current.pointerId) return
      const delta = clamp(
        (event.clientX - current.startX) / pps,
        current.minDelta,
        current.maxDelta,
      )
      const next = { ...current, delta }
      edgeRef.current = next
      setEdge(next)
    }
    const finish = () => {
      const current = edgeRef.current
      if (current && Math.abs(current.delta) > 0.002) {
        resizeAudioClipEdge(current.trackId, current.clipId, current.edge, current.delta)
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
  }, [edge?.pointerId, pps, resizeAudioClipEdge])

  const assetByUrl = new Map(assets.map((asset) => [asset.url, asset]))

  const startDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    track: AudioTrack,
    clip: AudioClip,
  ) => {
    if (event.button !== 0) return
    if (isAudioLocked(track)) return
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
    }
    dragRef.current = next
    setDrag(next)
  }

  const startEdge = (
    event: ReactPointerEvent<HTMLSpanElement>,
    track: AudioTrack,
    clip: AudioClip,
    edgeName: 'left' | 'right',
  ) => {
    event.preventDefault()
    event.stopPropagation()
    if (isAudioLocked(track)) return
    selectClip(clip.id)
    store.getState().setPlaying(false)
    const asset = assetByUrl.get(clip.sourceUrl)
    const sourceDuration = asset?.duration ?? clip.sourceEnd
    const duration = audioClipDuration(clip)
    let minDelta: number
    let maxDelta: number
    if (edgeName === 'left') {
      minDelta = -Math.min(clip.sourceStart, clip.start)
      maxDelta = duration - MIN_DURATION
    } else {
      minDelta = -(duration - MIN_DURATION)
      maxDelta = Math.max(0, sourceDuration - clip.sourceEnd)
    }
    const next: EdgeState = {
      trackId: track.id,
      clipId: clip.id,
      pointerId: event.pointerId,
      edge: edgeName,
      startX: event.clientX,
      delta: 0,
      minDelta,
      maxDelta,
    }
    edgeRef.current = next
    setEdge(next)
  }

  if (tracks.length === 0) return null

  return (
    <div className="audio-tracks">
      {tracks.map((track) => (
        <div
          key={track.id}
          className={`audio-track${track.hidden ? ' is-hidden' : ''}`}
          data-audio-track-id={track.id}
        >
          <AudioTrackHead track={track} />
          <div className="audio-clip-lane">
            {track.clips.map((clip) => {
              const dragging = drag?.clipId === clip.id ? drag : null
              const trimming = edge?.clipId === clip.id ? edge : null
              const duration = audioClipDuration(clip)
              let start = dragging ? dragging.start : clip.start
              let visibleDuration = duration
              if (trimming) {
                if (trimming.edge === 'left') {
                  start += trimming.delta
                  visibleDuration -= trimming.delta
                } else {
                  visibleDuration += trimming.delta
                }
              }
              const width = Math.max(4, visibleDuration * pps - 2)
              const asset = assetByUrl.get(clip.sourceUrl)
              return (
                <div
                  key={clip.id}
                  className={`audio-clip${clip.id === selectedClipId ? ' is-selected' : ''}`}
                  style={{ left: PAD + start * pps + 1, width }}
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
                  aria-label={`音频片段 ${asset?.name ?? ''}，${duration.toFixed(1)} 秒`}
                  title={asset?.name}
                  onPointerDown={(event) => startDrag(event, track, clip)}
                  onContextMenu={(event) => onClipContextMenu?.(event, clip.id)}
                >
                  {asset && (
                    <AudioWaveform
                      clip={clip}
                      asset={asset}
                      width={Math.max(4, visibleDuration * pps - 2)}
                      height={30}
                    />
                  )}
                  <span className="audio-clip-name">
                    <Icon name="music" size={11} />
                    {width > 90 && (asset?.name ?? '音频')}
                  </span>
                  <span className="audio-clip-duration">{duration.toFixed(1)}s</span>
                  <span
                    className="clip-trim-handle is-left"
                    role="separator"
                    aria-label="拖动修改音频入点"
                    onPointerDown={(event) => startEdge(event, track, clip, 'left')}
                  ><span /></span>
                  <span
                    className="clip-trim-handle is-right"
                    role="separator"
                    aria-label="拖动修改音频出点"
                    onPointerDown={(event) => startEdge(event, track, clip, 'right')}
                  ><span /></span>
                </div>
              )
            })}
            {track.clips.length === 0 && (
              <span className="audio-track-empty">空音频轨</span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}