import { useEffect, useState } from 'react'
import { clipTimelineDurationAt } from '../core/clipTime'
import {
  clampSpeed,
  clipKeepsPitch,
  clipSpeedValue,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_PRESETS,
} from '../core/speed'
import type { Clip } from '../core/types'
import { CommitNumber } from './Toast'
import { CommitSlider } from './CommitSlider'

interface ClipSpeedSectionProps {
  clip: Clip
  /** 提交（松手时调用，产生 1 个撤销步骤）。 */
  onChange: (speed: number, keepPitch: boolean) => void
  /** 拖动中的实时预览（不产生撤销步骤）。 */
  onPreview?: (speed: number) => void
  /** 由父级 PanelSection 提供标题与重置，组件只渲染内容。 */
  bare?: boolean
}

/**
 * 片段「变速」区：倍率滑块 + 数字输入 + 常用档位，并显示变速后的时长。
 * 时间轴片段宽度、分割/裁剪换算、字幕联动均由 clipTime 按 speed 计算。
 */
export function ClipSpeedSection({ clip, onChange, onPreview, bare }: ClipSpeedSectionProps) {
  const speed = clipSpeedValue(clip)
  const keepPitch = clipKeepsPitch(clip)
  // 拖动中的本地倍率：让「变速后时长」跟随手指实时变化，不写工程状态。
  const [liveSpeed, setLiveSpeed] = useState<number | null>(null)
  const shownSpeed = liveSpeed ?? speed
  const duration = clipTimelineDurationAt(clip, shownSpeed)
  const sourceSpan = Math.max(0, clip.sourceEnd - clip.sourceStart)

  // 外部值变化（撤销/重做、切换片段）时丢弃本地预览值。
  useEffect(() => {
    setLiveSpeed(null)
  }, [speed, clip.id])

  return (
    <section className={`panel-section${bare ? ' is-bare' : ''}`}>
      {!bare && (
        <div className="section-title">
          <span>变速</span>
          <span className="section-hint">
            {SPEED_MIN}x – {SPEED_MAX}x
          </span>
        </div>
      )}

      <div className="control-with-field">
        <CommitSlider
          value={shownSpeed}
          min={SPEED_MIN}
          max={SPEED_MAX}
          step={0.05}
          ariaLabel="片段倍率"
          onPreview={(value) => {
            const next = clampSpeed(value)
            setLiveSpeed(next)
            onPreview?.(next)
          }}
          onCommit={(value) => {
            setLiveSpeed(null)
            onChange(clampSpeed(value), keepPitch)
          }}
          format={(value) => `${Number(value.toFixed(2))}x`}
        />
        <CommitNumber
          value={Math.round(shownSpeed * 100) / 100}
          min={SPEED_MIN}
          max={SPEED_MAX}
          step={0.05}
          unit="x"
          ariaLabel="片段倍率数值"
          onCommit={(value) => onChange(clampSpeed(value), keepPitch)}
        />
      </div>

      <div className="speed-presets">
        {SPEED_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className={`speed-preset${Math.abs(shownSpeed - preset) < 1e-6 ? ' is-active' : ''}`}
            aria-pressed={Math.abs(shownSpeed - preset) < 1e-6}
            onClick={() => {
              setLiveSpeed(null)
              onChange(preset, keepPitch)
            }}
          >
            {preset}x
          </button>
        ))}
      </div>

      <label className="toggle-row">
        <input
          type="checkbox"
          checked={keepPitch}
          onChange={(event) => onChange(speed, event.target.checked)}
        />
        <span>保持音调（关闭后变速会连带改变音高）</span>
      </label>

      <dl className="freeze-summary speed-summary">
        <dt>源时长</dt>
        <dd>{sourceSpan.toFixed(2)} s</dd>
        <dt>变速后时长</dt>
        <dd>{duration.toFixed(2)} s</dd>
      </dl>
    </section>
  )
}