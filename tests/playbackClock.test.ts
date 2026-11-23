import { describe, expect, it } from 'vitest'
import {
  advancePlaybackClock,
  createPlaybackClockAnchor,
  type PlaybackClockAnchor,
} from '../src/editor/core/playbackClock'

/**
 * 播放时钟的纯逻辑：把原来只存在于 Preview rAF 里的数学拿出来单测。
 *
 * 覆盖三类容易出错的行为：
 * 1. 正常推进 / 到总时长夹住；
 * 2. 主视频停滞（缓冲/等待/暂停）时**冻结**，恢复后不跳帧；
 * 3. 播放头被外部改动（重播归零 / 拖动 / 跳转）时重新锚定 ——
 *    这正是「点重播没反应」那个 bug 的根因。
 */

const anchor = (overrides: Partial<PlaybackClockAnchor> = {}): PlaybackClockAnchor => ({
  ...createPlaybackClockAnchor(0, 1000),
  ...overrides,
})

const playingVideo = (currentTime: number) => ({ currentTime, paused: false, readyState: 4 })
/** 缓冲/等待中：playing 但 readyState<2 —— 这才是「waiting 时时钟暂停」的场景。 */
const bufferingVideo = (currentTime: number) => ({ currentTime, paused: false, readyState: 1 })

describe('正常推进', () => {
  it('墙钟推进 1 秒 → 时间轴推进 1 秒', () => {
    const result = advancePlaybackClock(anchor({ lastVideoTime: 0 }), {
      now: 2000,
      video: playingVideo(1),
      externalPlayhead: 0,
      total: 10,
    })
    expect(result.time).toBeCloseTo(1, 5)
    expect(result.externalJump).toBe(false)
  })

  it('到达总时长后夹住，不越过', () => {
    const result = advancePlaybackClock(anchor({ lastVideoTime: 0 }), {
      now: 9000,
      video: playingVideo(8),
      externalPlayhead: 0,
      total: 3,
    })
    expect(result.time).toBe(3)
  })
})

describe('主视频停顿时冻结时钟', () => {
  it('视频在缓冲（waiting）→ 时间不推进（不跟墙钟走）', () => {
    // 第一帧：readyState<2 → 进入停滞
    const first = advancePlaybackClock(anchor({ lastVideoTime: 1 }), {
      now: 1100,
      video: bufferingVideo(1),
      externalPlayhead: 0,
      total: 10,
    })
    expect(first.stalled).toBe(true)
    expect(first.time).toBeCloseTo(0, 5)

    // 再等 1 秒仍然缓冲 → 时间依旧停在原地（不是 1.1s）
    const second = advancePlaybackClock(first.anchor, {
      now: 2100,
      video: bufferingVideo(1),
      externalPlayhead: first.time,
      total: 10,
    })
    expect(second.stalled).toBe(true)
    expect(second.time).toBeCloseTo(0, 5)
  })

  it('只是「这一帧 currentTime 没变」不算停滞（避免误冻结）', () => {
    const result = advancePlaybackClock(anchor({ lastVideoTime: 1 }), {
      now: 1100,
      video: playingVideo(1),
      externalPlayhead: 0,
      total: 10,
    })
    expect(result.stalled).toBe(false)
    expect(result.time).toBeCloseTo(0.1, 2)
  })

  it('视频恢复推进后，停滞的那段不算进播放时间（不跳帧）', () => {
    // 停滞开始于 1100ms
    const stalled = advancePlaybackClock(anchor({ lastVideoTime: 1 }), {
      now: 1100,
      video: bufferingVideo(1),
      externalPlayhead: 0,
      total: 10,
    })
    // 到 3100ms 恢复推进（缓冲了 2 秒），这 2 秒不计入播放时间
    const resumed = advancePlaybackClock(stalled.anchor, {
      now: 3100,
      video: playingVideo(1.1),
      externalPlayhead: stalled.time,
      total: 10,
    })
    expect(resumed.stalled).toBe(false)
    // 恢复的那一帧时间仍然接近 0（2 秒停滞被冻结掉）
    expect(resumed.time).toBeLessThan(0.1)
  })

  it('paused / readyState<2 同样算停滞', () => {
    const paused = advancePlaybackClock(anchor({ lastVideoTime: 5 }), {
      now: 1500,
      video: { currentTime: 5.2, paused: true, readyState: 4 },
      externalPlayhead: 0,
      total: 10,
    })
    expect(paused.stalled).toBe(true)

    const buffering = advancePlaybackClock(anchor({ lastVideoTime: 5 }), {
      now: 1500,
      video: { currentTime: 5.2, paused: false, readyState: 1 },
      externalPlayhead: 0,
      total: 10,
    })
    expect(buffering.stalled).toBe(true)
  })

  it('video 被浏览器拒绝播放（paused）→ 宽限期后必须退回墙钟，不能永远不动', () => {
    // 视频一直 paused（autoplay 被拒）：前 1.5s 冻结，之后退回墙钟
    const pausedVideo = { currentTime: 0, paused: true, readyState: 4 }
    let clock = anchor({ lastVideoTime: 0 })
    let time = 0
    for (const now of [1000, 1100, 1500, 2000]) {
      const result = advancePlaybackClock(clock, {
        now,
        video: pausedVideo,
        externalPlayhead: time,
        total: 10,
      })
      clock = result.anchor
      time = result.time
    }
    // 1000~2000ms 都在宽限期内 → 时间仍然是 0
    expect(time).toBeCloseTo(0, 5)

    // 到 3000ms（>1500ms 宽限）→ 退回墙钟，时间开始推进
    const resumed = advancePlaybackClock(clock, {
      now: 3000,
      video: pausedVideo,
      externalPlayhead: 0,
      total: 10,
    })
    expect(resumed.stalled).toBe(false)

    const later = advancePlaybackClock(resumed.anchor, {
      now: 3500,
      video: pausedVideo,
      externalPlayhead: resumed.time,
      total: 10,
    })
    expect(later.time).toBeGreaterThan(0.3)
  })

  it('没有视频可跟（定格/空隙/纯音频）→ 用墙钟，且不会永久卡住', () => {
    // 先停滞
    const stalled = advancePlaybackClock(anchor({ lastVideoTime: 1 }), {
      now: 1100,
      video: bufferingVideo(1),
      externalPlayhead: 0,
      total: 10,
    })
    // 下一帧没有视频了 → 解除冻结（这一帧从 now 重新起算，时间仍为 0）
    const resumed = advancePlaybackClock(stalled.anchor, {
      now: 1300,
      video: null,
      externalPlayhead: stalled.time,
      total: 10,
    })
    expect(resumed.stalled).toBe(false)
    expect(resumed.time).toBeCloseTo(0, 5)

    // 再下一帧开始按墙钟推进（说明不会永久卡住）
    const next = advancePlaybackClock(resumed.anchor, {
      now: 1500,
      video: null,
      externalPlayhead: resumed.time,
      total: 10,
    })
    expect(next.time).toBeCloseTo(0.2, 2)
  })
})

