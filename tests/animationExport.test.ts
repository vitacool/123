import { describe, expect, it } from 'vitest'
import {
  ANIMATION_SINGLE_CLIP_FRAME_LIMIT,
  ANIMATION_TOTAL_FRAME_LIMIT,
  animatedClips,
  animationFrameCount,
  animationPerformanceHint,
  bakeAnimatedClip,
  estimateAnimationFrames,
  hasAnyAnimation,
} from '../src/editor/core/animationExport'
import { resolveClipOverrides } from '../src/editor/core/animation'
import { computeClipGeometry } from '../src/editor/core/geometry'
import { createInitialProject } from '../src/editor/core/operations'
import type { AnimationMap, Clip, Easing, Keyframe, Project } from '../src/editor/core/types'

const key = (t: number, value: number, ease: Easing = 'linear'): Keyframe => ({ t, value, ease })

const anim = (): AnimationMap => ({
  'position.x': [key(0, -0.25), key(0.5, 0.25), key(1, -0.25)],
})

const clipWith = (id: string, extra: Partial<Clip> = {}): Clip => ({
  ...createInitialProject({ url: 'blob:x', duration: 20 }, id).clips[0],
  ...extra,
})

function projectWith(animated: boolean): Project {
  const base = createInitialProject({ url: 'blob:x', duration: 20 }, 'main-1')
  const main: Clip = { ...base.clips[0], sourceEnd: 4 }
  const plain: Clip = { ...base.clips[0], id: 'main-2', sourceStart: 4, sourceEnd: 8 }
  const animatedMain: Clip = { ...main, ...(animated ? { anim: anim() } : {}) }
  return {
    ...base,
    clips: [animatedMain, plain],
    overlayTracks: [
      {
        id: 'ov',
        name: '叠加 1',
        muted: false,
        hidden: false,
        enabled: true,
        locked: false,
        solo: false,
        clips: [clipWith('ov-1', { sourceEnd: 2, ...(animated ? { anim: anim() } : {}) })],
      },
    ],
  }
}

describe('动画片段扫描', () => {
  it('只收集带动画的片段（主轨 + 叠加轨），并给出轨道归属', () => {
    const refs = animatedClips(projectWith(true))
    expect(refs.map((item) => item.clip.id)).toEqual(['main-1', 'ov-1'])
    expect(refs.map((item) => item.trackId)).toEqual([null, 'ov'])
  })

  it('没有动画时 hasAnyAnimation 为 false（导出走原路径）', () => {
    expect(hasAnyAnimation(projectWith(false))).toBe(false)
    expect(animatedClips(projectWith(false))).toEqual([])
  })

  it('帧数 = ceil(时长 × fps)', () => {
    expect(animationFrameCount(clipWith('c', { sourceEnd: 4, anim: anim() }), 30)).toBe(120)
    expect(animationFrameCount(clipWith('c', { sourceEnd: 4, anim: anim() }), 25)).toBe(100)
    // 极短片段至少 1 帧
    expect(animationFrameCount(clipWith('c', { type: 'image', sourceEnd: 0.01, anim: anim() }), 30)).toBe(1)
  })
})

describe('性能提示阈值', () => {
  const heavy = (seconds: number): Project => {
    const base = createInitialProject({ url: 'blob:x', duration: 20 }, 'h1')
    return {
      ...base,
      clips: [{ ...base.clips[0], sourceEnd: seconds, anim: anim() }],
    }
  }

  it('帧数在阈值内不提示', () => {
    // 90s @30fps = 2700 帧 < 3000，且单片段 2700 > 1800 → 会提示单片段
    expect(animationPerformanceHint(heavy(50), 30)).toBeNull() // 1500 帧
  })

  it('总帧数超过 3000 时提示（含具体帧数）', () => {
    const hint = animationPerformanceHint(heavy(101), 30)
    expect(hint).toContain('动画片段较多')
    expect(hint).toContain(`${estimateAnimationFrames(heavy(101), 30)} 帧`)
  })

  it('单片段超过 1800 帧时提示单片段帧数', () => {
    const hint = animationPerformanceHint(heavy(61), 30)
    expect(hint).toContain('单个片段最长')
    expect(ANIMATION_SINGLE_CLIP_FRAME_LIMIT).toBe(1800)
    expect(ANIMATION_TOTAL_FRAME_LIMIT).toBe(3000)
  })
})

