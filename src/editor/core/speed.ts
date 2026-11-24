import { clipTimelineDuration } from './clipTime'
import type { Clip, Project } from './types'

/** 变速范围与默认值。 */
export const SPEED_MIN = 0.1
export const SPEED_MAX = 10
export const DEFAULT_SPEED = 1
/** 常用档位。 */
export const SPEED_PRESETS = [0.5, 1, 1.5, 2, 3] as const

/** 把倍率夹到允许范围；非法值回退 1。 */
export function clampSpeed(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_SPEED
  return Math.max(SPEED_MIN, Math.min(SPEED_MAX, value))
}

/** 片段倍率（缺省 1）。 */
export function clipSpeedValue(clip: Pick<Clip, 'speed'>): number {
  return clampSpeed(clip.speed ?? DEFAULT_SPEED)
}

/** 是否保持音调（缺省 true）。 */
export function clipKeepsPitch(clip: Pick<Clip, 'keepPitch'>): boolean {
  return clip.keepPitch !== false
}

/** 变速后的时间轴时长（源跨度 / 倍率）。 */
export function speedAdjustedDuration(clip: Clip): number {
  return clipTimelineDuration(clip)
}

/**
 * 生成 FFmpeg `atempo` 链：单级只支持 0.5–2，超出时拆成多级连乘。
 * 例：4x → atempo=2,atempo=2；0.25x → atempo=0.5,atempo=0.5。
 */
export function atempoChain(speed: number): string[] {
  const target = clampSpeed(speed)
  const filters: string[] = []
  if (Math.abs(target - 1) < 1e-6) return filters
  let remaining = target
  // 大于 2 时逐级折半，小于 0.5 时逐级翻倍。
  while (remaining > 2 + 1e-9) {
    filters.push('atempo=2')
    remaining /= 2
  }
  while (remaining < 0.5 - 1e-9) {
    filters.push('atempo=0.5')
    remaining /= 0.5
  }
  filters.push(`atempo=${Number(remaining.toFixed(6))}`)
  return filters
}

/**
 * keepPitch=false 时的音频变速：asetrate 改变采样率实现「改变音调」的变速。
 *
 * 必须先把输入统一到 `sampleRate` 再改采样率：素材可能是 44.1k，而
 * FFmpeg 滤镜图里的 `asetrate` 用的是**绝对**采样率。直接写 48000×倍率，
 * 44.1k 源的实际倍率会变成 48000×倍率/44100（2x → 约 2.18x，时长/音高都错）。
 */
export function asetrateChain(speed: number, sampleRate = 48000): string[] {
  const target = clampSpeed(speed)
  if (Math.abs(target - 1) < 1e-6) return []
  return [
    `aresample=${sampleRate}`,
    `asetrate=${Math.round(sampleRate * target)}`,
    `aresample=${sampleRate}`,
  ]
}

/** 按 keepPitch 选择音频变速滤镜链。 */
export function speedAudioFilters(speed: number, keepPitch: boolean, sampleRate = 48000): string[] {
  return keepPitch ? atempoChain(speed) : asetrateChain(speed, sampleRate)
}

/** 视频变速滤镜：PTS 除以倍率（>1 变快、<1 变慢）。 */
/**
 * 分段变速在某个「时间轴本地时间」上的段速（段内常速）。
 * 没有分段时返回 undefined（调用方改用 clip.speed）。
 */
export function speedAtTimelineTime(
  clip: {
    sourceStart: number
    sourceEnd: number
    speedSegments?: { at: number; speed: number }[]
  },
  localTime: number,
): number | undefined {
  const plan = segmentPlan(clip)
  if (!plan || plan.length < 2) return undefined
  const last = plan[plan.length - 1]
  const total = last.timelineOffset + last.timelineDuration
  const local = Math.min(Math.max(0, localTime), total)
  for (const segment of plan) {
    if (local < segment.timelineOffset + segment.timelineDuration - 1e-9) return segment.speed
  }
  return last.speed
}

