import { useEditorStore } from '../store/EditorProvider'
import type { AudioTrack, OverlayTrack, TextTrack } from '../core/types'
import {
  audioTrackState,
  isAudioSuppressedBySolo,
  mainTrackState,
  overlayTrackState,
  textTrackState,
} from '../core/tracks'
import { TrackControls } from './TrackControls'

const OVERLAY_HEIGHT = 64
const MAIN_HEIGHT = 64
const AUDIO_HEIGHT = 64

export function TrackGutter() {
  const project = useEditorStore((state) => state.project)
  const removeOverlayTrack = useEditorStore((state) => state.removeOverlayTrack)
  const moveOverlayTrack = useEditorStore((state) => state.moveOverlayTrack)
  const moveTrackBy = useEditorStore((state) => state.moveTrackBy)
  const removeAudioTrack = useEditorStore((state) => state.removeAudioTrack)
  const setAudioTrackVolume = useEditorStore((state) => state.setAudioTrackVolume)
  const removeTextTrack = useEditorStore((state) => state.removeTextTrack)
  const openCoverPanel = useEditorStore((state) => state.openCoverPanel)

  // overlayTracks 是 bottom-to-top（index 0 最底），UI 倒序渲染（最上层显示在最上面）。
  const overlayArray = project.overlayTracks ?? []
  const overlays = [...overlayArray].reverse()
  const audioTracks = project.audioTracks ?? []
  const textTracks = project.textTracks ?? []
  const mainState = mainTrackState(project)

  return (
    <>
      <div className="track-gutter-spacer" />
      {overlays.map((track: OverlayTrack) => {
        // 边界按数组 index 判断：index = length-1 是最上层，index = 0 是最下层。
        const arrayIndex = overlayArray.findIndex((item) => item.id === track.id)
        return (
          <TrackControls
            key={track.id}
            kind="overlay"
            trackId={track.id}
            name={track.name}
            state={overlayTrackState(track)}
            height={OVERLAY_HEIGHT}
            suppressedBySolo={isAudioSuppressedBySolo(project, overlayTrackState(track))}
            onRemove={() => removeOverlayTrack(track.id)}
            canMoveUp={arrayIndex >= 0 && arrayIndex < overlayArray.length - 1}
            canMoveDown={arrayIndex > 0}
            onMoveUp={() => moveOverlayTrack(track.id, 'up')}
            onMoveDown={() => moveOverlayTrack(track.id, 'down')}
          />
        )
      })}
      <TrackControls
        kind="main"
        trackId={null}
        name="主轨"
        state={mainState}
        height={MAIN_HEIGHT}
        suppressedBySolo={isAudioSuppressedBySolo(project, mainState)}
        onOpenCover={() => openCoverPanel()}
      />
      {audioTracks.map((track: AudioTrack) => {
        const state = audioTrackState(track)
        return (
          <TrackControls
            key={track.id}
            kind="audio"
            trackId={track.id}
            name={track.name}
            state={state}
            height={AUDIO_HEIGHT}
            volume={track.volume}
            onVolumeChange={(value) => setAudioTrackVolume(track.id, value)}
            suppressedBySolo={isAudioSuppressedBySolo(project, state)}
            onRemove={() => removeAudioTrack(track.id)}
            canMoveUp={audioTracks.findIndex((item) => item.id === track.id) > 0}
            canMoveDown={audioTracks.findIndex((item) => item.id === track.id) < audioTracks.length - 1}
            onMoveUp={() => moveTrackBy('audio', track.id, 'up')}
            onMoveDown={() => moveTrackBy('audio', track.id, 'down')}
          />
        )
      })}
      {textTracks.map((track: TextTrack) => (
        <TrackControls
          key={track.id}
          kind="text"
          trackId={track.id}
          name={track.name}
          state={textTrackState(track)}
          height={AUDIO_HEIGHT}
          onRemove={() => removeTextTrack(track.id)}
          canMoveUp={textTracks.findIndex((item) => item.id === track.id) > 0}
          canMoveDown={textTracks.findIndex((item) => item.id === track.id) < textTracks.length - 1}
          onMoveUp={() => moveTrackBy('text', track.id, 'up')}
          onMoveDown={() => moveTrackBy('text', track.id, 'down')}
        />
      ))}
    </>
  )
}