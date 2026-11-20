import { describe, expect, it } from 'vitest'
import { buildExportPlan } from '../src/editor/core/exportPlan'
import { buildVolumeExpression } from '../src/editor/core/animationExpr'
import { evalAnimation } from '../src/editor/core/animation'
import { clipGainAt } from '../src/editor/core/clipAudio'
import { hasAnyAnimation } from '../src/editor/core/animationExport'
import { bakeAnimatedClip } from '../src/editor/core/animationExport'
import { createInitialProject } from '../src/editor/core/operations'
import type { AudioClip, Clip, Project, SourceInfo } from '../src/editor/core/types'

const SOURCE: SourceInfo = {
  url: 'blob:test-volume',
  name: 'test.mp4',
  size: 1024,
  duration: 20,
  width: 1920,
  height: 1080,
  kind: 'video',
  hasAudio: true,
}

function videoProject(extra: Partial<Clip> = {}): Project {
  const base = createInitialProject({ url: SOURCE.url, duration: 20 }, 'c1')
  return {
    ...base,
    aspectRatio: '16:9',
    exportQuality: { resolution: '480p', fps: 30 },
    clips: [
      {
        ...base.clips[0],
        sourceStart: 0,
        sourceEnd: 5,
        ...extra,
      },
    ],
  }
}

function audioProject(extra: Partial<AudioClip> = {}, trackVolume = 0.8): Project {
  const base = videoProject()
  return {
    ...base,
    audioTracks: [
      {
        id: 'audio-1',
        name: '音频 1',
        muted: false,
        hidden: false,
        enabled: true,
        locked: false,
        solo: false,
        volume: trackVolume,
        clips: [
          {
            id: 'audio-clip-1',
            sourceUrl: SOURCE.url,
            sourceStart: 0,
            sourceEnd: 4,
            start: 1,
            volume: 1,
            fadeIn: 0,
            fadeOut: 0,
            ...extra,
          },
        ],
      },
    ],
  }
}

function evaluateVolume(expression: string, time: number): number {
  const trimmed = expression.trim()
  if (trimmed.startsWith('if(')) {
    const close = trimmed.lastIndexOf(')')
    const body = trimmed.slice(3, close)
    const [condition, thenExpr, elseExpr] = splitIfArgs(body)
    const match = /^lt\(t,([^)]+)\)$/.exec(condition.trim())
    if (!match) throw new Error(`无法解析条件: ${condition}`)
    const threshold = Number(match[1])
    return time < threshold
      ? evaluateVolume(thenExpr, time)
      : evaluateVolume(elseExpr, time)
  }
  // 只剩数字 / t / + - * / 与括号，交给 JS 计算即可。
  const fn = new Function('t', `return (${trimmed})`) as (t: number) => number
  return fn(time)
}

function splitIfArgs(body: string): [string, string, string] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  if (parts.length !== 3) throw new Error(`if 参数不是 3 段: ${body}`)
  return parts as [string, string, string]
}

const KEYS = [
  { t: 0, value: 1, ease: 'linear' as const },
  { t: 0.5, value: 0.2, ease: 'linear' as const },
  { t: 1, value: 1, ease: 'linear' as const },
]