/** 分段变速的段数上限（阶段 1a：2–8 段，段内常速）。 */
export const SPEED_SEGMENT_MAX = 24

/**
 * 相邻段的最小间隔（占片段进度的比例）。
 *
 * 这是段表表示的精度下限：比它更窄的段无法被表示，normalizeSpeedSegments 会把它的
 * `at` 向上推（从而把相邻段撑宽）。切片时我们反过来，直接把窄于这个值的段并进邻居，
 * 让误差只剩「那一段自身的源长」，而不是被撑宽 1% 跨度。
 */
export const SPEED_SEGMENT_MIN_GAP = 0.01

/** 一段的「源区间 + 段速 + 时间轴时长/偏移」。 */
export interface SpeedSegmentPlan {
  /** 段在源时间轴上的绝对区间（秒）。 */
  sourceStart: number
  sourceEnd: number
  speed: number
  /** 该段在时间轴上占的时长（秒）。 */
  timelineDuration: number
  /** 该段在时间轴上相对片段起点的偏移（秒）。 */
  timelineOffset: number
}

/**
 * 夹取 / 排序分段变速参数：
 * - `at` 夹到 0..1 并严格递增（首段强制 0，最小段宽 1%）；
 * - 段速夹到 SPEED_MIN..SPEED_MAX；
 * - 不足 2 段、超过上限、或最后一段从 1.0 开始 → 返回 undefined（走单一 speed）。
 */
export function normalizeSpeedSegments(
  value: unknown,
): { at: number; speed: number }[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value
    .filter((item): item is { at?: unknown; speed?: unknown } =>
      Boolean(item && typeof item === 'object'),
    )
    .map((item) => ({
      at: Number.isFinite(Number(item.at)) ? Math.min(1, Math.max(0, Number(item.at))) : 0,
      speed: clampSpeed(Number(item.speed)),
    }))
    .sort((left, right) => left.at - right.at)
  if (items.length < 2) return undefined
  const limited = items.slice(0, SPEED_SEGMENT_MAX)
  limited[0] = { ...limited[0], at: 0 }
  for (let index = 1; index < limited.length; index += 1) {
    const floor = limited[index - 1].at + SPEED_SEGMENT_MIN_GAP
    limited[index] = { ...limited[index], at: Math.min(1, Math.max(floor, limited[index].at)) }
  }
  if (limited[limited.length - 1].at >= 1) return undefined
  return limited
}

/**
 * 把分段参数换算成「段计划」：源区间按 `at` 切分，时长 = 段源长 / 段速。
 * 没有分段时返回 null（调用方走原来的单一 speed 路径）。
 */
/** 平滑曲线采样成段表的默认段数（越多越平滑，图也越长；16 段在 1080p 下足够）。 */
export const SPEED_CURVE_SAMPLES = 16

/** 曲线编辑器允许的控制点数量（两端固定 0 / 1，中间可拖）。 */
export const SPEED_CURVE_POINT_MIN = 3
export const SPEED_CURVE_POINT_MAX = 5

/** 浮点比较容差。 */
const CURVE_EPS = 1e-9

/** 曲线控制点的归一化（求值用）：排序、夹到 0..1、段速夹取，相同 `at` 只保留后一个。 */
function curveKnots(curve: unknown): { at: number; speed: number }[] {
  if (!Array.isArray(curve)) return []
  const points = curve
    .filter((item): item is { at?: unknown; speed?: unknown } =>
      Boolean(item && typeof item === 'object'),
    )
    .map((item) => ({
      at: Number.isFinite(Number(item.at)) ? Math.min(1, Math.max(0, Number(item.at))) : 0,
      speed: clampSpeed(Number(item.speed)),
    }))
    .sort((left, right) => left.at - right.at)
  const unique: { at: number; speed: number }[] = []
  for (const point of points) {
    const previous = unique[unique.length - 1]
    // 零宽区间会让斜率无从定义，直接让后一个点覆盖前一个。
    if (previous && Math.abs(previous.at - point.at) <= CURVE_EPS) {
      unique[unique.length - 1] = point
    } else {
      unique.push(point)
    }
  }
  return unique
}

