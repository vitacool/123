import { FREEZE_MAX_DURATION } from '../core/constants'
import { audioClipDuration, getAudioActionAvailability } from '../core/audio'
import { formatClock } from '../core/format'
import type { AudioClip, AudioTrack } from '../core/types'
import { useEditorStore } from '../store/EditorProvider'
import { CommitNumber } from './Toast'
import { CommitSlider } from './CommitSlider'
import { Icon } from './Icon'

interface AudioPropertiesPanelProps {
  track: AudioTrack
  clip: AudioClip
}

export function AudioPropertiesPanel({ track, clip }: AudioPropertiesPanelProps) {
  const assets = useEditorStore((state) => state.assets)
  const project = useEditorStore((state) => state.project)
  const playhead = useEditorStore((state) => state.playhead)
  const splitAtPlayhead = useEditorStore((state) => state.splitAtPlayhead)
  const trimLeftAtPlayhead = useEditorStore((state) => state.trimLeftAtPlayhead)
  const trimRightAtPlayhead = useEditorStore((state) => state.trimRightAtPlayhead)
  const updateAudioClip = useEditorStore((state) => state.updateAudioClip)
  const setAudioTrackVolume = useEditorStore((state) => state.setAudioTrackVolume)
  const deleteAudioClip = useEditorStore((state) => state.deleteAudioClip)
  const selectClip = useEditorStore((state) => state.selectClip)
  const setPreviewPatch = useEditorStore((state) => state.setPreviewPatch)

  const asset = assets.find((item) => item.url === clip.sourceUrl)
  const duration = audioClipDuration(clip)
  const availability = getAudioActionAvailability(project, clip.id, playhead)
  const maxFade = Math.max(0.1, Math.min(FREEZE_MAX_DURATION, duration))
  const commit = (update: Partial<Omit<AudioClip, 'id'>>, label: string) => {
    updateAudioClip(track.id, clip.id, update, label)
  }

  return (
    <aside className="properties-panel" aria-label="音频属性">
      <div className="panel-head">
        <div>
          <p className="panel-eyebrow">音频属性</p>
          <h2>
            音频片段
            <span className="panel-index">{track.name}</span>
          </h2>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={() => selectClip(null)}
          aria-label="收起属性面板"
          title="收起属性面板"
        >
          <Icon name="close" size={16} />
        </button>
      </div>

      <div className="panel-scroll">
        <div className="clip-summary">
          <span className="type-pill audio">AUDIO</span>
          <span className="summary-duration">{formatClock(duration)}</span>
          <span className="summary-dot" />
          <span className="summary-meta">从 {formatClock(clip.start)} 开始</span>
        </div>

        <section className="panel-section">
          <div className="section-title">
            <span>剪辑</span>
            <span className="section-hint">播放头在片段内部时可用</span>
          </div>
          <div className="inline-actions">
            <button
              type="button"
              className="button mini"
              disabled={!availability.canSplit}
              onClick={splitAtPlayhead}
            >
              <Icon name="split" size={14} />
              分割
            </button>
            <button
              type="button"
              className="button mini"
              disabled={!availability.canTrimLeft}
              onClick={trimLeftAtPlayhead}
            >
              <Icon name="trimLeft" size={14} />
              左裁
            </button>
            <button
              type="button"
              className="button mini"
              disabled={!availability.canTrimRight}
              onClick={trimRightAtPlayhead}
            >
              <Icon name="trimRight" size={14} />
              右裁
            </button>
          </div>
        </section>

        <section className="panel-section">
          <div className="section-title">
            <span>素材</span>
            <span className="section-hint">音频</span>
          </div>
          <p className="control-note">{asset?.name ?? '音频素材'}</p>
          <dl className="property-list">
            <div>
              <dt>源入点</dt>
              <dd>{clip.sourceStart.toFixed(2)} s</dd>
            </div>
            <div>
              <dt>源出点</dt>
              <dd>{clip.sourceEnd.toFixed(2)} s</dd>
            </div>
            <div>
              <dt>时长</dt>
              <dd>{duration.toFixed(2)} s</dd>
            </div>
          </dl>
        </section>

        <section className="panel-section">
          <div className="section-title">
            <span>片段音量</span>
            <span className="section-hint">0 – 200%</span>
          </div>
          <div className="control-with-field">
            <CommitSlider
              value={clip.volume * 100}
              min={0}
              max={200}
              step={1}
              ariaLabel="音频片段音量"
              onPreview={(value) =>
                setPreviewPatch({ clipId: clip.id, patch: { volume: value / 100 } })
              }
              onCommit={(value) => commit({ volume: value / 100 }, '调整音频音量')}
              format={(value) => `${Math.round(value)}%`}
            />
            <CommitNumber
              value={Math.round(clip.volume * 100)}
              min={0}
              max={200}
              step={1}
              unit="%"
              ariaLabel="音频片段音量百分比"
              onPreview={(value) =>
                setPreviewPatch({ clipId: clip.id, patch: { volume: value / 100 } })
              }
              onCommit={(value) => commit({ volume: value / 100 }, '调整音频音量')}
            />
          </div>
        </section>

        <section className="panel-section">
          <div className="section-title">
            <span>淡入 / 淡出</span>
            <span className="section-hint">0 – {Math.round(maxFade * 10) / 10}s</span>
          </div>
          <div className="position-grid">
            <label>
              <span>淡入</span>
              <CommitNumber
                value={Math.round(clip.fadeIn * 10) / 10}
                min={0}
                max={maxFade}
                step={0.1}
                unit="s"
                ariaLabel="音频淡入"
                onCommit={(value) => commit({ fadeIn: value }, '调整音频淡入')}
              />
            </label>
            <label>
              <span>淡出</span>
              <CommitNumber
                value={Math.round(clip.fadeOut * 10) / 10}
                min={0}
                max={maxFade}
                step={0.1}
                unit="s"
                ariaLabel="音频淡出"
                onCommit={(value) => commit({ fadeOut: value }, '调整音频淡出')}
              />
            </label>
          </div>
        </section>

        <section className="panel-section">
          <div className="section-title">
            <span>轨道音量</span>
            <span className="section-hint">{track.name}</span>
          </div>
          <div className="control-with-field">
            <CommitSlider
              value={track.volume * 100}
              min={0}
              max={200}
              step={1}
              ariaLabel="音频轨音量"
              onPreview={(value) =>
                setPreviewPatch({
                  patch: {},
                  trackVolume: { trackId: track.id, volume: value / 100 },
                })
              }
              onCommit={(value) => setAudioTrackVolume(track.id, value / 100)}
              format={(value) => `${Math.round(value)}%`}
            />
          </div>
        </section>

        <section className="panel-section panel-danger">
          <button
            type="button"
            className="button delete-clip"
            onClick={() => deleteAudioClip(track.id, clip.id)}
          >
            <Icon name="trash" size={16} />
            删除音频片段
            <kbd>Delete</kbd>
          </button>
          <p className="control-note">删除后可用 Ctrl/⌘ + Z 恢复。</p>
        </section>
      </div>

      <div className="panel-foot">
        <Icon name="info" size={13} />
        音频会与视频原声混合导出。
      </div>
    </aside>
  )
}