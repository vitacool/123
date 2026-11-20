import { hasVolumeAnimation } from '../core/animation'
import { clipFadeIn, clipFadeOut, clipVolume } from '../core/clipAudio'
import { clipTimelineDuration } from '../core/clipTime'
import type { Clip } from '../core/types'
import { useEditorStore } from '../store/EditorProvider'
import { CommitNumber } from './Toast'
import { CommitSlider } from './CommitSlider'
import { KeyframeButton } from './KeyframeButton'

interface ClipAudioSectionProps {
  clip: Clip
  /** 提交一次修改（由父组件包装成 EditorCommand）。 */
  onCommit: (patch: Partial<Pick<Clip, 'volume' | 'fadeIn' | 'fadeOut'>>, label: string) => void
  /** 拖动中的实时预览（走临时预览通道，不写历史）。 */
  onPreview?: (patch: Partial<Pick<Clip, 'volume' | 'fadeIn' | 'fadeOut'>>) => void
  /** 分离音频（可选；主轨/叠加轨视频片段提供）。 */
  onDetachAudio?: () => void
  detachDisabled?: boolean
  /** 由父级 PanelSection 提供标题与重置，组件只渲染内容。 */
  bare?: boolean
}

/**
 * 视频片段的「音频」区：音量与淡入淡出，UI 与音频轨片段的属性面板保持一致
 * （滑块 + 数字输入），音频参数与预览/导出共用 clipAudio 的同一套计算。
 */
export function ClipAudioSection({
  clip,
  onCommit,
  onPreview,
  onDetachAudio,
  detachDisabled,
  bare,
}: ClipAudioSectionProps) {
  const duration = clipTimelineDuration(clip)
  const maxFade = Math.max(0, Math.round(Math.min(duration, 10) * 10) / 10)
  const volumePercent = Math.round(clipVolume(clip) * 100)
  const setAnimatableValue = useEditorStore((state) => state.setAnimatableValue)
  const hasVolumeCurve = hasVolumeAnimation(clip)
  const fadeEnabled = clipFadeIn(clip) > 0.001 || clipFadeOut(clip) > 0.001

  return (
    <>
      <section className={`panel-section${bare ? ' is-bare' : ''}`}>
        {!bare && (
          <div className="section-title">
            <span>音频 · 片段音量</span>
            <span className="section-hint">0 – 200%</span>
          </div>
        )}
        <div className="control-with-field">
          <CommitSlider
            value={volumePercent}
            min={0}
            max={200}
            step={1}
            ariaLabel="片段音量"
            onPreview={(value) => onPreview?.({ volume: value / 100 })}
            onCommit={(value) => setAnimatableValue('volume', value / 100)}
            format={(value) => `${Math.round(value)}%`}
          />
          <CommitNumber
            value={volumePercent}
            min={0}
            max={200}
            step={1}
            unit="%"
            ariaLabel="片段音量百分比"
            onPreview={(value) => onPreview?.({ volume: value / 100 })}
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

      <section className={`panel-section${bare ? ' is-bare' : ''}`}>
        {!bare && (
          <div className="section-title">
            <span>音频 · 淡入 / 淡出</span>
            <span className="section-hint">0 – {maxFade}s</span>
          </div>
        )}
        <div className="position-grid">
          <label>
            <span>淡入</span>
            <CommitNumber
              value={Math.round(clipFadeIn(clip) * 10) / 10}
              min={0}
              max={maxFade}
              step={0.1}
              unit="s"
              ariaLabel="片段淡入"
              onCommit={(value) => onCommit({ fadeIn: value }, '调整片段淡入')}
            />
          </label>
          <label>
            <span>淡出</span>
            <CommitNumber
              value={Math.round(clipFadeOut(clip) * 10) / 10}
              min={0}
              max={maxFade}
              step={0.1}
              unit="s"
              ariaLabel="片段淡出"
              onCommit={(value) => onCommit({ fadeOut: value }, '调整片段淡出')}
            />
          </label>
        </div>
        {onDetachAudio && (
          <div className="inline-actions">
            <button
              type="button"
              className="button mini"
              onClick={onDetachAudio}
              disabled={detachDisabled}
              title="把这段画面里的声音拆到一条独立音频轨，画面片段随之静音"
            >
              分离音频
            </button>
          </div>
        )}
      </section>
    </>
  )
}