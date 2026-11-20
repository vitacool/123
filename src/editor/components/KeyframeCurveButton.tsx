import { useState } from 'react'
import type { AnimatableProperty, Clip } from '../core/types'
import { CurvePopover } from './CurvePopover'

/**
 * 属性行里的「曲线」入口（菱形左侧）：有关键帧时可点，打开该属性的曲线预览浮层。
 */
export function KeyframeCurveButton({ prop, clip }: { prop: AnimatableProperty; clip: Clip }) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const hasKeys = (clip.anim?.[prop]?.length ?? 0) > 0

  return (
    <>
      <button
        type="button"
        className="kf-curve-button"
        disabled={!hasKeys}
        aria-label={hasKeys ? '查看该属性的曲线' : '该属性暂无关键帧'}
        title={hasKeys ? '查看曲线（含关键帧点与缓动形状）' : '先打一个关键帧才能看曲线'}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          setAnchor({ x: rect.left - 240, y: rect.bottom + 6 })
        }}
      >
        <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M1.5 13.5C4 13.5 5 3 8 3s3.5 6 6.5 6"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
          />
        </svg>
      </button>
      {anchor && (
        <CurvePopover
          x={anchor.x}
          y={anchor.y}
          clip={clip}
          prop={prop}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  )
}