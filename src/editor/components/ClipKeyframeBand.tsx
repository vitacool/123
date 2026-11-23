import { matchesPointer } from './pointerDrag'
import { useRef, useState, memo } from 'react'
import { keyframeUnion, refsAtTime, clampGroupDrag, type KeyframeRef } from '../core/keyframeEdit'
import { labelList } from './keyframeLabels'
import type { AnimationMap } from '../core/types'

export interface SnapCandidate {
  time: number
  label: string
}

export interface ClipKeyframeBandProps {
  clip: { id: string; anim?: AnimationMap }
  /** 片段在时间线上的起点（秒）与时长（秒）。 */
  clipStart: number
  duration: number
  /** 每秒像素。 */
  pps: number
  /** 当前选中的关键帧（只包含本片段的）。 */
  selected: readonly KeyframeRef[]
  /** 吸附候选点（时间线秒），由时间轴用与片段拖动相同的规则生成。 */
  snapCandidates: readonly SnapCandidate[]
  autoSnap: boolean
  onSelect: (refs: KeyframeRef[], additive: boolean) => void
  /** 提交拖动（父级走命令，1 步撤销）。 */
  onCommitMove: (refs: KeyframeRef[], deltaT: number) => void
  onRequestEasing: (refs: KeyframeRef[], x: number, y: number) => void
  onRequestMenu: (refs: KeyframeRef[], x: number, y: number) => void
}

const BAND_HEIGHT = 8
const DOT = 7
/** 与片段拖动一致的吸附阈值：12px。 */
const SNAP_PX = 12

const sameRef = (a: KeyframeRef, b: KeyframeRef): boolean =>
  a.prop === b.prop && Math.abs(a.t - b.t) < 5e-4

/**
 * 片段条底部的关键帧带：
 * - 画出所有属性的关键帧并集（同一位置只画一个菱形）；
 * - 点击选中 / Shift 追加；拖动改 t（先预览、松手才写命令）；双击改缓动；右键出菜单。
 *
 * 它作为 .clip-bar 的一个绝对定位子层（底部 8px），左右各内缩 10px 避开裁剪手柄。
 */
