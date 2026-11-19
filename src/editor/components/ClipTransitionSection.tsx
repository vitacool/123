import type { Clip, TransitionType } from '../core/types'
import {
  clampTransitionDuration,
  maxTransitionDuration,
  TRANSITION_MAX_DURATION,
  TRANSITION_MIN_DURATION,
  TRANSITION_TYPES,
} from '../core/transition'
import { CommitNumber } from './Toast'

interface ClipTransitionSectionProps {
  clip: Clip
  /** 下一个片段（没有则为 null，此时无法加转场）。 */
  next: Clip | null
  onChange: (type: TransitionType | null, duration: number) => void
  /** 由父级 PanelSection 提供标题与重置，组件只渲染内容。 */
  bare?: boolean
}

/**
 * 「转场」区：作用于本片段与下一片段的交界。
 * 时长上限 = min(2s, 两侧较短片段的一半)；两段之间有间隙时不可用。
 */
export function ClipTransitionSection({ clip, next, onChange, bare }: ClipTransitionSectionProps) {
  const current = clip.transitionOut ?? null
  const gap = Math.max(0, next?.gapBefore ?? 0)
  const limit = next ? maxTransitionDuration(clip, next) : 0
  const blocked = !next || gap > 0.0001 || limit < TRANSITION_MIN_DURATION
  const duration = current
    ? Math.min(clampTransitionDuration(current.duration), limit || TRANSITION_MAX_DURATION)
    : Math.min(0.4, limit || TRANSITION_MAX_DURATION)
  const maxFade = Math.max(TRANSITION_MIN_DURATION, Math.round(limit * 10) / 10)

  return (
    <section className={`panel-section${bare ? ' is-bare' : ''}`}>
      {!bare && (
        <div className="section-title">
          <span>转场（与下一片段）</span>
          <span className="section-hint">0.1 – 2s</span>
        </div>
      )}

      <label className="select-field">
        <select
          value={current?.type ?? 'none'}
          aria-label="转场类型"
          disabled={blocked && !current}
          onChange={(event) => {
            const value = event.target.value
            if (value === 'none') onChange(null, duration)
            else onChange(value as TransitionType, duration)
          }}
        >
          <option value="none">无转场</option>
          {TRANSITION_TYPES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </label>

      <div className="position-grid">
        <label>
          <span>时长</span>
          <CommitNumber
            value={Math.round(duration * 10) / 10}
            min={TRANSITION_MIN_DURATION}
            max={maxFade}
            step={0.1}
            unit="s"
            ariaLabel="转场时长"
            onCommit={(value) => {
              if (!current) return
              onChange(current.type, value)
            }}
          />
        </label>
      </div>

      {blocked ? (
        <p className="control-note">
          {!next
            ? '本片段之后没有相邻片段，无法添加转场。'
            : gap > 0.0001
              ? '两段之间存在空隙（gapBefore），请先移除空隙。'
              : '两侧片段太短，放不下转场。'}
        </p>
      ) : (
        <p className="control-note">
          最长 {maxFade}s（不超过两侧较短片段的一半）。转场会让两段重叠，成片总时长相应缩短。
        </p>
      )}
    </section>
  )
}