describe('动画表达式 = 预览求值（commit 1 验收 #1/#4）', () => {
  it('线性关键帧在 N 个采样点上与 evalAnimation 的差 < 0.01', () => {
    const duration = 2
    const expression = buildVolumeExpression(KEYS, duration)
    expect(expression).toBeTruthy()
    const samples = Array.from({ length: 41 }, (_, index) => (index / 40) * duration)
    for (const time of samples) {
      const fromExpression = evaluateVolume(expression!, time)
      const fromAnimation = evalAnimation(KEYS, time / duration, 1)
      expect(Math.abs(fromExpression - fromAnimation)).toBeLessThan(0.01)
    }
  })

  it('非线性的缓动用 4 段线性近似，采样误差保持在可接受范围', () => {
    const keys = [
      { t: 0, value: 1, ease: 'linear' as const },
      { t: 1, value: 0, ease: 'easeIn' as const },
    ]
    const duration = 2
    const expression = buildVolumeExpression(keys, duration)!
    for (let index = 0; index <= 40; index += 1) {
      const time = (index / 40) * duration
      expect(
        Math.abs(evaluateVolume(expression, time) - evalAnimation(keys, time / duration, 1)),
      ).toBeLessThan(0.08)
    }
  })

  it('首帧之前返回首帧值，末帧之后返回末帧值', () => {
    const keys = [
      { t: 0.25, value: 0.3, ease: 'linear' as const },
      { t: 0.75, value: 0.9, ease: 'linear' as const },
    ]
    const expression = buildVolumeExpression(keys, 4)!
    expect(evaluateVolume(expression, 0)).toBeCloseTo(0.3, 5)
    expect(evaluateVolume(expression, 4)).toBeCloseTo(0.9, 5)
  })

  it('12 个关键帧会先重采样为 8 个点，表达式长度受控且可解析', () => {
    const keys = Array.from({ length: 12 }, (_, index) => ({
      t: index / 11,
      value: 0.1 + (index % 4) * 0.4,
      ease: 'linear' as const,
    }))
    const expression = buildVolumeExpression(keys, 3)!
    expect((expression.match(/if\(lt\(t,/g) ?? []).length).toBeLessThanOrEqual(8)
    for (const time of [0, 0.5, 1, 2, 3]) {
      expect(Number.isFinite(evaluateVolume(expression, time))).toBe(true)
    }
  })

  it('预览 clipGainAt 与表达式使用同一份数据/插值', () => {
    const clip: Clip = {
      ...videoProject().clips[0],
      sourceStart: 0,
      sourceEnd: 2,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
      anim: { volume: KEYS },
    }
    const duration = 2
    const expression = buildVolumeExpression(KEYS, duration)!
    for (let index = 0; index <= 40; index += 1) {
      const local = (index / 40) * duration
      expect(Math.abs(clipGainAt(clip, local) - evaluateVolume(expression, local))).toBeLessThan(
        0.01,
      )
    }
  })

  it('音频片段的预览音量同样与导出表达式一致', () => {
    const clip = audioProject({ anim: { volume: KEYS } }).audioTracks![0].clips[0]
    const duration = 4
    const expression = buildVolumeExpression(KEYS, duration)!
    for (let index = 0; index <= 40; index += 1) {
      const local = (index / 40) * duration
      expect(Math.abs(clipGainAt(clip, local) - evaluateVolume(expression, local))).toBeLessThan(
        0.01,
      )
    }
  })
})

describe('音量关键帧导出链（commit 1 验收 #3/#4/#5）', () => {
  it('视频片段的 volume 在 atempo 之后、afade 之前', () => {
    const project = videoProject({
      speed: 2,
      keepPitch: true,
      volume: 1,
      fadeIn: 0.5,
      anim: { volume: KEYS },
    })
    const graph = buildExportPlan(project, [SOURCE], true).graph
    const atempo = graph.indexOf('atempo')
    const volumeExpr = graph.indexOf("volume='")
    const fade = graph.indexOf('afade=t=in')
    expect(atempo).toBeGreaterThan(-1)
    expect(volumeExpr).toBeGreaterThan(atempo)
    expect(fade).toBeGreaterThan(volumeExpr)
    expect(graph).toContain('eval=frame')
    expect(graph).toContain('afade=t=in:st=0:d=0.5')
  })

  it('音频轨片段的 volume 在 adelay 之前，且轨道增益乘进表达式', () => {
    const project = audioProject({ fadeIn: 0.5, anim: { volume: KEYS } })
    const plan = buildExportPlan(project, [SOURCE], true)
    const graph = plan.graph
    const volume = graph.indexOf("volume='")
    const delay = graph.indexOf('adelay=1000|1000')
    expect(volume).toBeGreaterThan(-1)
    expect(delay).toBeGreaterThan(volume)
    const match = /volume='([^']+)':eval=frame/.exec(graph)
    expect(match).toBeTruthy()
    // 音频轨分支在 adelay 前求值：t 是片段本地时间，值还要乘轨道 0.8。
    expect(evaluateVolume(match![1], 1)).toBeCloseTo(
      evalAnimation(KEYS, 1 / 4, 1) * 0.8,
      5,
    )
  })

  it('纯音量关键帧不会触发视觉逐帧烘焙（不会多一次 H.264 重编码）', () => {
    const project = videoProject({ anim: { volume: KEYS } })
    expect(hasAnyAnimation(project)).toBe(false)
  })

  it('视觉烘焙后仍保留 volume 关键帧', () => {
    const clip = videoProject({
      anim: {
        opacity: [
          { t: 0, value: 0, ease: 'linear' },
          { t: 1, value: 1, ease: 'linear' },
        ],
        volume: KEYS,
      },
    }).clips[0]
    const baked = bakeAnimatedClip(clip, 'blob:anim', 5)
    expect(baked.anim?.volume).toEqual(KEYS)
    expect(baked.anim?.opacity).toBeUndefined()
  })
})