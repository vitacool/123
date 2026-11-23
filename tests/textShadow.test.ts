import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '../src/editor/core/operations'
import { normalizeProjectTextStyles } from '../src/editor/core/draft'
import {
  CAPTION_STYLE_PRESETS,
  TEXT_SHADOW_DEFAULTS,
  TEXT_SHADOW_ENABLED_DEFAULTS,
  deriveCaptionStyle,
  resolveCaptionStyle,
} from '../src/editor/core/text'
import { drawTextClip } from '../src/editor/core/textRender'
import type { CaptionStyle, Project, TextClip } from '../src/editor/core/types'

function clip(overrides: Partial<TextClip> = {}): TextClip {
  return {
    id: 'c1',
    text: 'Hi',
    start: 0,
    end: 1,
    x: 0.5,
    y: 0.5,
    fontSize: 0.1,
    color: '#ffffff',
    background: 'transparent',
    align: 'center',
    bold: false,
    ...overrides,
  }
}

function textProject(textClip: TextClip, captionStyle?: CaptionStyle): Project {
  return {
    ...createEmptyProject(),
    textTracks: [
      {
        id: 'cap',
        name: '字幕',
        muted: false,
        hidden: false,
        enabled: true,
        kind: 'caption',
        captionStyle,
        clips: [textClip],
      },
    ],
  }
}

interface DrawCall {
  kind: 'fill' | 'fillText' | 'strokeText'
  text?: string
  shadowColor: string
  shadowBlur: number
  shadowOffsetX: number
  shadowOffsetY: number
}

interface MockContext {
  context: CanvasRenderingContext2D
  calls: DrawCall[]
  shadowWrites: Record<'shadowColor' | 'shadowBlur' | 'shadowOffsetX' | 'shadowOffsetY', number>
}

function makeContext(
  initialShadow = {
    shadowColor: 'rgba(1, 2, 3, 0.4)',
    shadowBlur: 11,
    shadowOffsetX: 2,
    shadowOffsetY: 3,
  },
): MockContext {
  const state = { ...initialShadow }
  const calls: DrawCall[] = []
  const shadowWrites = {
    shadowColor: 0,
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
  }
  const capture = (kind: DrawCall['kind'], text?: string): DrawCall => ({
    kind,
    text,
    shadowColor: state.shadowColor,
    shadowBlur: state.shadowBlur,
    shadowOffsetX: state.shadowOffsetX,
    shadowOffsetY: state.shadowOffsetY,
  })
  const context = {
    font: '',
    textBaseline: 'middle',
    textAlign: 'center',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: 'round',
    miterLimit: 2,
    globalAlpha: 1,
    save: () => undefined,
    restore: () => undefined,
    measureText: (text: string) => ({ width: Math.max(1, text.length * 10) }),
    beginPath: () => undefined,
    roundRect: () => undefined,
    rect: () => undefined,
    fill() {
      calls.push(capture('fill'))
    },
    fillText(text: string) {
      calls.push(capture('fillText', text))
    },
    strokeText(text: string) {
      calls.push(capture('strokeText', text))
    },
  }
  for (const key of Object.keys(state) as (keyof typeof state)[]) {
    Object.defineProperty(context, key, {
      get: () => state[key],
      set: (value: number | string) => {
        ;(state[key] as number | string) = value
        shadowWrites[key] += 1
      },
      enumerable: true,
      configurable: true,
    })
  }
  return {
    context: context as unknown as CanvasRenderingContext2D,
    calls,
    shadowWrites,
  }
}