/**
 * 单调三次插值（Fritsch–Carlson / PCHIP）在节点处的斜率。
 *
 * 为什么不是 Catmull-Rom：普通三次样条会在控制点附近「过冲」——变速曲线过冲
 * 意味着片段时长被插值出来的异常值拖长/压短，甚至出现超过 0.1–10 的瞬时速度。
 * Fritsch–Carlson 用加权调和平均给内部斜率、并在两端取单侧差分，保证：
 * - 相邻控制点之间严格单调（控制点单调时不产生回弹）；
 * - 曲线不超出相邻控制点的速度区间（无过冲）；
 * - 控制点处一阶导数连续（原先的线性插值在控制点处有折角）；
 * - 只有 2 个控制点时退化为原来的直线，与旧采样结果完全一致。
 */
function monotoneSlopes(points: { at: number; speed: number }[]): number[] {
  const count = points.length
  const spans: number[] = []
  const secants: number[] = []
  for (let index = 0; index < count - 1; index += 1) {
    const span = points[index + 1].at - points[index].at
    spans.push(span)
    secants.push(span > CURVE_EPS ? (points[index + 1].speed - points[index].speed) / span : 0)
  }
  const slopes = new Array<number>(count).fill(0)
  slopes[0] = secants[0] ?? 0
  slopes[count - 1] = secants[count - 2] ?? 0
  for (let index = 1; index < count - 1; index += 1) {
    const left = secants[index - 1]
    const right = secants[index]
    // 极值点（左右差分异号）或平台（某侧为 0）→ 斜率取 0，避免 overshoot。
    if (left * right <= 0) {
      slopes[index] = 0
      continue
    }
    const w1 = 2 * spans[index] + spans[index - 1]
    const w2 = spans[index] + 2 * spans[index - 1]
    slopes[index] = (w1 + w2) / (w1 / left + w2 / right)
  }
  return slopes
}

/**
 * 在「片段进度」0…1 处求曲线速度（单调三次插值）。
 * 控制点外按端点常量延拓（与旧实现一致），非法输入返回 undefined。
 */
export function evalSpeedCurve(curve: unknown, position: number): number | undefined {
  const points = curveKnots(curve)
  if (points.length === 0) return undefined
  if (points.length === 1) return points[0].speed
  const last = points[points.length - 1]
  const ratio = Number.isFinite(position) ? Math.min(1, Math.max(0, position)) : 0
  if (ratio <= points[0].at) return points[0].speed
  if (ratio >= last.at) return last.speed

  let index = 0
  while (index < points.length - 2 && ratio > points[index + 1].at) index += 1
  const from = points[index]
  const to = points[index + 1]
  const span = to.at - from.at
  if (span <= CURVE_EPS) return to.speed

  const slopes = monotoneSlopes(points)
  const t = (ratio - from.at) / span
  const t2 = t * t
  const t3 = t2 * t
  // 三次 Hermite 基函数。
  const h00 = 2 * t3 - 3 * t2 + 1
  const h10 = t3 - 2 * t2 + t
  const h01 = -2 * t3 + 3 * t2
  const h11 = t3 - t2
  const value =
    h00 * from.speed + h10 * span * slopes[index] + h01 * to.speed + h11 * span * slopes[index + 1]
  // 单调插值本身不会越界，这里只为浮点噪声兜底。
  return clampSpeed(value)
}

/** 默认曲线形状：3 个控制点、全程同一倍率（两端固定 0 / 1）。 */
export function createFlatSpeedCurve(speed = DEFAULT_SPEED): { at: number; speed: number }[] {
  return [
    { at: 0, speed },
    { at: 0.5, speed },
    { at: 1, speed },
  ]
}

/**
 * 把「平滑曲线」的控制点采样成段表（段内常速）：
 * - 控制点按 `at` 排序、夹到 0..1、段速夹到 0.1–10；
 * - 每段取「该段起点处的曲线值」，因此采样越密越接近连续曲线；
 * - 至少 2 段，最多 SPEED_SEGMENT_MAX 段。
 */
