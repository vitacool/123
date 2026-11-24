import { useRef, useState } from 'react'
import { FREEZE_MAX_DURATION } from '../core/constants'
import { hasVolumeAnimation } from '../core/animation'
import { audioClipDuration, getAudioActionAvailability } from '../core/audio'
import { formatClock } from '../core/format'
import type { AudioClip, AudioTrack, FadeCurve } from '../core/types'
import { useEditorStore } from '../store/EditorProvider'
import { CommitNumber } from './Toast'
import { CommitSlider } from './CommitSlider'
import { Icon } from './Icon'
import { KeyframeButton } from './KeyframeButton'

interface AudioPropertiesPanelProps {
  track: AudioTrack
  clip: AudioClip
}

export function AudioPropertiesPanel({ track, clip }: AudioPropertiesPanelProps) {
  const assets = useEditorStore((state) => state.assets)
  const project = useEditorStore((state) => state.project)
  const playhead = useEditorStore((state) => state.playhead)
  const moveAudioClip = useEditorStore((state) => state.moveAudioClip)
  const replaceAudioClipSource = useEditorStore((state) => state.replaceAudioClipSource)
  const replaceInputRef = useRef<HTMLInputElement | null>(null)
  const [replacing, setReplacing] = useState(false)
  const splitAtPlayhead = useEditorStore((state) => state.splitAtPlayhead)
  const trimLeftAtPlayhead = useEditorStore((state) => state.trimLeftAtPlayhead)
  const trimRightAtPlayhead = useEditorStore((state) => state.trimRightAtPlayhead)
  const updateAudioClip = useEditorStore((state) => state.updateAudioClip)
  const setAnimatableValue = useEditorStore((state) => state.setAnimatableValue)
  const setAudioTrackVolume = useEditorStore((state) => state.setAudioTrackVolume)
  const deleteAudioClip = useEditorStore((state) => state.deleteAudioClip)
  const selectClip = useEditorStore((state) => state.selectClip)
  const setPreviewPatch = useEditorStore((state) => state.setPreviewPatch)

  const asset = assets.find((item) => item.url === clip.sourceUrl)
  const duration = audioClipDuration(clip)
  const availability = getAudioActionAvailability(project, clip.id, playhead)
  const maxFade = Math.max(0.1, Math.min(FREEZE_MAX_DURATION, duration))
  const hasVolumeCurve = hasVolumeAnimation(clip)
  const fadeEnabled = clip.fadeIn > 0.001 || clip.fadeOut > 0.001
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
            <span>位置</span>
            <span className="section-hint">秒</span>
          </div>
          <div className="control-with-field">
            <span className="section-hint">开始</span>
            <CommitNumber
              value={Number(clip.start.toFixed(2))}
              min={0}
              max={86400}
              step={0.1}
              unit="s"
              ariaLabel="音频开始时间"
              onCommit={(value) => moveAudioClip(track.id, clip.id, value)}
            />
          </div>
        </section>

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
          <div className="inline-actions">
            <button
              type="button"
              className="button mini"
              disabled={replacing}
              onClick={() => replaceInputRef.current?.click()}
            >
              {replacing ? '正在读取素材…' : '替换素材…'}
            </button>
          </div>
          <input
            ref={replaceInputRef}
            type="file"
            accept="audio/*,video/*,.mp3,.wav,.m4a,.aac,.flac,.mp4,.mov,.webm"
            hidden
            onChange={async (event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (!file) return
              setReplacing(true)
              try {
                await replaceAudioClipSource(track.id, clip.id, file)
              } finally {
                setReplacing(false)
              }
            }}
          />
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
              onCommit={(value) => setAnimatableValue('volume', value / 100)}
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
              onCommit={(value) => setAnimatableValue('volume', value / 100)}
            />
            <KeyframeButton prop="volume" clip={clip} />
          </div>
          {hasVolumeCurve && fadeEnabled && (
            <p className="control-note keyframe-fade-warning">
              淡入淡出会叠加在音量曲线上
            </p>
          )}
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
          <div className="position-grid">
            <label>
              <span>淡入曲线</span>
              <select
                value={clip.fadeInCurve ?? 'linear'}
                aria-label="音频淡入曲线"
                onChange={(event) =>
                  commit({ fadeInCurve: event.target.value as FadeCurve }, '调整音频淡入曲线')
                }
              >
                <option value="linear">线性</option>
                <option value="exp">指数</option>
                <option value="log">对数</option>
              </select>
            </label>
            <label>
              <span>淡出曲线</span>
              <select
                value={clip.fadeOutCurve ?? 'linear'}
                aria-label="音频淡出曲线"
                onChange={(event) =>
                  commit({ fadeOutCurve: event.target.value as FadeCurve }, '调整音频淡出曲线')
                }
              >
                <option value="linear">线性</option>
                <option value="exp">指数</option>
                <option value="log">对数</option>
              </select>
            </label>
          </div>
        </section>

        <section className="panel-section">
          <div className="section-title">
            <span>变速</span>
            <span className="section-hint">0.1 – 10x</span>
          </div>
          <div className="control-with-field">
            <CommitSlider
              value={Number((clip.speed ?? 1).toFixed(2))}
              min={0.1}
              max={10}
              step={0.05}
              ariaLabel="音频变速"
              onPreview={() => undefined}
              onCommit={(value) => commit({ speed: value }, '调整音频变速')}
              format={(value) => `${Number(value.toFixed(2))}x`}
            />
            <CommitNumber
              value={Number((clip.speed ?? 1).toFixed(2))}
              min={0.1}
              max={10}
              step={0.05}
              unit="x"
              ariaLabel="音频变速数值"
              onCommit={(value) => commit({ speed: value }, '调整音频变速')}
            />
          </div>
          <label className="control-toggle">
            <input
              type="checkbox"
              checked={clip.keepPitch !== false}
              onChange={(event) =>
                commit({ keepPitch: event.target.checked }, '切换音频保调')
              }
            />
            保持音调
          </label>
          <p className="control-note">
            时长 = 源跨度 ÷ 倍率；分割/裁剪会按倍率换算源区间。导出用 atempo 保音高。
          </p>
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