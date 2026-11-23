import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  SPEED_CURVE_POINT_MAX,
  SPEED_CURVE_POINT_MIN,
  SPEED_MAX,
  SPEED_MIN,
  clampSpeed,
  createFlatSpeedCurve,
  evalSpeedCurve,
} from '../core/speed'

/** 曲线控制点：`at` 是片段进度 0…1，`speed` 是该处的播放倍率。 */
export interface SpeedCurvePoint {
  at: number
  speed: number
}

interface SpeedCurveEditorProps {
  /** 已归一化的控制点（至少 2 个；编辑器按 3–5 个来增减）。 */
  curve: SpeedCurvePoint[]
  disabled?: boolean
  /** 拖动过程中持续回调（写 previewPatch，实时预览）。 */
  onPreview: (curve: SpeedCurvePoint[]) => void
  /** 松手 / 键盘调整结束时回调（写命令，一步撤销）。 */
  onCommit: (curve: SpeedCurvePoint[]) => void
}

const WIDTH = 280
/**
 * 画布高度决定拖动的「细腻度」：纵轴是 0.1–10x 的对数刻度，像素越少
 * 同样的拖动位移换算出的倍率跳得越猛（138px 时 40px ≈ 5x）。
 */
const HEIGHT = 168
const PAD_LEFT = 30
const PAD_RIGHT = 10
const PAD_TOP = 12
const PAD_BOTTOM = 18
/** 相邻控制点的最小水平间距（占片段进度的比例）。 */
const MIN_GAP = 0.02
/** 画曲线的采样数（越密越平滑，与导出用的 16 段采样互相独立）。 */
const SAMPLES = 80
/** 纵轴网格：对数刻度下 1x 居中，0.1–10 对称。 */
const GRID_SPEEDS = [0.25, 0.5, 1, 2, 4]

const INNER_W = WIDTH - PAD_LEFT - PAD_RIGHT
const INNER_H = HEIGHT - PAD_TOP - PAD_BOTTOM
const LOG_MIN = Math.log(SPEED_MIN)
const LOG_MAX = Math.log(SPEED_MAX)

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const atToX = (at: number): number => PAD_LEFT + clamp(at, 0, 1) * INNER_W

/** 速度 → 纵坐标（对数刻度：0.1x 在底、1x 居中、10x 在顶）。 */
const speedToY = (speed: number): number => {
  const ratio = (Math.log(clampSpeed(speed)) - LOG_MIN) / (LOG_MAX - LOG_MIN)
  return PAD_TOP + (1 - ratio) * INNER_H
}

const xToAt = (x: number): number => clamp((x - PAD_LEFT) / INNER_W, 0, 1)

const yToSpeed = (y: number): number => {
  const ratio = 1 - clamp((y - PAD_TOP) / INNER_H, 0, 1)
  return clampSpeed(Math.exp(LOG_MIN + ratio * (LOG_MAX - LOG_MIN)))
}

const formatSpeed = (speed: number): string => `${Number(speed.toFixed(2))}x`

/** 把控制点收敛到编辑器约束：两端固定在 0 / 1，中途按相邻点夹取。 */
function clampPoint(points: SpeedCurvePoint[], index: number, next: SpeedCurvePoint): SpeedCurvePoint {
  const isFirst = index === 0
  const isLast = index === points.length - 1
  const lower = isFirst ? 0 : points[index - 1].at + MIN_GAP
  const upper = isLast ? 1 : points[index + 1].at - MIN_GAP
  const at = isFirst ? 0 : isLast ? 1 : clamp(next.at, Math.max(0, lower), Math.min(1, upper))
  return { at, speed: clampSpeed(next.speed) }
}

/**
 * 曲线变速编辑器：横轴 = 片段进度 0…1，纵轴 = 播放倍率（对数刻度）。
 *
 * 交互约定与面板其它控件一致：
 * - 拖动控制点时持续 `onPreview`（走 previewPatch，时间轴/预览实时跟着变）；
 * - 松手（pointerup / pointercancel）才 `onCommit`，因此一次拖动 = 一步撤销；
 * - 两端控制点的横坐标固定，只有中间点能左右移动；
 * - 3–5 个控制点：`加控制点` 插在最大空隙中点，双击中间点删除。
 */