/**
 * 曲线控制点的归一化：与 normalizeSpeedSegments 的区别是**允许最后一点在 1.0**
 * （曲线天然会有一个结束控制点），仍然要求至少 2 点、严格递增、段速夹取。
 */
export function normalizeSpeedCurve(
  value: unknown,
): { at: number; speed: number }[] | undefined {
  if (!Array.isArray(value)) return undefined
  const points = value
    .filter((item): item is { at?: unknown; speed?: unknown } =>
      Boolean(item && typeof item === 'object'),
    )
    .map((item) => ({
      at: Number.isFinite(Number(item.at)) ? Math.min(1, Math.max(0, Number(item.at))) : 0,
      speed: clampSpeed(Number(item.speed)),
    }))
    .sort((left, right) => left.at - right.at)
  if (points.length < 2) return undefined
  const limited = points.slice(0, SPEED_SEGMENT_MAX)
  limited[0] = { ...limited[0], at: 0 }
  for (let index = 1; index < limited.length; index += 1) {
    const floor = limited[index - 1].at + SPEED_SEGMENT_MIN_GAP
    limited[index] = { ...limited[index], at: Math.min(1, Math.max(floor, limited[index].at)) }
  }
  return limited
}

/**
 * 把「平滑曲线」的控制点采样成段表（段内常速）：
 * - 控制点按 `at` 排序、夹到 0..1、段速夹到 0.1–10；
 * - 采样点在 `at = i / count`，曲线值由单调三次插值（见 evalSpeedCurve）给出，
 *   因此控制点之间不再有线性插值造成的折角；
 * - 每段取「该段起点处的曲线值」，采样越密越接近连续曲线；
 * - 至少 2 段，最多 SPEED_SEGMENT_MAX 段。
 */
export function sampleSpeedCurve(
  curve: unknown,
  samples = SPEED_CURVE_SAMPLES,
): { at: number; speed: number }[] | undefined {
  if (!Array.isArray(curve) || curve.length === 0) return undefined
  if (curveKnots(curve).length === 0) return undefined
  const count = Math.max(2, Math.min(SPEED_SEGMENT_MAX, Math.round(samples)))
  const segments: { at: number; speed: number }[] = []
  for (let index = 0; index < count; index += 1) {
    const position = index / count
    const speed = evalSpeedCurve(curve, position)
    if (speed === undefined) return undefined
    segments.push({ at: position, speed })
  }
  return normalizeSpeedSegments(segments)
}

/**
 * 分段 / 曲线里是否存在「非 1x」的段。
 *
 * 预览用 playbackRate 播放这些片段会变调（导出用 atempo 保音高），
 * 所以只有真的改变了速度才需要静音；一条全程 1x 的平坦曲线不该被静音。
 */
export function hasSpeedVariation(clip: {
  sourceStart: number
  sourceEnd: number
  speedSegments?: { at: number; speed: number }[]
  speedCurve?: { at: number; speed: number }[]
}): boolean {
  const plan = segmentPlan(clip)
  return Boolean(plan && plan.some((segment) => Math.abs(segment.speed - 1) > 1e-3))
}

/**
 * 片段某一端（开头 / 结尾）的段速。
 *
 * 拖边缘**外扩**时，1 秒时间轴需要消耗多少秒源素材由端点的段速决定
 * （2x 段里往外拉 1s，要多拿出 2s 源；0.5x 段里拉 1s 只要 0.5s 源）。
 * 没有分段 / 曲线时就是单一 `speed`。
 */
export function clipEdgeSpeed(
  clip: {
    sourceStart: number
    sourceEnd: number
    speed?: number
    speedSegments?: { at: number; speed: number }[]
    speedCurve?: { at: number; speed: number }[]
  },
  edge: 'start' | 'end',
): number {
  const plan = segmentPlan(clip)
  if (!plan || plan.length === 0) return clipSpeedValue(clip)
  return edge === 'start' ? plan[0].speed : plan[plan.length - 1].speed
}

