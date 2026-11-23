/**
 * 播放时钟的**纯逻辑**（从 Preview 的 rAF 循环里抽出来，便于单测）。
 *
 * 为什么单独抽：这段数学有三个容易错的点，而且都在 rAF 里跑、很难用单测覆盖：
 * 1. **以主视频推进为准**：视频缓冲/waiting/暂停时不推进时间轴时间（否则恢复播放后音画错位）；
 * 2. **外部改动**：播放中点「重播」（playhead 归零）或拖动播放头时，必须重新锚定，
 *    否则运行中的循环会把刚设置的位置覆盖回去（曾经的「点重播没反应」bug）；
 * 3. **边界**：到达总时长要夹住，不能越过。
 */

export interface PlaybackClockAnchor {
  /** 锚点：锚定时刻的墙钟毫秒。 */
  anchorWall: number
  /** 锚点：锚定时刻的时间轴秒数。 */
  anchorTimeline: number
  /** 视频停滞开始的时刻；null 表示正在推进（或没有视频）。 */
  stalledSince: number | null
  /** 上一次观察到的视频 currentTime，用于判断「是否在推进」。 */
  lastVideoTime: number
  /** 视频从什么时候开始处于 paused；用于区分「短暂暂停」与「播放被浏览器阻止」。 */
  pausedSince: number | null
  /** 上一次**由本循环发布**的时间轴时间，用于识别外部改动。 */
  lastPublished: number
}

export interface PlaybackVideoState {
  currentTime: number
  paused: boolean
  readyState: number
}

export interface PlaybackClockInput {
  /** 当前墙钟毫秒。 */
  now: number
  /** 主视频状态；没有可跟的视频（定格/空隙/纯音频）时传 null。 */
  video: PlaybackVideoState | null
  /** store 里的播放头（可能是外部改的）。 */
  externalPlayhead: number
  /** 工程总时长（秒）。 */
  total: number
  /** 判定「外部改动」的阈值（秒），默认 0.25。 */
  externalThreshold?: number
  /**
   * 「paused 算停滞」的宽限毫秒数，默认 1500。
   *
   * 为什么需要：视频 paused 有两种完全不同的原因 ——
   * (a) 短暂暂停（切片段、seek 中）→ 应当冻结时钟，避免抢跑；
   * (b) 浏览器拒绝了 play()（自动播放策略）→ 若也冻结，播放头就永远不动，
   *     整个播放"死掉"（Firefox 无头环境下就是这么被 E2E 抓到的）。
   * 所以只在前 grace 毫秒内把 paused 当停滞，超过就退回墙钟，
   * 由预览层的「浏览器阻止了视频播放」提示兜底。
   */
  stallGraceMs?: number
}

export interface PlaybackClockResult {
  /** 下一帧要用的锚点（不可变，直接替换）。 */
  anchor: PlaybackClockAnchor
  /** 本帧的时间轴时间（已夹到 [0, total]）。 */
  time: number
  /** 本帧视频是否处于停滞（缓冲/等待/暂停）。 */
  stalled: boolean
  /** 本帧是否检测到播放头被外部改动（重播/拖动/跳转）。 */
  externalJump: boolean
}

const EPSILON = 1e-4

export function advancePlaybackClock(
  anchor: PlaybackClockAnchor,
  input: PlaybackClockInput,
): PlaybackClockResult {
  const threshold = input.externalThreshold ?? 0.25
  const { now, video, externalPlayhead, total } = input

  let next: PlaybackClockAnchor = { ...anchor, stalledSince: anchor.stalledSince }

  // ---- 1. 外部改动（重播归零 / 拖动播放头 / 快捷键跳转）→ 直接重锚 ----
  const externalJump = Math.abs(externalPlayhead - anchor.lastPublished) > threshold
  if (externalJump) {
    next = {
      anchorWall: now,
      anchorTimeline: externalPlayhead,
      stalledSince: null,
      lastVideoTime: video?.currentTime ?? 0,
      pausedSince: video?.paused ? now : null,
      lastPublished: externalPlayhead,
    }
    const time = Math.min(total, Math.max(0, externalPlayhead))
    next.lastPublished = time
    return { anchor: next, time, stalled: false, externalJump: true }
  }

  // ---- 2. 停滞检测：视频不推进时冻结墙钟 ----
  let stalled = false
  if (video) {
    const grace = input.stallGraceMs ?? 1500
    // paused 的持续时间：超过宽限即视为「播放被阻止」，此时不能继续冻结。
    if (video.paused) {
      if (next.pausedSince === null) next.pausedSince = now
    } else {
      next.pausedSince = null
    }
    const pausedTooLong =
      video.paused && next.pausedSince !== null && now - next.pausedSince > grace
    const buffering = video.readyState < 2
    const progressing =
      !video.paused &&
      video.readyState >= 2 &&
      Math.abs(video.currentTime - next.lastVideoTime) > EPSILON
    next.lastVideoTime = video.currentTime

    // 该不该冻结：缓冲中一定冻结；paused 只在宽限期内冻结。
    const shouldStall = buffering || (video.paused && !pausedTooLong)

    if (progressing) {
      if (next.stalledSince !== null) {
        next.anchorWall = now
        next.stalledSince = null
      }
    } else if (shouldStall) {
      stalled = true
      if (next.stalledSince === null) next.stalledSince = now
      // 停滞期间**每帧**都把锚点墙钟推到 now：时间轴完全不推进。
      next.anchorWall = now
    } else if (next.stalledSince !== null) {
      // 播放被浏览器阻止（paused 超过宽限）：退回墙钟，别让播放头永远不动。
      next.anchorWall = now
      next.stalledSince = null
    }
  } else if (next.stalledSince !== null) {
    // 上一帧是停滞、这一帧没有视频可跟 → 从 now 开始按墙钟继续（停滞时长不计入）。
    next.anchorWall = now
    next.stalledSince = null
  }

  // ---- 3. 推进并夹取 ----
  const elapsed = Math.max(0, (now - next.anchorWall) / 1000)
  const time = Math.min(total, Math.max(0, next.anchorTimeline + elapsed))
  next.lastPublished = time
  return { anchor: next, time, stalled, externalJump: false }
}

/** 新建锚点（播放开始时调用）。 */
export function createPlaybackClockAnchor(startPlayhead: number, now: number): PlaybackClockAnchor {
  return {
    anchorWall: now,
    anchorTimeline: startPlayhead,
    stalledSince: null,
    lastVideoTime: 0,
    pausedSince: null,
    lastPublished: startPlayhead,
  }
}