describe('阴影样式继承', () => {
  it('resolveCaptionStyle 按 override > group > clip 合并阴影字段', () => {
    const base = clip({
      shadowColor: '#111111',
      shadowBlur: 0.02,
      shadowOffsetX: 0.01,
      shadowOffsetY: 0.02,
    })
    const group: CaptionStyle = {
      shadowColor: '#222222',
      shadowBlur: 0.05,
      shadowOffsetY: 0.04,
    }
    expect(resolveCaptionStyle(base, group)).toMatchObject({
      shadowColor: '#222222',
      shadowBlur: 0.05,
      shadowOffsetX: 0.01,
      shadowOffsetY: 0.04,
    })

    const override = clip({
      shadowColor: '#111111',
      shadowBlur: 0.02,
      shadowOffsetX: 0.01,
      shadowOffsetY: 0.02,
      styleOverride: { shadowColor: '#333333', shadowOffsetX: 0.09 },
    })
    expect(resolveCaptionStyle(override, group)).toMatchObject({
      shadowColor: '#333333',
      shadowBlur: 0.05,
      shadowOffsetX: 0.09,
      shadowOffsetY: 0.04,
    })
  })

  it('单条覆盖可以用 transparent 显式关闭组阴影', () => {
    const off = clip({ styleOverride: { shadowColor: 'transparent' } })
    expect(
      resolveCaptionStyle(off, { shadowColor: '#000000', shadowBlur: 0.08 }).shadowColor,
    ).toBe('transparent')
  })

  it('deriveCaptionStyle 会读取单条字幕的阴影字段', () => {
    const derived = deriveCaptionStyle(
      clip({
        shadowColor: '#123456',
        shadowBlur: 0.07,
        shadowOffsetX: 0.02,
        shadowOffsetY: 0.03,
      }),
    )
    expect(derived).toMatchObject({
      shadowColor: '#123456',
      shadowBlur: 0.07,
      shadowOffsetX: 0.02,
      shadowOffsetY: 0.03,
    })
  })

  it('字幕预设包含白字黑边阴影', () => {
    const preset = CAPTION_STYLE_PRESETS.find((item) => item.id === 'shadow')
    expect(preset).toBeTruthy()
    expect(preset!.style).toMatchObject({
      color: '#ffffff',
      strokeColor: '#000000',
      ...TEXT_SHADOW_ENABLED_DEFAULTS,
    })
  })
})

describe('旧草稿阴影归一化', () => {
  it('缺失字段补为关闭状态，已经归一化时保持引用不变', () => {
    const legacy = clip()
    const project = textProject(legacy, { color: '#ffffff' })
    const normalized = normalizeProjectTextStyles(project)
    const text = normalized.textTracks![0].clips[0]
    expect(text).toMatchObject(TEXT_SHADOW_DEFAULTS)
    expect(normalized.textTracks![0].captionStyle).toEqual({ color: '#ffffff' })
    expect(normalizeProjectTextStyles(normalized)).toBe(normalized)
  })

  it('已有阴影颜色但缺 blur/offset 时只补缺省数值', () => {
    const project = textProject(clip({ shadowColor: 'rgba(0, 0, 0, 0.6)' }))
    const text = normalizeProjectTextStyles(project).textTracks![0].clips[0]
    expect(text.shadowColor).toBe('rgba(0, 0, 0, 0.6)')
    expect(text.shadowBlur).toBe(0)
    expect(text.shadowOffsetX).toBe(0)
    expect(text.shadowOffsetY).toBe(0)
  })
})