/** 片段实际使用的段表：显式 speedSegments 优先，否则把 speedCurve 采样成段表。 */
export function clipSpeedSegments(clip: {
  sourceStart: number
  sourceEnd: number
  speedSegments?: { at: number; speed: number }[]
  speedCurve?: { at: number; speed: number }[]
}): { at: number; speed: number }[] | undefined {
  const explicit = normalizeSpeedSegments(clip.speedSegments)
  if (explicit) return explicit
  return sampleSpeedCurve(clip.speedCurve)
}

export function segmentPlan(clip: {
  sourceStart: number
  sourceEnd: number
  speedSegments?: { at: number; speed: number }[]
  speedCurve?: { at: number; speed: number }[]
}): SpeedSegmentPlan[] | null {
  const segments = clipSpeedSegments(clip)
  if (!segments) return null
  const span = Math.max(0, clip.sourceEnd - clip.sourceStart)
  if (span <= 0) return null
  const plan: SpeedSegmentPlan[] = []
  let offset = 0
  for (let index = 0; index < segments.length; index += 1) {
    const startRatio = segments[index].at
    const endRatio = index + 1 < segments.length ? segments[index + 1].at : 1
    const sourceStart = clip.sourceStart + span * startRatio
    const sourceEnd = clip.sourceStart + span * endRatio
    const timelineDuration = Math.max(0, sourceEnd - sourceStart) / segments[index].speed
    plan.push({
      sourceStart,
      sourceEnd,
      speed: segments[index].speed,
      timelineDuration,
      timelineOffset: offset,
    })
    offset += timelineDuration
  }
  return plan
}

/** 分段变速的总时长；没有分段时返回 null。 */
export function segmentedTimelineDuration(clip: {
  sourceStart: number
  sourceEnd: number
  speedSegments?: { at: number; speed: number }[]
}): number | null {
  const plan = segmentPlan(clip)
  if (!plan) return null
  return plan.reduce((sum, segment) => sum + segment.timelineDuration, 0)
}

/**
 * 把窄于 {@link SPEED_SEGMENT_MIN_GAP} 的段并进邻居（**末段除外**）。
 *
 * 为什么要主动合并而不是交给 normalizeSpeedSegments：那里只会把窄段的 `at` 向**上**推，
 * 于是该段被「撑宽」到 1% 跨度（速度还按它自己的），在 4x/1x 相邻时能让时长漂几十毫秒；
 * 直接并进邻居则只丢掉「这一段自身的源长」，误差小 10~100 倍。
 *
 * 末段不参与合并：normalize 只约束 `at` 的下界，最后一段的宽度本来就可以任意小，
 * 保留它反而是精确的（曲线在网格边界附近被切开时，窄片几乎总是落在末段）。
 */
function coalesceNarrowSegments(
  pieces: { at: number; speed: number }[],
): { at: number; speed: number }[] {
  const result = pieces.map((piece) => ({ ...piece }))
  for (let guard = 0; guard < SPEED_SEGMENT_MAX && result.length > 1; guard += 1) {
    let narrowest = -1
    let narrowestWidth = SPEED_SEGMENT_MIN_GAP
    for (let index = 0; index < result.length - 1; index += 1) {
      const width = result[index + 1].at - result[index].at
      if (width < narrowestWidth - 1e-12) {
        narrowestWidth = width
        narrowest = index
      }
    }
    if (narrowest < 0) break
    result.splice(narrowest, 1)
    // 丢掉首段后，新区间从下一段的起点开始。
    if (narrowest === 0) result[0].at = 0
  }
  return result
}