describe('烘焙成普通片段', () => {
  it('重置几何/不透明度/调色/动画，并指向中间文件', () => {
    const baked = bakeAnimatedClip(
      clipWith('c', {
        sourceStart: 1,
        sourceEnd: 3,
        rotation: 30,
        scale: 1.8,
        position: { x: 0.3, y: -0.2 },
        flipH: true,
        crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
        opacity: 0.5,
        blendMode: 'screen',
        speed: 2,
        anim: anim(),
        color: { brightness: 10 },
      }),
      'blob:anim-0',
      2.5,
    )
    expect(baked.sourceUrl).toBe('blob:anim-0')
    expect(baked.type).toBe('video')
    expect([baked.sourceStart, baked.sourceEnd]).toEqual([0, 2.5])
    expect([baked.rotation, baked.scale, baked.opacity]).toEqual([0, 1, 1])
    expect(baked.position).toEqual({ x: 0, y: 0 })
    expect([baked.flipH, baked.flipV]).toEqual([false, false])
    expect(baked.crop).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expect(baked.blendMode).toBe('normal')
    expect(baked.speed).toBe(1)
    expect(baked.anim).toBeUndefined()
    expect(baked.color).toBeUndefined()
    expect(baked.background).toBeUndefined()
  })
})

describe('轨迹：片段中心横向位置（导出/预览共用的几何）', () => {
  it('0s / 1s / 2s 的中心横向偏移分别为 −0.25W / +0.25W / −0.25W', () => {
    const width = 1280
    const height = 720
    const clip = clipWith('c', {
      type: 'image',
      sourceStart: 0,
      sourceEnd: 2,
      scale: 0.5,
      anim: anim(),
    })
    const asset = { width: 400, height: 300 }
    const centers = [0, 1, 2].map((localTime) => {
      const overrides = resolveClipOverrides(clip, localTime, 2)
      const geometry = computeClipGeometry(
        { ...clip, position: overrides.position, scale: overrides.scale, rotation: overrides.rotation },
        asset,
        width,
        height,
      )
      return {
        localTime,
        offset: (geometry.rendered.x + geometry.rendered.w / 2 - width / 2) / width,
        positionX: overrides.position.x,
      }
    })
    expect(centers[0].positionX).toBeCloseTo(-0.25, 6)
    expect(centers[1].positionX).toBeCloseTo(0.25, 6)
    expect(centers[2].positionX).toBeCloseTo(-0.25, 6)
    // 中心偏移与 position.x 同号同值（几何以画布宽归一化）
    for (const point of centers) {
      expect(point.offset).toBeCloseTo(point.positionX, 3)
    }
    // 单调：0 → 1 向右、1 → 2 向左（运动先右后左，无跳变）
    expect(centers[1].offset).toBeGreaterThan(centers[0].offset)
    expect(centers[2].offset).toBeLessThan(centers[1].offset)
  })

  it('中间时刻（0.5s）落在两端之间，插值连续', () => {
    const clip = clipWith('c', { type: 'image', sourceStart: 0, sourceEnd: 2, anim: anim() })
    const a = resolveClipOverrides(clip, 0, 2).position.x
    const b = resolveClipOverrides(clip, 0.5, 2).position.x
    const c = resolveClipOverrides(clip, 1, 2).position.x
    expect(b).toBeGreaterThan(a)
    expect(b).toBeLessThan(c)
    // 线性缓动 → 中点正好是两端均值
    expect(b).toBeCloseTo((a + c) / 2, 6)
  })
})