describe('drawTextClip 阴影绘制', () => {
  it('未设置阴影时不写 shadow 属性，绘制调用序列与旧实现一致', () => {
    const { context, calls, shadowWrites } = makeContext()
    drawTextClip(
      context,
      clip({ strokeColor: '#000000', strokeWidth: 0.06 }),
      1000,
      1000,
    )
    expect(calls.map((call) => call.kind)).toEqual(['strokeText', 'fillText'])
    expect(shadowWrites).toEqual({
      shadowColor: 0,
      shadowBlur: 0,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
    })
    // 外部已有的阴影状态没有被改动。
    expect(calls[0].shadowColor).toBe('rgba(1, 2, 3, 0.4)')
  })

  it('未设置阴影时背景框/描边/填充的调用序列同样不变', () => {
    const { context, calls, shadowWrites } = makeContext()
    drawTextClip(
      context,
      clip({
        strokeColor: '#000000',
        strokeWidth: 0.06,
        background: 'rgba(0, 0, 0, 0.5)',
      }),
      1000,
      1000,
    )
    expect(calls.map((call) => call.kind)).toEqual(['fill', 'strokeText', 'fillText'])
    expect(shadowWrites).toEqual({
      shadowColor: 0,
      shadowBlur: 0,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
    })
  })

  it('有描边时阴影只在描边那次绘制上，背景框不带阴影', () => {
    const { context, calls } = makeContext()
    drawTextClip(
      context,
      clip({
        shadowColor: 'rgba(0, 0, 0, 0.55)',
        shadowBlur: 0.08,
        shadowOffsetX: 0.03,
        shadowOffsetY: 0.05,
        strokeColor: '#000000',
        strokeWidth: 0.06,
        background: 'rgba(0, 0, 0, 0.5)',
      }),
      1000,
      1000,
    )
    expect(calls.map((call) => call.kind)).toEqual(['fill', 'strokeText', 'fillText'])

    // 背景框：阴影已关闭。
    expect(calls[0].shadowColor).toBe('transparent')
    expect(calls[0].shadowBlur).toBe(0)

    // 描边：唯一一次带阴影的绘制，半径/偏移按 fontSize 100 缩放。
    expect(calls[1].shadowColor).toBe('rgba(0, 0, 0, 0.55)')
    expect(calls[1].shadowBlur).toBeCloseTo(8)
    expect(calls[1].shadowOffsetX).toBeCloseTo(3)
    expect(calls[1].shadowOffsetY).toBeCloseTo(5)

    // 填充：没有第二层阴影。
    expect(calls[2].shadowColor).toBe('transparent')
    expect(calls[2].shadowBlur).toBe(0)
  })

  it('无描边时阴影落在文字填充上', () => {
    const { context, calls } = makeContext()
    drawTextClip(
      context,
      clip({
        shadowColor: '#000000',
        shadowBlur: 0.08,
        shadowOffsetX: 0.03,
        shadowOffsetY: 0.05,
        background: 'rgba(0, 0, 0, 0.5)',
      }),
      1000,
      1000,
    )
    expect(calls.map((call) => call.kind)).toEqual(['fill', 'fillText'])
    expect(calls[0].shadowColor).toBe('transparent')
    expect(calls[1].shadowColor).toBe('#000000')
    expect(calls[1].shadowBlur).toBeCloseTo(8)
  })

  it('阴影随 fontSize 比例缩放，1080p 与 480p 比例一致', () => {
    const shadowClip = clip({
      shadowColor: '#000000',
      shadowBlur: 0.08,
      shadowOffsetX: 0.03,
      shadowOffsetY: 0.05,
    })
    const hd = makeContext()
    drawTextClip(hd.context, shadowClip, 1920, 1080)
    const sd = makeContext()
    drawTextClip(sd.context, shadowClip, 854, 480)
    const hdCall = hd.calls.find((call) => call.kind === 'fillText')!
    const sdCall = sd.calls.find((call) => call.kind === 'fillText')!
    expect(hdCall.shadowBlur / sdCall.shadowBlur).toBeCloseTo(1080 / 480, 5)
    expect(hdCall.shadowOffsetX / sdCall.shadowOffsetX).toBeCloseTo(1080 / 480, 5)
    expect(hdCall.shadowOffsetY / sdCall.shadowOffsetY).toBeCloseTo(1080 / 480, 5)
  })

  it('shadowColor=transparent 等价于未设置阴影', () => {
    const { context, calls, shadowWrites } = makeContext()
    drawTextClip(
      context,
      clip({ shadowColor: 'transparent', shadowBlur: 0.08 }),
      1000,
      1000,
    )
    expect(calls.map((call) => call.kind)).toEqual(['fillText'])
    expect(shadowWrites).toEqual({
      shadowColor: 0,
      shadowBlur: 0,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
    })
  })
})