/**
 * 把段表按**源时间区间** `[from, to]` 裁出来，并把 `at` 重新归一化到 0~1。
 *
 * 关键点：`at` 是相对 `sourceStart..sourceEnd` 的比例，分割 / 裁剪改了源区间后，
 * 原来的比例就指向别的源时刻了（0.5 分界点会从「源 5s」变成「源 2.5s」）。
 * 这里按源时刻把每一段切开，边界处插入断点，因此**每个源时刻的段速都不变**，
 * 只是坐标系换成新区间。
 *
 * 时间轴时长因此天然守恒：Σ(新段源长 / 段速) 与原段表逐段相同，裁剪只是把
 * 同一段表按源区间重新分组，相加后精确等于原片段的总时长。
 *
 * 边界说明：
 * - 区间恰好开始于某段的分界点时，取从该点开始的段（与 segmentPlan 的半开区间口径一致）；
 * - 区间伸出源区间（拖边缘**外扩**、恢复被裁掉的素材）时，超出部分沿用最近一端的段速，
 *   这样变速曲线锚定在源时刻上，不会因为外扩而被整体拉伸；
 * - 只有一段落在区间里时补一个同速段（段表至少 2 段才生效）。
 */
export function sliceSpeedSegments(
  segments: { at: number; speed: number }[] | undefined,
  sourceStart: number,
  sourceEnd: number,
  from: number,
  to: number,
): { at: number; speed: number }[] | undefined {
  const plan = segmentPlan({ sourceStart, sourceEnd, speedSegments: segments })
  const length = to - from
  if (!plan || !Number.isFinite(from) || !Number.isFinite(to) || length <= 1e-9) return undefined
  const pieces: { at: number; speed: number }[] = []
  // 区间伸到源区间左侧：用第一段的段速补前面那截。
  if (from < sourceStart - 1e-9) {
    pieces.push({ at: 0, speed: plan[0].speed })
  }
  for (const piece of plan) {
    const start = Math.max(piece.sourceStart, from)
    const end = Math.min(piece.sourceEnd, to)
    if (end - start <= 1e-9) continue
    pieces.push({ at: (start - from) / length, speed: piece.speed })
  }
  // 区间伸到源区间右侧：用最后一段的段速补后面那截。
  if (to > sourceEnd + 1e-9) {
    pieces.push({
      at: Math.max(0, (sourceEnd - from) / length),
      speed: plan[plan.length - 1].speed,
    })
  }
  if (pieces.length === 0) return undefined
  const kept = coalesceNarrowSegments(pieces)
  // 只剩一个恒速段 → 段表需要 2 段才生效，补一个同速段（速度曲线不变）。
  if (kept.length === 1) {
    return [
      { at: 0, speed: kept[0].speed },
      { at: 0.5, speed: kept[0].speed },
    ]
  }
  return kept
}

/**
 * 片段级的变速切片：返回应该写回片段的补丁（没有分段 / 曲线变速时返回 `{}`）。
 *
 * 关于曲线：曲线片段的**时长和播放速度**都由「把曲线采样成 16 段段表」决定
 * （见 sampleSpeedCurve / segmentPlan），所以这里直接按这张有效段表切片。
 * 这样切片前后每个源时刻的速度、以及两半时长之和都与原片段精确一致；
 * 代价是曲线片段被裁剪后会变成等价的 16 段分段表示（曲线无法在改变采样网格
 * 后仍然逐点等值，实测把曲线重新拟合会有 0.7%~17% 的时长漂移）。
 */
export function sliceSpeedRange(
  clip: {
    sourceStart: number
    sourceEnd: number
    type?: 'video' | 'freeze' | 'image'
    speedSegments?: { at: number; speed: number }[]
    speedCurve?: { at: number; speed: number }[]
  },
  from: number,
  to: number,
): Partial<{
  speedSegments: { at: number; speed: number }[]
  speedCurve: { at: number; speed: number }[]
}> {
  // 静帧的 sourceStart..sourceEnd 编码的是「停留时长」，不是内容区间，没有变速可切。
  if (clip.type === 'freeze' || clip.type === 'image') return {}
  const effective = clipSpeedSegments(clip)
  const spanStart = clip.sourceStart
  const spanEnd = clip.sourceEnd
  if (!effective || !(spanEnd - spanStart > 0)) return {}
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(to - from > 1e-9)) return {}
  // 区间没变（例如在片段最右端分割得到的右手边）→ 保持原表示，不做无谓的曲线降级。
  if (Math.abs(from - spanStart) < 1e-9 && Math.abs(to - spanEnd) < 1e-9) return {}
  const sliced = sliceSpeedSegments(effective, spanStart, spanEnd, from, to)
  if (!sliced) return {}
  return { speedSegments: sliced, speedCurve: undefined }
}

