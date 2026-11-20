import { useMemo } from 'react'
import { evalAnimation } from '../core/animation'
import { propertyBaseValue } from '../core/keyframes'
import { ANIMATABLE_LABELS } from './keyframeLabels'
import type { AnimatableProperty, Clip } from '../core/types'
import { useEditorStore } from '../store/EditorProvider'
import { useDismiss, useFloatingPosition } from './floating'

const WIDTH = 260
const HEIGHT = 120
const PADDING = 12
const SAMPLES = 60

export interface CurvePopoverProps {
  x: number
  y: number
  clip: Clip
  prop: AnimatableProperty
  onClose: () => void
}

/**
 * 单属性曲线预览：横轴 = 片段进度 0…1，纵轴 = 该属性取值区间。
 * 折线用与预览/导出相同的求值函数采样 60 个点，因此与实际运动一致；
 * 叠加真实关键帧点，可以直观看出缓动造成的折角/平滑。
 */
export function CurvePopover({ x, y, clip, prop, onClose }: CurvePopoverProps) {
  const { ref, style } = useFloatingPosition(x, y)
  useDismiss(onClose)
  const clearPropertyKeyframes = useEditorStore((state) => state.clearPropertyKeyframes)

  const keys = clip.anim?.[prop] ?? []
  const base = propertyBaseValue(clip, prop)

  const chart = useMemo(() => {
    const values: number[] = []
    for (let index = 0; index < SAMPLES; index += 1) {
      const t = index / (SAMPLES - 1)
      values.push(evalAnimation(clip.anim?.[prop], t, base))
    }
    const keyValues = keys.map((key) => key.value)
    const all = [...values, ...keyValues, base]
    let min = Math.min(...all)
    let max = Math.max(...all)
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = 0
      max = 1
    }
    if (max - min < 1e-6) {
      min -= 0.5
      max += 0.5
    }
    const innerW = WIDTH - PADDING * 2
    const innerH = HEIGHT - PADDING * 2
    const toX = (t: number) => PADDING + t * innerW
    const toY = (value: number) => PADDING + innerH - ((value - min) / (max - min)) * innerH
    const polyline = values
      .map((value, index) => `${toX(index / (SAMPLES - 1)).toFixed(2)},${toY(value).toFixed(2)}`)
      .join(' ')
    const dots = keys.map((key) => ({ x: toX(key.t), y: toY(key.value), ease: key.ease }))
    return { polyline, dots, min, max, baseY: toY(base) }
  }, [clip.anim, prop, base, keys])

  return (
    <div
      ref={ref}
      className="kf-popover kf-curve-popover"
      style={{ position: 'fixed', left: style.left, top: style.top }}
      role="dialog"
      aria-label={`${ANIMATABLE_LABELS[prop]} 曲线`}
    >
      <p className="kf-popover-title">
        {ANIMATABLE_LABELS[prop]} · 曲线
        <span className="kf-curve-meta">{keys.length} 个关键帧</span>
      </p>
      <svg className="kf-curve" width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <rect x={0} y={0} width={WIDTH} height={HEIGHT} fill="rgba(0,0,0,0.04)" rx={6} />
        {/* 基础值参考线 */}
        <line
          x1={PADDING}
          y1={chart.baseY}
          x2={WIDTH - PADDING}
          y2={chart.baseY}
          stroke="rgba(92,77,54,0.35)"
          strokeDasharray="3 3"
        />
        <polyline points={chart.polyline} fill="none" stroke="var(--fc-accent)" strokeWidth={2} />
        {chart.dots.map((dot, index) => (
          <circle
            key={`${dot.x}-${index}`}
            cx={dot.x}
            cy={dot.y}
            r={3}
            fill={dot.ease === 'hold' ? 'var(--fc-gold)' : '#fdfaf3'}
            stroke="var(--fc-accent-deep)"
            strokeWidth={1.4}
          />
        ))}
      </svg>
      <div className="kf-curve-foot">
        <span className="kf-curve-range">
          {chart.min.toFixed(2)} → {chart.max.toFixed(2)}
        </span>
        <button
          type="button"
          className="button mini ghost-mini"
          disabled={keys.length === 0}
          onClick={() => {
            clearPropertyKeyframes(prop)
            onClose()
          }}
        >
          清空该属性的全部关键帧
        </button>
      </div>
    </div>
  )
}