import { easeValue, evalAnimation } from './animation'
import type { Keyframe } from './types'

/**
 * 把关键帧动画编译成 FFmpeg 的逐帧表达式。
 *
 * 这里只负责「纯函数」部分：输入归一化关键帧 + 片段时长，输出以**片段本地秒**
 * 为时间变量 `t` 的表达式。音频链里 `volume` 位于 `atrim/asetpts` 与 `atempo`
 * 之后、`adelay` 之前，因此 `t` 正好是从 0 开始的片段本地时间（见 exportPlan）。
 */

/** 单片段最多保留的关键帧数；超过后按曲线等距重采样。 */
export const ANIMATION_EXPR_MAX_POINTS = 8
/** 非线性缓动每一段用几段线性近似。 */
export const ANIMATION_EXPR_EASE_SEGMENTS = 4

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/** 固定小数格式，且不输出负零 / 科学计数法。 */
function formatNumber(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) < 1e-9) return '0'
  return Number(value.toFixed(6)).toString()
}

/** 清洗关键帧：排序、夹取时间/取值、同一时间保留后者。 */
function normalizeKeys(
  keys: readonly Keyframe[],
  minValue: number,
  maxValue: number,
): Keyframe[] {
  const byTime = new Map<number, Keyframe>()
  for (const key of keys) {
    if (!Number.isFinite(key.t) || !Number.isFinite(key.value)) continue
    const t = clamp(key.t, 0, 1)
    byTime.set(t, {
      t,
      value: clamp(key.value, minValue, maxValue),
      ease: key.ease ?? 'linear',
    })
  }
  return [...byTime.values()].sort((left, right) => left.t - right.t)
}

/**
 * 关键帧过多时按曲线重采样为 `maxPoints` 个点。
 * 采样范围是第一帧到最后一帧；首尾值保证保留，帧之间的缓动形状由
 * `evalAnimation` 采样后以线性段近似。首帧前/末帧后的夹取语义不变。
 */
export function resampleAnimationKeyframes(
  keys: readonly Keyframe[],
  maxPoints = ANIMATION_EXPR_MAX_POINTS,
  minValue = 0,
  maxValue = 2,
): Keyframe[] {
  const normalized = normalizeKeys(keys, minValue, maxValue)
  if (normalized.length <= maxPoints) return normalized
  const first = normalized[0]
  const last = normalized[normalized.length - 1]
  const span = last.t - first.t
  if (span <= 1e-9) return [{ ...last, ease: 'linear' }]
  const points: Keyframe[] = []
  for (let index = 0; index < maxPoints; index += 1) {
    const t = index === maxPoints - 1
      ? last.t
      : first.t + (span * index) / (maxPoints - 1)
    points.push({
      t,
      value: evalAnimation(normalized, t, first.value),
      // 采样点之间已经是曲线上的值，线性连接即可。
      ease: 'linear',
    })
  }
  return points
}

interface LinearPiece {
  /** 片段本地秒 */
  t0: number
  t1: number
  v0: number
  v1: number
}

function linearExpr(piece: LinearPiece): string {
  if (Math.abs(piece.v1 - piece.v0) < 1e-9) return formatNumber(piece.v0)
  const span = piece.t1 - piece.t0
  if (span <= 1e-9) return formatNumber(piece.v1)
  return `(${formatNumber(piece.v0)}+(${formatNumber(piece.v1)}-${formatNumber(piece.v0)})*(t-${formatNumber(piece.t0)})/${formatNumber(span)})`
}

/** 把一段缓动拆成 4 段线性近似。 */
function piecesForSegment(
  fromT: number,
  toT: number,
  fromV: number,
  toV: number,
  ease: Keyframe['ease'],
  segments: number,
): LinearPiece[] {
  if (ease === 'hold') {
    return [{ t0: fromT, t1: toT, v0: fromV, v1: fromV }]
  }
  if (ease === 'linear' || segments <= 1) {
    return [{ t0: fromT, t1: toT, v0: fromV, v1: toV }]
  }
  const pieces: LinearPiece[] = []
  for (let index = 0; index < segments; index += 1) {
    const p0 = index / segments
    const p1 = (index + 1) / segments
    pieces.push({
      t0: fromT + (toT - fromT) * p0,
      t1: fromT + (toT - fromT) * p1,
      v0: fromV + (toV - fromV) * easeValue(ease, p0),
      v1: fromV + (toV - fromV) * easeValue(ease, p1),
    })
  }
  return pieces
}