function ClipKeyframeBandInner({
  clip,
  clipStart,
  duration,
  pps,
  selected,
  snapCandidates,
  autoSnap,
  onSelect,
  onCommitMove,
  onRequestEasing,
  onRequestMenu,
}: ClipKeyframeBandProps) {
  const union = keyframeUnion(clip.anim)
  const [drag, setDrag] = useState<{
    refs: KeyframeRef[]
    deltaT: number
    rawT: number
    snapLabel: string | null
  } | null>(null)
  const dragRef = useRef<{ startX: number; anchorT: number; refs: KeyframeRef[]; pointerId: number } | null>(null)

  if (union.length === 0) return null

  const durationSafe = duration > 0 ? duration : 1
  const pxToT = (px: number): number => px / pps / durationSafe
  const snapThresholdT = SNAP_PX / pps / durationSafe

  /** 把拖动的目标 t 吸附到候选点（时间线秒 → 片段内 t）。 */
  const snapT = (targetT: number): { t: number; label: string | null } => {
    if (!autoSnap) return { t: targetT, label: null }
    let best: { t: number; label: string; distance: number } | null = null
    for (const candidate of snapCandidates) {
      const candidateT = (candidate.time - clipStart) / durationSafe
      if (candidateT < -0.001 || candidateT > 1.001) continue
      const distance = Math.abs(candidateT - targetT)
      if (distance <= snapThresholdT && (!best || distance < best.distance)) {
        best = { t: candidateT, label: candidate.label, distance }
      }
    }
    return best ? { t: best.t, label: best.label } : { t: targetT, label: null }
  }

  const beginDrag = (event: React.PointerEvent<HTMLElement>, t: number) => {
    if (event.button !== 0) return
    /**
     * 先 stopPropagation 再判断「这个时刻有没有关键帧」。
     *
     * 反过来（先 `if (refs.length === 0) return`）会让「按在菱形上但换算出的 t
     * 有偏差」的情况直接放行冒泡 —— 结果是想拖关键帧，却把整个片段拖走了。
     * 菱形本身就在带子里，按在它上面就不该穿透到片段。
     */
    event.stopPropagation()
    const refs = refsAtTime(clip.anim, t)
    if (refs.length === 0) return
    // 未选中就点它 → 先选中（与常见编辑器一致）
    const allSelected = refs.every((ref) => selected.some((item) => sameRef(item, ref)))
    if (!allSelected) onSelect(refs, event.shiftKey)
    const effective = allSelected && selected.length > refs.length ? [...selected] : refs
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    dragRef.current = { startX: event.clientX, anchorT: t, refs: effective, pointerId: event.pointerId }
    setDrag({ refs: effective, deltaT: 0, rawT: t, snapLabel: null })
  }

  const moveDrag = (event: React.PointerEvent<HTMLElement>) => {
    const current = dragRef.current
    if (!matchesPointer(current, event)) return
    event.stopPropagation()
    const rawDelta = pxToT(event.clientX - current.startX)
    const rawTarget = current.anchorT + rawDelta
    const snapped = snapT(Math.min(1, Math.max(0, rawTarget)))
    // 用吸附后的目标反推位移，再按「不越界 / 不与未选中帧重叠」夹取
    const delta = clampGroupDrag(clip.anim, current.refs, snapped.t - current.anchorT)
    setDrag({ refs: current.refs, deltaT: delta, rawT: snapped.t, snapLabel: snapped.label })
  }

  const endDrag = (event: React.PointerEvent<HTMLElement>) => {
    const current = dragRef.current
    if (!current) return
    dragRef.current = null
    if (Math.abs((drag?.deltaT ?? 0)) > 0.0005) {
      onCommitMove(current.refs, drag!.deltaT)
    }
    setDrag(null)
    try {
      ;(event.currentTarget as HTMLElement).releasePointerCapture(current.pointerId)
    } catch {
      // 指针已释放。
    }
  }

  const timeAt = (t: number): number => clipStart + t * durationSafe

  return (
    <span
      className="clip-keyframe-band"
      style={{ height: BAND_HEIGHT }}
      /**
       * 这里**不再** stopPropagation。
       *
       * 关键帧点自己的 `beginDrag` 已经 stopPropagation（第 93 行），所以在点上按下
       * 依然是拖关键帧、不会带动片段。但整条带子（片段底部 8px）以前是无条件拦截的，
       * 于是那条区域既拖不动片段、点了也选不中 —— 手感上像"片段底部是死的"。
       * 放行之后：空白处正常选中/拖动片段，点上仍然是关键帧交互。
       */
    >
      {union.map((point) => {
        const refs = refsAtTime(clip.anim, point.t)
        const isSelected = refs.some((ref) => selected.some((item) => sameRef(item, ref)))
        // 预览位移：该点上的关键帧是否属于当前拖动集合
        const inDrag = Boolean(drag && refs.some((ref) => drag.refs.some((item) => sameRef(item, ref))))
        const previewDelta = drag && inDrag ? drag.deltaT : 0
        const t = Math.min(1, Math.max(0, point.t + previewDelta))
        return (
          <span
            key={point.t}
            className={`clip-keyframe-dot${isSelected ? ' is-selected' : ''}${
              drag && previewDelta !== 0 ? ' is-dragging' : ''
            }`}
            role="button"
            tabIndex={0}
            aria-label={`关键帧 ${timeAt(point.t).toFixed(2)} 秒，${labelList(point.props)}`}
            title={`${timeAt(point.t).toFixed(2)}s · ${labelList(point.props)}`}
            style={{ left: `${t * 100}%`, width: DOT, height: DOT }}
            onPointerDown={(event) => beginDrag(event, point.t)}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={(event) => {
              event.stopPropagation()
              onRequestEasing(refs, event.clientX, event.clientY)
            }}
            onContextMenu={(event) => {
              event.preventDefault()
              event.stopPropagation()
              // 右键已选中的菱形时保留多选（否则会把多选替换成单选，批量改缓动就没意义了）
              const menuRefs = isSelected ? [...selected] : refs
              if (!isSelected) onSelect(refs, false)
              onRequestMenu(menuRefs, event.clientX, event.clientY)
            }}
          />
        )
      })}

      {drag && Math.abs(drag.deltaT) > 0.0001 && (
        <span className="clip-keyframe-drag-badge" style={{ left: `${Math.min(1, Math.max(0, drag.rawT)) * 100}%` }}>
          {timeAt(drag.rawT).toFixed(2)}s
          {drag.snapLabel ? ` · 吸附 ${drag.snapLabel}` : ''}
          {union.length > 0 ? ` · ${labelList(drag.refs.map((ref) => ref.prop).filter((prop, index, list) => list.indexOf(prop) === index))}` : ''}
        </span>
      )}
    </span>
  )
}
/** 关键帧条：只在关键帧本身变化时需要重绘，memo 掉父组件的无关重渲染。 */
export const ClipKeyframeBand = memo(ClipKeyframeBandInner)