describe('外部改动播放头 → 重新锚定（重播 / 拖动 / 跳转）', () => {
  it('播放中把播放头归零（点重播）→ 本帧立即回到 0，而不是继续往前跑', () => {
    // 已经播到 ~2 秒
    const playing = advancePlaybackClock(anchor({ lastVideoTime: 0 }), {
      now: 3000,
      video: playingVideo(2),
      externalPlayhead: 0,
      total: 10,
    })
    expect(playing.time).toBeCloseTo(2, 5)

    // 外部把 playhead 设为 0（replay 的 set({playhead: 0, isPlaying: true})）
    const replayed = advancePlaybackClock(playing.anchor, {
      now: 3050,
      video: playingVideo(2),
      externalPlayhead: 0,
      total: 10,
    })
    expect(replayed.externalJump).toBe(true)
    expect(replayed.time).toBeCloseTo(0, 5)
    // 后续帧从这个新锚点继续推进
    const later = advancePlaybackClock(replayed.anchor, {
      now: 3550,
      video: playingVideo(2.5),
      externalPlayhead: replayed.time,
      total: 10,
    })
    expect(later.time).toBeCloseTo(0.5, 1)
  })

  it('播放中把播放头拖到 5 秒 → 立即跳到 5 秒继续', () => {
    const playing = advancePlaybackClock(anchor({ lastVideoTime: 0 }), {
      now: 1500,
      video: playingVideo(0.5),
      externalPlayhead: 0,
      total: 10,
    })
    const jumped = advancePlaybackClock(playing.anchor, {
      now: 1600,
      video: playingVideo(0.5),
      externalPlayhead: 5,
      total: 10,
    })
    expect(jumped.externalJump).toBe(true)
    expect(jumped.time).toBeCloseTo(5, 5)
  })

  it('10Hz 同步的正常滞后（<0.25s）不会被误判成外部改动', () => {
    const playing = advancePlaybackClock(anchor({ lastVideoTime: 0 }), {
      now: 2000,
      video: playingVideo(1),
      externalPlayhead: 0,
      total: 10,
    })
    // store 里的值落后 0.1s（上一帧发布的），属于正常节流范围
    const next = advancePlaybackClock(playing.anchor, {
      now: 2100,
      video: playingVideo(1.1),
      externalPlayhead: playing.time - 0.1,
      total: 10,
    })
    expect(next.externalJump).toBe(false)
  })

  it('播放头为负/超界时夹到 [0, total]', () => {
    const negative = advancePlaybackClock(anchor(), {
      now: 1000,
      video: null,
      externalPlayhead: -2,
      total: 10,
    })
    expect(negative.time).toBe(0)

    const overflow = advancePlaybackClock(anchor(), {
      now: 1000,
      video: null,
      externalPlayhead: 99,
      total: 10,
    })
    expect(overflow.time).toBe(10)
  })
})