/**
 * 分段变速的 setpts 表达式（**一条滤镜完成时间映射**，不需要 trim+concat）：
 *
 *   f(T) = 段偏移 + (T - 段源起点) / 段速      （T 是 trim 之后从 0 起的源时间）
 *
 * 用嵌套 `if()` 表达分段线性映射。两段例子（0–5s @2x，之后 @0.5x）：
 *   setpts='if(lt(T,5),(T/2),(2.5+(T-5)/0.5))/TB'
 *
 * 后面紧跟的 fps 滤镜会把 VFR 时间戳转成 CFR（丢帧/复制帧），
 * 与原来单一 `setpts=PTS/speed` 的处理方式一致。
 */
export function speedSegmentedVideoFilter(clip: {
  sourceStart: number
  sourceEnd: number
  speedSegments?: { at: number; speed: number }[]
}): string | null {
  const plan = segmentPlan(clip)
  if (!plan || plan.length < 2) return null
  const round = (value: number): string => String(Number(value.toFixed(6)))
  const last = plan[plan.length - 1]
  const lastStart = last.sourceStart - clip.sourceStart
  let expression = `(${round(last.timelineOffset)}+(T-${round(lastStart)})/${round(last.speed)})`
  for (let index = plan.length - 2; index >= 0; index -= 1) {
    const segment = plan[index]
    const next = plan[index + 1]
    const relativeStart = segment.sourceStart - clip.sourceStart
    const branch =
      segment.timelineOffset <= 1e-9
        ? `((T-${round(relativeStart)})/${round(segment.speed)})`
        : `(${round(segment.timelineOffset)}+(T-${round(relativeStart)})/${round(segment.speed)})`
    const nextStart = next.sourceStart - clip.sourceStart
    expression = `if(lt(T,${round(nextStart)}),${branch},${expression})`
  }
  return `setpts='${expression}/TB'`
}

export function speedVideoFilter(speed: number): string | null {
  const target = clampSpeed(speed)
  if (Math.abs(target - 1) < 1e-6) return null
  return `setpts=PTS/${Number(target.toFixed(6))}`
}

/** 浏览器 `HTMLMediaElement.playbackRate` 的规格支持区间。 */
export const PLAYBACK_RATE_MIN = 0.0625
export const PLAYBACK_RATE_MAX = 16

/**
 * 把倍率收敛到浏览器实际支持的播放速率区间。
 * 独立于 SPEED_MIN/MAX 判断（否则 0.01 会先被抬到 0.1，永远检不出越界）；
 * `clamped` 为 true 表示视图速率被钳制，供上层提示。
 */
export function clampPlaybackRate(speed: number): { rate: number; clamped: boolean } {
  const raw = typeof speed === 'number' && Number.isFinite(speed) && speed > 0 ? speed : 1
  if (raw < PLAYBACK_RATE_MIN) return { rate: PLAYBACK_RATE_MIN, clamped: true }
  if (raw > PLAYBACK_RATE_MAX) return { rate: PLAYBACK_RATE_MAX, clamped: true }
  return { rate: raw, clamped: false }
}

/** 该片段是否允许变速（定格与图片是静帧，没有可变速的播放行为）。 */
export function canChangeClipSpeed(clip: { type?: Clip['type'] }): boolean {
  return clip.type !== 'freeze' && clip.type !== 'image'
}

/**
 * 实时预览：返回一个「只改目标片段倍率」的新工程，用于时间轴/预览的拖动反馈。
 * 纯函数、不改原对象、不进撤销栈（由 store 的 previewPatch 承担）。
 */
