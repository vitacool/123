import { Icon } from './Icon'
import { CommitNumber } from './Toast'
import { CommitSlider } from './CommitSlider'
import {
  clipTransitionOut,
  maxTransitionDuration,
  TRANSITION_MAX_DURATION,
  TRANSITION_MIN_DURATION,
  TRANSITION_TYPES,
  transitionLabel,
} from '../core/transition'
import type { Clip, TransitionType } from '../core/types'

interface ClipTransitionSectionProps {
  clip: Clip
  /** 同一轨道上的下一个片段（没有则为 null）。 */
  next: Clip | null
  /** 主轨锁定 / 正在裁剪时整体禁用。 */
  disabled?: boolean
  onSet: (type: TransitionType, duration: number) => void
  onClear: () => void
  /** 闭合「本片段 → 下一片段」之间的空隙（把 next.gapBefore 归零）。 */
  onCloseGap: () => void
  /** 把当前类型/时长应用到所有可用交界（一个命令）。 */
  onApplyAll: () => void
  /** 工程里是否存在可尝试的交界（至少两段）。 */
  canApplyAll: boolean
  /** 整体不可用的原因（例如叠加轨片段：转场只作用于主轨）。 */
  unavailableReason?: string
}

const round = (value: number, digits = 1): number => Number(value.toFixed(digits))

/**
 * 「转场」tab：状态条 + 5 种类型的可视化网格 + 时长 + 批量操作。
 * 状态条负责把「为什么不能设置」讲清楚，不能设置时所有控件置灰。
 */
export function ClipTransitionSection({
  clip,
  next,
  disabled,
  onSet,
  onClear,
  onCloseGap,
  onApplyAll,
  canApplyAll,
  unavailableReason,
}: ClipTransitionSectionProps) {
  const current = clipTransitionOut(clip)
  const isLast = !next
  const gap = Math.max(0, next?.gapBefore ?? 0)
  const hasGap = !isLast && gap > 0.0001
  const nextIsFreeze = next?.type === 'freeze'
  const limit = next ? maxTransitionDuration(clip, next) : 0
  const limitTooSmall = !isLast && !nextIsFreeze && limit < TRANSITION_MIN_DURATION

  // 上限 = min(2s, 相邻较短片段的一半)；没有相邻片段时退回 2s 供 UI 展示。
  const maxDuration = Math.max(
    TRANSITION_MIN_DURATION,
    Math.min(TRANSITION_MAX_DURATION, limit > 0 ? limit : TRANSITION_MAX_DURATION),
  )
  const duration = current
    ? Math.min(current.duration, maxDuration)
    : Math.min(0.4, maxDuration)

  const blocked =
    Boolean(disabled) ||
    Boolean(unavailableReason) ||
    isLast ||
    hasGap ||
    nextIsFreeze ||
    limitTooSmall
  const limitLimited = !nextIsFreeze && limit >= TRANSITION_MIN_DURATION
    && limit < TRANSITION_MAX_DURATION - 1e-6

  const status = unavailableReason
    ? { tone: 'is-blocked' as const, text: unavailableReason }
    : isLast
      ? { tone: 'is-muted' as const, text: '已是最后一个片段' }
      : hasGap
        ? { tone: 'is-blocked' as const, text: '与下一片段之间有空隙，转场不生效' }
        : nextIsFreeze
          ? { tone: 'is-blocked' as const, text: '下一片段是定格片段，不支持转场' }
          : limitTooSmall
            ? { tone: 'is-blocked' as const, text: '两侧片段太短，放不下转场' }
            : {
                tone: 'is-ok' as const,
                text: current
                  ? `与下一片段相接 · ${transitionLabel(current.type)} ${round(duration)}s`
                  : '与下一片段相接',
              }

  return (
    <div className="transition-tab">
      <div className={`transition-status ${status.tone}`} role="status">
        <span className="transition-status-text">
          <Icon name={status.tone === 'is-ok' ? 'check' : 'warning'} size={13} />
          <span>{status.text}</span>
        </span>
        {hasGap && !disabled && (
          <button
            type="button"
            className="button mini transition-gap-fix"
            onClick={onCloseGap}
            title="把下一片段的 gapBefore 归零（可撤销）"
          >
            闭合空隙
          </button>
        )}
      </div>
      {isLast && (
        <p className="control-note">
          转场作用在两个片段的交界，请选中前一个片段。
        </p>
      )}

      <div className="transition-grid" role="radiogroup" aria-label="转场类型">
        {TRANSITION_TYPES.map((item) => {
          const active = current?.type === item.value
          return (
            <button
              key={item.value}
              type="button"
              role="radio"
              aria-checked={active}
              className={`transition-card${active ? ' is-active' : ''}`}
              disabled={blocked}
              title={item.label}
              onClick={() => onSet(item.value, duration)}
            >
              <span
                className={`transition-thumb is-${item.value}`}
                aria-hidden="true"
              />
              <span className="transition-card-label">{item.label}</span>
            </button>
          )
        })}
      </div>

      <div className="control-with-field transition-duration">
        <CommitSlider
          value={duration}
          min={TRANSITION_MIN_DURATION}
          max={maxDuration}
          step={0.1}
          ariaLabel="转场时长"
          disabled={blocked || !current}
          // 转场时长不影响片段几何/宽度，拖动时只需要数值回显，不需要预览补丁。
          onPreview={() => undefined}
          onCommit={(value) => onSet(current?.type ?? 'fade', value)}
          format={(value) => `${value.toFixed(1)}s`}
        />
        <CommitNumber
          value={round(duration)}
          min={TRANSITION_MIN_DURATION}
          max={maxDuration}
          step={0.1}
          unit="s"
          ariaLabel="转场时长（秒）"
          disabled={blocked || !current}
          onCommit={(value) => onSet(current?.type ?? 'fade', value)}
        />
      </div>
      {limitLimited && (
        <p className="control-note">
          最长 {maxDuration.toFixed(1)}s（受相邻片段长度限制）
        </p>
      )}
      {!current && !blocked && (
        <p className="control-note">选择一种转场后即可调整时长。</p>
      )}

      <div className="inline-actions transition-actions">
        <button
          type="button"
          className="button mini"
          disabled={Boolean(disabled) || !current}
          onClick={onClear}
        >
          清除转场
        </button>
        <button
          type="button"
          className="button mini"
          disabled={Boolean(disabled) || !canApplyAll}
          onClick={onApplyAll}
          title="把当前类型与时长应用到主轨所有可用交界（跳过空隙 / 定格 / 末尾）"
        >
          应用到所有交界
        </button>
      </div>
    </div>
  )
}