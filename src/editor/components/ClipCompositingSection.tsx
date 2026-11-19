import {
  blendModeLabel,
  BLEND_MODES,
  clipBlendMode,
  clipOpacity,
} from '../core/blend'
import type { BlendMode, Clip } from '../core/types'
import { CommitNumber } from './Toast'
import { CommitSlider } from './CommitSlider'

interface ClipCompositingSectionProps {
  clip: Clip
  onOpacity: (value: number) => void
  onBlendMode: (mode: BlendMode) => void
  /** 拖动中的实时预览（走临时预览通道，不写历史）。 */
  onPreviewOpacity?: (value: number) => void
  /** 由父级 PanelSection 提供标题与重置，组件只渲染内容。 */
  bare?: boolean
}

/**
 * 「画面」区的合成参数：不透明度与混合模式。
 * 预览用 Canvas globalAlpha / globalCompositeOperation，导出用
 * colorchannelmixer=aa= 与 blend 滤镜，两边取同一张映射表。
 */
export function ClipCompositingSection({
  clip,
  onOpacity,
  onBlendMode,
  onPreviewOpacity,
  bare,
}: ClipCompositingSectionProps) {
  const opacity = clipOpacity(clip)
  const mode = clipBlendMode(clip)
  const percent = Math.round(opacity * 100)

  return (
    <section className={`panel-section${bare ? ' is-bare' : ''}`}>
      {!bare && (
        <div className="section-title">
          <span>画面 · 不透明度</span>
          <span className="section-hint">0 – 100%</span>
        </div>
      )}
      <div className="control-with-field">
        <CommitSlider
          value={percent}
          min={0}
          max={100}
          step={1}
          ariaLabel="片段不透明度"
          onPreview={(value) => onPreviewOpacity?.(value / 100)}
          onCommit={(value) => onOpacity(value / 100)}
          format={(value) => `${Math.round(value)}%`}
        />
        <CommitNumber
          value={percent}
          min={0}
          max={100}
          step={1}
          unit="%"
          ariaLabel="片段不透明度百分比"
          onPreview={(value) => onPreviewOpacity?.(value / 100)}
          onCommit={(value) => onOpacity(value / 100)}
        />
      </div>

      {!bare && (
        <div className="section-title">
          <span>混合模式</span>
        </div>
      )}
      <label className="select-field">
        <select
          value={mode}
          aria-label="混合模式"
          onChange={(event) => onBlendMode(event.target.value as BlendMode)}
        >
          {BLEND_MODES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <p className="control-note">
        当前：{blendModeLabel(mode)}。混合模式与下方叠加层的画面合成，主轨片段仅受不透明度影响。
      </p>
    </section>
  )
}