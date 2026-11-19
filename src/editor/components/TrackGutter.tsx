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
  const removeAudioTrack = useEditorStore((state) => state.removeAudioTrack)
  const removeTextTrack = useEditorStore((state) => state.removeTextTrack)

  const overlays = [...(project.overlayTracks ?? [])].reverse()
  const audioTracks = project.audioTracks ?? []
  const textTracks = project.textTracks ?? []
  const mainState = mainTrackState(project)

  return (
    <>
      <div className="track-gutter-spacer" />
      {overlays.map((track: OverlayTrack) => (
        <TrackControls
          key={track.id}
          kind="overlay"
          trackId={track.id}
          name={track.name}
          state={overlayTrackState(track)}
          height={OVERLAY_HEIGHT}
          onRemove={() => removeOverlayTrack(track.id)}
        />
      ))}
      <TrackControls
        kind="main"
        trackId={null}
        name="主轨"
        state={mainState}
        height={MAIN_HEIGHT}
        suppressedBySolo={isAudioSuppressedBySolo(project, mainState)}
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
            suppressedBySolo={isAudioSuppressedBySolo(project, state)}
            onRemove={() => removeAudioTrack(track.id)}
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
        />
      ))}
    </>
  )
}