export function SpeedCurveEditor({
  curve,
  disabled,
  onPreview,
  onCommit,
}: SpeedCurveEditorProps) {
  const [draft, setDraft] = useState<SpeedCurvePoint[]>(curve)
  const [active, setActive] = useState<number | null>(null)
  const dragging = useRef<number | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  // 非拖动状态下跟随外部值（撤销 / 切换片段 / 粘贴都会改写它）。
  useEffect(() => {
    if (dragging.current === null) setDraft(curve)
  }, [curve])

  const points = useMemo(
    () => (draft.length >= 2 ? draft : createFlatSpeedCurve()),
    [draft],
  )
  const innerPoints = points.slice(1, -1)

  const { line, area } = useMemo(() => {
    const coords: string[] = []
    for (let index = 0; index < SAMPLES; index += 1) {
      const at = index / (SAMPLES - 1)
      const speed = evalSpeedCurve(points, at) ?? 1
      coords.push(`${atToX(at).toFixed(2)},${speedToY(speed).toFixed(2)}`)
    }
    const baseline = (PAD_TOP + INNER_H).toFixed(2)
    const first = `${atToX(0).toFixed(2)},${baseline}`
    const last = `${atToX(1).toFixed(2)},${baseline}`
    return {
      line: coords.join(' '),
      area: `${first} ${coords.join(' ')} ${last}`,
    }
  }, [points])

  const emit = useCallback(
    (next: SpeedCurvePoint[]) => {
      setDraft(next)
      onPreview(next)
    },
    [onPreview],
  )

  const finish = useCallback(
    (next: SpeedCurvePoint[]) => {
      dragging.current = null
      onCommit(next)
    },
    [onCommit],
  )

  const locate = (event: React.PointerEvent<SVGSVGElement>): SpeedCurvePoint => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * WIDTH
    const y = ((event.clientY - rect.top) / Math.max(1, rect.height)) * HEIGHT
    return { at: xToAt(x), speed: yToSpeed(y) }
  }

  const onPointerDown = (index: number) => (event: React.PointerEvent<SVGElement>) => {
    if (disabled) return
    event.preventDefault()
    event.stopPropagation()
    dragging.current = index
    setActive(index)
    svgRef.current?.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const index = dragging.current
    if (index === null || disabled) return
    const target = clampPoint(points, index, locate(event))
    const previous = points[index]
    if (Math.abs(previous.at - target.at) < 1e-4 && Math.abs(previous.speed - target.speed) < 1e-3) {
      return
    }
    const next = points.map((point, itemIndex) => (itemIndex === index ? target : point))
    emit(next)
  }

  const onPointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    const index = dragging.current
    if (index === null) return
    if (svgRef.current?.hasPointerCapture(event.pointerId)) {
      svgRef.current.releasePointerCapture(event.pointerId)
    }
    finish(points)
  }

  const insertPoint = () => {
    if (disabled || points.length >= SPEED_CURVE_POINT_MAX) return
    // 插在「当前最大的空隙」中点，速度取该处的曲线值，形状变化最小。
    let bestIndex = 0
    let bestGap = -1
    for (let index = 0; index < points.length - 1; index += 1) {
      const gap = points[index + 1].at - points[index].at
      if (gap > bestGap) {
        bestGap = gap
        bestIndex = index
      }
    }
    const at = (points[bestIndex].at + points[bestIndex + 1].at) / 2
    const speed = evalSpeedCurve(points, at) ?? 1
    const next = [...points.slice(0, bestIndex + 1), { at, speed }, ...points.slice(bestIndex + 1)]
    setActive(bestIndex + 1)
    onCommit(next)
  }

  const removePoint = (index: number) => {
    if (disabled || points.length <= SPEED_CURVE_POINT_MIN) return
    if (index <= 0 || index >= points.length - 1) return
    const next = points.filter((_, itemIndex) => itemIndex !== index)
    setActive(null)
    onCommit(next)
  }

  /** 键盘微调：返回是否消费了该按键（未消费时让 Tab / Esc 等正常冒泡）。 */
  const nudge = (index: number, key: string): boolean => {
    if (disabled) return false
    const point = points[index]
    const speedStep = 0.05
    let next = point
    if (key === 'ArrowUp') next = { ...point, speed: clampSpeed(point.speed + speedStep) }
    else if (key === 'ArrowDown') next = { ...point, speed: clampSpeed(point.speed - speedStep) }
    else if (key === 'ArrowLeft' || key === 'ArrowRight') {
      if (index === 0 || index === points.length - 1) return true
      const delta = key === 'ArrowLeft' ? -0.01 : 0.01
      next = clampPoint(points, index, { ...point, at: point.at + delta })
    } else if (key === 'Delete' || key === 'Backspace') {
      removePoint(index)
      return true
    } else {
      return false
    }
    const updated = points.map((item, itemIndex) => (itemIndex === index ? next : item))
    setDraft(updated)
    onCommit(updated)
    return true
  }

  const activePoint = active !== null ? points[active] : null

  return (
    <div className={`speed-curve-editor${disabled ? ' is-disabled' : ''}`}>
      <svg
        ref={svgRef}
        className="speed-curve-canvas"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width="100%"
        height={HEIGHT}
        role="group"
        aria-label="速度曲线编辑器：横轴片段进度，纵轴播放速度"
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <rect
          x={0}
          y={0}
          width={WIDTH}
          height={HEIGHT}
          rx={6}
          className="speed-curve-bg"
        />
        {GRID_SPEEDS.map((speed) => {
          const y = speedToY(speed)
          const isUnit = speed === 1
          return (
            <g key={`grid-${speed}`}>
              <line
                x1={PAD_LEFT}
                y1={y}
                x2={WIDTH - PAD_RIGHT}
                y2={y}
                className={isUnit ? 'speed-curve-grid is-unit' : 'speed-curve-grid'}
                strokeDasharray={isUnit ? '4 3' : undefined}
              />
              <text x={PAD_LEFT - 5} y={y + 3} className="speed-curve-tick" textAnchor="end">
                {speed === 1 ? '1x' : `${speed}x`}
              </text>
            </g>
          )
        })}
        <polygon points={area} className="speed-curve-area" />
        <polyline points={line} className="speed-curve-line" />
        {activePoint && (
          <line
            x1={atToX(activePoint.at)}
            y1={PAD_TOP}
            x2={atToX(activePoint.at)}
            y2={PAD_TOP + INNER_H}
            className="speed-curve-cursor"
          />
        )}
        {points.map((point, index) => {
          const x = atToX(point.at)
          const y = speedToY(point.speed)
          const isActive = active === index
          const label = `第 ${index + 1} 个控制点：进度 ${Math.round(point.at * 100)}%、速度 ${formatSpeed(point.speed)}`
          return (
            <g
              key={`point-${index}`}
              className={`speed-curve-point${isActive ? ' is-active' : ''}`}
              role="slider"
              tabIndex={disabled ? -1 : 0}
              aria-label={label}
              aria-valuenow={Number(point.speed.toFixed(2))}
              aria-valuemin={SPEED_MIN}
              aria-valuemax={SPEED_MAX}
              aria-valuetext={label}
              onPointerDown={onPointerDown(index)}
              onDoubleClick={() => removePoint(index)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive((current) => (current === index ? null : current))}
              onKeyDown={(event) => {
                if (nudge(index, event.key)) event.preventDefault()
                event.stopPropagation()
              }}
            >
              {/* 透明的大热区：小圆点也太难点中。 */}
              <circle cx={x} cy={y} r={12} className="speed-curve-hit" />
              <circle cx={x} cy={y} r={isActive ? 6 : 5} className="speed-curve-dot" />
            </g>
          )
        })}
        {activePoint && (
          <text x={WIDTH - PAD_RIGHT} y={PAD_TOP + 2} className="speed-curve-readout" textAnchor="end">
            {formatSpeed(activePoint.speed)} · {Math.round(activePoint.at * 100)}%
          </text>
        )}
      </svg>
      <div className="speed-curve-toolbar">
        <span className="speed-curve-hint">
          拖动圆点调速度；两端只上下拖
          {innerPoints.length > 0 ? '，中间点可左右挪' : ''}（双击中间点删除）
        </span>
        <button
          type="button"
          className="button mini"
          disabled={disabled || points.length >= SPEED_CURVE_POINT_MAX}
          title={`在最大空隙处插入一个控制点（上限 ${SPEED_CURVE_POINT_MAX} 个）`}
          onClick={insertPoint}
        >
          加控制点
        </button>
      </div>
    </div>
  )
}