/**
 * 生成表达式：
 * `if(lt(t,T0),V0, if(lt(t,T1), 线性段1, ..., 末帧值))`
 *
 * - 首帧前返回首帧值，末帧后返回末帧值。
 * - 相邻关键帧按**后一帧的 ease** 插值（与 `evalAnimation` 一致）。
 * - 非线性缓动按 4 段线性近似。
 *
 * `options.scale` 用于把轨道音量乘进同一个表达式（音量轨分支没有别的
 * 位置可以再乘轨道增益），不改变关键帧本身的 0…2 取值范围。
 */
export function buildAnimationExpression(
  keys: readonly Keyframe[],
  durationSeconds: number,
  options: {
    scale?: number
    maxPoints?: number
    easeSegments?: number
    minValue?: number
    maxValue?: number
  } = {},
): string | null {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null
  const scale = Number.isFinite(options.scale ?? 1) ? (options.scale ?? 1) : 1
  const minValue = options.minValue ?? 0
  const maxValue = options.maxValue ?? 2
  const points = resampleAnimationKeyframes(
    keys,
    options.maxPoints ?? ANIMATION_EXPR_MAX_POINTS,
    minValue,
    maxValue,
  )
  if (points.length === 0) return null
  if (points.length === 1) return formatNumber(points[0].value * scale)

  const segments = options.easeSegments ?? ANIMATION_EXPR_EASE_SEGMENTS
  const pieces: LinearPiece[] = []
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index]
    const to = points[index + 1]
    pieces.push(
      ...piecesForSegment(
        from.t * durationSeconds,
        to.t * durationSeconds,
        from.value,
        to.value,
        to.ease,
        segments,
      ),
    )
  }
  if (pieces.length === 0) return formatNumber(points[0].value * scale)

  const scaled = (value: number): number => value * scale
  const lastValue = formatNumber(scaled(points[points.length - 1].value))
  const scaledPiece = (piece: LinearPiece): LinearPiece => ({
    ...piece,
    v0: scaled(piece.v0),
    v1: scaled(piece.v1),
  })

  // 从后向前拼 if 阶梯，避免递归深度随关键帧数量增长。
  let expression = lastValue
  for (let index = pieces.length - 1; index >= 0; index -= 1) {
    const piece = scaledPiece(pieces[index])
    expression = `if(lt(t,${formatNumber(piece.t1)}),${linearExpr(piece)},${expression})`
  }

  // 首帧之前夹取首帧值。
  const firstTime = points[0].t * durationSeconds
  if (firstTime > 1e-9) {
    expression = `if(lt(t,${formatNumber(firstTime)}),${formatNumber(
      scaled(points[0].value),
    )},${expression})`
  }
  return expression
}

/**
 * 音量专用入口：关键帧值域固定 0…2（与 Clip.volume / AudioClip.volume 一致）。
 * 返回值直接用于 `volume='<expr>':eval=frame`。
 */
export function buildVolumeExpression(
  keys: readonly Keyframe[],
  durationSeconds: number,
  options: { scale?: number; maxPoints?: number; easeSegments?: number } = {},
): string | null {
  return buildAnimationExpression(keys, durationSeconds, {
    ...options,
    minValue: 0,
    maxValue: 2,
  })
}

/** 关键帧集合里最大的音量值（含 0…2 夹取），用于「全为 0 就跳过分支」判断。 */
export function maxVolumeKeyValue(keys: readonly Keyframe[] | undefined): number {
  if (!keys || keys.length === 0) return 0
  let max = 0
  for (const key of keys) {
    if (!Number.isFinite(key.value)) continue
    max = Math.max(max, clamp(key.value, 0, 2))
  }
  return max
}