export function applySpeedPreview(project: Project, clipId: string, speed: number): Project {
  const target = clampSpeed(speed)
  const patch = (clip: Clip): Clip => (clip.id === clipId ? { ...clip, speed: target } : clip)
  const touchedMain = project.clips.some((clip) => clip.id === clipId)
  const touchedOverlay = (project.overlayTracks ?? []).some((track) =>
    track.clips.some((clip) => clip.id === clipId),
  )
  if (!touchedMain && !touchedOverlay) return project
  return {
    ...project,
    clips: touchedMain ? project.clips.map(patch) : project.clips,
    overlayTracks: touchedOverlay
      ? (project.overlayTracks ?? []).map((track) => ({
          ...track,
          clips: track.clips.map(patch),
        }))
      : project.overlayTracks,
  }
}

/**
 * 给「已经按源区间 `[sourceStart, sourceEnd]` 裁好」的音频流做变速，生成一条
 * `filter_complex` 片段（**不含音量 / 淡入淡出**，那些仍由 exportPlan 收尾时应用）。
 *
 * 用途：动画片段烘焙成中间视频时，音轨必须与「时间轴时长」对齐，否则音画不同步。
 * 直接复用本模块的 {@link speedAudioFilters}：
 * - 单倍率 → `input,atempo=…`（keepPitch=false 时用 asetrate+aresample）；
 * - 分段 / 曲线 → 逐段 `atrim`（相对输入起点；输入本身已用 `-ss/-t` 裁过）+ `asetpts`
 *   + 该段变速，再 `concat` 回一条流（atempo 只支持恒定倍率，必须逐段处理）。
 *
 * 返回 `null` 表示「1x 且没有分段」——不需要任何滤镜，调用方直接 `-map` 输入即可。
 */
export function speedAudioGraph(
  clip: {
    sourceStart: number
    sourceEnd: number
    type?: Clip['type']
    speed?: number
    keepPitch?: boolean
    speedSegments?: { at: number; speed: number }[]
    speedCurve?: { at: number; speed: number }[]
  },
  inputLabel: string,
  outputLabel: string,
): string | null {
  const span = clip.sourceEnd - clip.sourceStart
  if (!Number.isFinite(span) || span <= 0) return null
  const keepPitch = clipKeepsPitch(clip)
  // 静帧没有可变速的播放行为（烘焙时用静音轨，不该走到这里）。
  const plan = clip.type === 'freeze' || clip.type === 'image' ? null : segmentPlan(clip)
  const round = (value: number): string => String(Number(value.toFixed(6)))
  if (!plan || plan.length < 2) {
    const filters = speedAudioFilters(clipSpeedValue(clip), keepPitch)
    if (filters.length === 0) return null
    return `${inputLabel}${filters.join(',')}${outputLabel}`
  }
  const base = outputLabel.replace(/[[\]]/g, '')
  const lines: string[] = []
  const labels: string[] = []
  plan.forEach((piece, index) => {
    // 输入流从 sourceStart 开始计时 → 段的裁剪点要减去 sourceStart。
    const start = Math.max(0, piece.sourceStart - clip.sourceStart)
    const end = Math.min(span, Math.max(0, piece.sourceEnd - clip.sourceStart))
    if (end - start <= 1e-9) return
    const label = `[${base}sg${index}]`
    const filters = speedAudioFilters(piece.speed, keepPitch)
    lines.push(
      `${inputLabel}atrim=start=${round(start)}:end=${round(end)},asetpts=PTS-STARTPTS` +
        `${filters.length ? `,${filters.join(',')}` : ''}${label}`,
    )
    labels.push(label)
  })
  if (labels.length === 0) return null
  // 只有一段时不用 concat（部分 ffmpeg 构建对 concat n=1 不友好）。
  if (labels.length === 1) return lines[0].replace(labels[0], outputLabel)
  lines.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1${outputLabel}`)
  return lines.join(';\n')
}