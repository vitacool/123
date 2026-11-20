import { easeValue } from '../core/animation'
import type { Easing } from '../core/types'
import { useDismiss, useFloatingPosition } from './floating'

const OPTIONS: readonly { ease: Easing; label: string; hint: string }[] = [
  { ease: 'linear', label: '线性', hint: '匀速变化' },
  { ease: 'easeIn', label: '缓入', hint: '起步慢，越来越快' },
  { ease: 'easeOut', label: '缓出', hint: '起步快，收尾慢' },
  { ease: 'easeInOut', label: '缓入缓出', hint: '两端慢，中间快' },
  { ease: 'hold', label: '保持（阶跃）', hint: '保持上一帧，到点才跳变' },
]

/** 24×18 的缓动示意折线：用与求值函数相同的公式采样 12 个点。 */
function curvePoints(ease: Easing): string {
  const width = 24
  const height = 18
  const samples = 12
  const points: string[] = []
  for (let index = 0; index < samples; index += 1) {
    const p = index / (samples - 1)
    const value = ease === 'hold' ? (p < 1 ? 0 : 1) : easeValue(ease, p)
    const x = p * width
    const y = height - value * height
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`)
  }
  return points.join(' ')
}

export interface EasingPopoverProps {
  x: number
  y: number
  /** 选中关键帧当前共有的缓动；不一致时为 null。 */
  current: Easing | null
  /** 本次会应用到的关键帧数量。 */
  count: number
  onPick: (ease: Easing) => void
  onClose: () => void
}

/** 缓动选择浮层：5 个选项，各带一条示意曲线。 */
export function EasingPopover({ x, y, current, count, onPick, onClose }: EasingPopoverProps) {
  const { ref, style } = useFloatingPosition(x, y)
  useDismiss(onClose)

  return (
    <div
      ref={ref}
      className="kf-popover kf-easing-popover"
      style={{ position: 'fixed', left: style.left, top: style.top }}
      role="dialog"
      aria-label="选择缓动"
    >
      <p className="kf-popover-title">
        缓动{count > 1 ? `（${count} 个关键帧）` : ''}
      </p>
      <ul className="kf-easing-list">
        {OPTIONS.map((option) => (
          <li key={option.ease}>
            <button
              type="button"
              className={`kf-easing-option${current === option.ease ? ' is-active' : ''}`}
              onClick={() => {
                onPick(option.ease)
                onClose()
              }}
            >
              <svg className="kf-easing-curve" width={24} height={18} viewBox="0 0 24 18" aria-hidden="true">
                <polyline points={curvePoints(option.ease)} fill="none" stroke="currentColor" strokeWidth={1.6} />
              </svg>
              <span className="kf-easing-name">{option.label}</span>
              <span className="kf-easing-hint">{option.hint}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}