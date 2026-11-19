import { CommitNumber } from './Toast'
import { CommitSlider } from './CommitSlider'
import {
  COLOR_MAX,
  COLOR_MIN,
  clipColor,
  isNeutralColor,
  type ColorAdjustments,
} from '../core/color'
import type { Clip } from '../core/types'

interface ClipColorSectionProps {
  clip: Clip
  /** 主轨锁定 / 正在裁剪时禁用。 */
  disabled?: boolean
  /** 「复制当前设置」存下来的参数，用于「粘贴调色」。 */
  clipboard: ColorAdjustments | null
  /** 拖动中的实时预览（不写历史）。 */
  onPreview: (color: ColorAdjustments) => void
  /** 松手提交（1 步撤销）。 */
  onChange: (color: ColorAdjustments) => void
  onReset: () => void
  onApplyAll: () => void
  onCopy: () => void
  onPaste: () => void
}

const ROWS: readonly {
  key: keyof ColorAdjustments
  label: string
  ariaLabel: string
}[] = [
  { key: 'brightness', label: '亮度', ariaLabel: '亮度' },
  { key: 'contrast', label: '对比度', ariaLabel: '对比度' },
  { key: 'saturation', label: '饱和度', ariaLabel: '饱和度' },
  { key: 'temperature', label: '色温', ariaLabel: '色温' },
]

const round = (value: number): number => Math.round(value)

/**
 * 「调节」tab：亮度 / 对比度 / 饱和度 / 色温 四条滑块 + 重置 / 应用到全部 / 复制 / 粘贴。
 * 拖动走 previewPatch 实时预览，松手才提交成 1 个命令。
 */
export function ClipColorSection({
  clip,
  disabled,
  clipboard,
  onPreview,
  onChange,
  onReset,
  onApplyAll,
  onCopy,
  onPaste,
}: ClipColorSectionProps) {
  const color = clipColor(clip)
  const neutral = isNeutralColor(color)

  return (
    <div className="color-tab">
      {ROWS.map((row) => {
        const value = color[row.key]
        return (
          <div
            key={row.key}
            className={`color-row${row.key === 'temperature' ? ' is-temperature' : ''}`}
          >
            <span className="color-label">{row.label}</span>
            <CommitSlider
              value={value}
              min={COLOR_MIN}
              max={COLOR_MAX}
              step={1}
              ariaLabel={row.ariaLabel}
              disabled={disabled}
              onPreview={(next) => onPreview({ ...color, [row.key]: next })}
              onCommit={(next) => onChange({ ...color, [row.key]: next })}
              format={(next) => String(round(next))}
            />
            <CommitNumber
              value={value}
              min={COLOR_MIN}
              max={COLOR_MAX}
              step={1}
              ariaLabel={`${row.ariaLabel}数值`}
              disabled={disabled}
              onPreview={(next) => onPreview({ ...color, [row.key]: next })}
              onCommit={(next) => onChange({ ...color, [row.key]: next })}
            />
          </div>
        )
      })}

      <div className="inline-actions color-actions">
        <button
          type="button"
          className="button mini"
          disabled={disabled || neutral}
          onClick={onReset}
          title="四项全部回到 0（可撤销）"
        >
          重置
        </button>
        <button
          type="button"
          className="button mini"
          disabled={disabled}
          onClick={onApplyAll}
          title="把当前四项参数应用到所有画面片段（可撤销）"
        >
          应用到全部片段
        </button>
      </div>
      <div className="inline-actions color-actions">
        <button
          type="button"
          className="button mini ghost-mini"
          disabled={disabled}
          onClick={onCopy}
          title="把这四项参数放进剪贴板，供其他片段粘贴"
        >
          复制当前设置
        </button>
        <button
          type="button"
          className="button mini ghost-mini"
          disabled={disabled || !clipboard}
          onClick={onPaste}
          title="粘贴刚才复制的调色参数（可撤销）"
        >
          粘贴调色
        </button>
      </div>
      <p className="control-note">
        调色只影响该片段画面；预览与导出共用同一组参数。
      </p>
    </div>
  )
}