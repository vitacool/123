import { describe, expect, it } from 'vitest'
import {
  MASK_DEFAULTS,
  MASK_SHAPES,
  drawMaskShape,
  maskShortSide,
  normalizeMask,
  supportsMask,
  type MaskCanvasTarget,
} from '../src/editor/core/mask'
import { normalizeProjectMasks } from '../src/editor/core/draft'
import { drawClipFrame, resetMaskCache } from '../src/editor/core/clipRender'
import { createClip, createInitialProject } from '../src/editor/core/operations'
import { captureVisualAttrs } from '../src/editor/core/attributeClipboard'
import type { ClipMask, Clip, Project, SourceInfo } from '../src/editor/core/types'

const SOURCE: SourceInfo = {
  url: 'blob:mask-src',
  name: 'src.mp4',
  size: 1_000_000,
  duration: 20,
  width: 1920,
  height: 1080,
}

const project = (clip: Clip): Project => ({
  ...createInitialProject({ url: SOURCE.url, duration: 20 }, clip.id),
  aspectRatio: '16:9',
  exportQuality: { resolution: '480p', fps: 30 },
  clips: [clip],
})

function makeCtx(ops: string[]) {
  const ctx = {
    filter: 'none',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000',
    imageSmoothingEnabled: true,
    setTransform: () => ops.push('setTransform'),
    save: () => ops.push('save'),
    restore: () => ops.push('restore'),
    beginPath: () => ops.push('beginPath'),
    closePath: () => ops.push('closePath'),
    moveTo: () => ops.push('moveTo'),
    lineTo: () => ops.push('lineTo'),
    arcTo: () => ops.push('arcTo'),
    rect: (...args: number[]) => ops.push('rect:' + args.join(',')),
    ellipse: () => ops.push('ellipse'),
    arc: () => ops.push('arc'),
    translate: () => ops.push('translate'),
    rotate: () => ops.push('rotate'),
    scale: () => ops.push('scale'),
    fill: () => ops.push('fill'),
    fillRect: () => ops.push('fillRect'),
    clearRect: () => ops.push('clearRect'),
    drawImage: () => ops.push('drawImage'),
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, ops }
}

const createCanvas = (w: number, h: number): MaskCanvasTarget => {
  const inner = makeCtx([])
  return { canvas: { width: w, height: h } as unknown as CanvasImageSource, ctx: inner.ctx }
}

describe('蒙版参数归一化（core/mask）', () => {
  it('缺失 / 非法值 → 返回 undefined（没有蒙版）', () => {
    expect(normalizeMask(undefined)).toBeUndefined()
    expect(normalizeMask(null)).toBeUndefined()
    expect(normalizeMask('rect')).toBeUndefined()
    expect(normalizeMask(42)).toBeUndefined()
  })

  it('比例 / 羽化 / 圆角夹到 0..1，角度归一到 0..360', () => {
    const mask = normalizeMask({
      shape: 'rect',
      x: -3,
      y: 9,
      width: 4,
      height: -1,
      rotation: 725,
      roundness: 3,
      feather: 9,
      invert: 'yes',
    })!
    expect(mask.x).toBe(0)
    expect(mask.y).toBe(1)
    expect(mask.width).toBe(1)
    expect(mask.height).toBe(0)
    expect(mask.rotation).toBeCloseTo(5, 6)
    expect(mask.roundness).toBe(1)
    expect(mask.feather).toBe(1)
    // invert 只认 true（字符串不算），保持布尔语义。
    expect(mask.invert).toBe(false)
  })

  it('未知形状回退 rect；缺省字段用默认值补齐', () => {
    const mask = normalizeMask({ shape: 'hexagon' })!
    expect(mask.shape).toBe(MASK_DEFAULTS.shape)
    expect(mask.x).toBe(MASK_DEFAULTS.x)
    expect(mask.rotation).toBe(0)
    expect(normalizeMask({ shape: 'ellipse', invert: true })!.invert).toBe(true)
  })

  it('四种形状都在 MASK_SHAPES 里，supportsMask 只放开 video/freeze/image', () => {
    expect(MASK_SHAPES.map((item) => item.value)).toEqual(['rect', 'ellipse', 'linear', 'mirror'])
    expect(supportsMask('video')).toBe(true)
    expect(supportsMask('freeze')).toBe(true)
    expect(supportsMask('image')).toBe(true)
    expect(supportsMask('text')).toBe(false)
  })
})

describe('旧草稿兼容（normalizeProjectMasks）', () => {
  it('没有 mask 字段的片段保持 undefined，且对象引用不变', () => {
    const clip = createClip(SOURCE.url, 0, 5, {}, 'a')
    const before = project(clip)
    const after = normalizeProjectMasks({ ...before, clips: [clip] })
    expect(after.clips[0].mask).toBeUndefined()
    expect(after.clips[0]).toBe(clip)
  })

  it('已有的合法蒙版保持引用不变；非法值被夹取', () => {
    const mask: ClipMask = {
      shape: 'ellipse',
      x: 0.5,
      y: 0.5,
      width: 0.4,
      height: 0.4,
      rotation: 0,
      feather: 0.1,
      invert: false,
    }
    const clip = { ...createClip(SOURCE.url, 0, 5, {}, 'a'), mask }
    const once = normalizeProjectMasks(project(clip))
    expect(once.clips[0]).toBe(clip)

    const bad = { ...createClip(SOURCE.url, 0, 5, {}, 'b'), mask: { ...mask, x: 99 } }
    const fixed = normalizeProjectMasks(project(bad))
    expect(fixed.clips[0].mask!.x).toBe(1)
  })
})

describe('drawMaskShape：形状 / 羽化 / 反向', () => {
  it('四种形状各有自己的路径（互不相同，且都不是空绘制）', () => {
    const signatures = new Map<string, string>()
    for (const shape of ['rect', 'ellipse', 'linear', 'mirror'] as const) {
      const ops: string[] = []
      const { ctx } = makeCtx(ops)
      // 形状可能画在离屏画布上（羽化路径），内层 ops 也收进同一个数组。
      const collecting = (w: number, h: number): MaskCanvasTarget => {
        const inner = makeCtx(ops)
        return { canvas: { width: w, height: h } as unknown as CanvasImageSource, ctx: inner.ctx }
      }
      drawMaskShape(ctx, 100, 50, normalizeMask({ shape, feather: 0 })!, collecting)
      expect(ops.length, `${shape} 什么都没画`).toBeGreaterThan(0)
      // 每种形状的绘制指令序列应当是独一无二的（证明没有共用同一条路径）。
      signatures.set(shape, ops.join('>'))
    }
    expect(new Set(signatures.values()).size).toBe(4)
  })

  it('羽化：feather>0 时走离屏 + blur，feather=0 时直接填充', () => {
    const ops: string[] = []
    const { ctx } = makeCtx(ops)
    const created: number[] = []
    const tracking = (w: number, h: number): MaskCanvasTarget => {
      created.push(w * h)
      return createCanvas(w, h)
    }
    drawMaskShape(ctx, 100, 50, normalizeMask({ shape: 'ellipse', feather: 0.2 })!, tracking)
    expect(created).toEqual([5000])
    expect(ops.includes('drawImage')).toBe(true)

    created.length = 0
    ops.length = 0
    drawMaskShape(ctx, 100, 50, normalizeMask({ shape: 'ellipse', feather: 0 })!, tracking)
    expect(created).toEqual([])
    expect(ops.includes('drawImage')).toBe(false)
  })

  it('反向：先整块铺白，再用 destination-out 抠出形状', () => {
    const ops: string[] = []
    const states: string[] = []
    const { ctx } = makeCtx(ops)
    const proxy = new Proxy(ctx, {
      set(target, prop, value) {
        if (prop === 'globalCompositeOperation') states.push(String(value))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(target as any)[prop] = value
        return true
      },
    })
    drawMaskShape(proxy, 100, 50, normalizeMask({ shape: 'rect', invert: true, feather: 0 })!, createCanvas)
    expect(ops.includes('fillRect')).toBe(true)
    expect(states).toContain('destination-out')
  })

  it('羽化半径按蒙版短边换算（与分辨率无关）', () => {
    const mask = normalizeMask({ shape: 'ellipse', width: 0.5, height: 0.25, feather: 0.5 })!
    // 短边 = min(0.5*1920, 0.25*1080) = 270
    expect(maskShortSide(1920, 1080, mask)).toBeCloseTo(270, 6)
    // linear 用画面短边
    expect(maskShortSide(1920, 1080, normalizeMask({ shape: 'linear' })!)).toBe(1080)
  })
})

describe('clipRender：蒙版合成路径', () => {
  const clipWithMask = (mask: ClipMask): Clip => ({
    ...createClip(SOURCE.url, 0, 5, {}, 'masked'),
    mask,
  })
  const drawMasked = (clip: Clip, withCanvas = true) => {
    resetMaskCache()
    const ops: string[] = []
    const { ctx } = makeCtx(ops)
    const created: string[] = []
    drawClipFrame({
      ctx,
      clip,
      localTime: 0,
      asset: SOURCE,
      canvasW: 480,
      canvasH: 270,
      source: { width: 1920, height: 1080 } as unknown as CanvasImageSource,
      sourceWidth: 1920,
      sourceHeight: 1080,
      createCanvas: withCanvas
        ? (w, h) => {
            created.push(`canvas:${w}x${h}`)
            return createCanvas(w, h)
          }
        : undefined,
    })
    return { ops, created }
  }

  it('有蒙版时先画到离屏、再 destination-in 叠蒙版、最后整体上屏', () => {
    const { created } = drawMasked(
      clipWithMask(normalizeMask({ shape: 'ellipse', feather: 0 })!),
    )
    // 画面离屏 + 蒙版离屏（各一张）。
    expect(created.length).toBeGreaterThanOrEqual(2)
    expect(created.every((value) => value.startsWith('canvas:'))).toBe(true)
  })

  it('没有蒙版时不创建离屏画布（绘制路径与原来完全一样）', () => {
    const { created } = drawMasked(createClip(SOURCE.url, 0, 5, {}, 'plain'))
    expect(created).toEqual([])
  })

  it('蒙版图按「参数 + 尺寸」缓存：同参数重复绘制只生成一次', () => {
    resetMaskCache()
    const mask = normalizeMask({ shape: 'rect', feather: 0 })!
    const clip = clipWithMask(mask)
    const sizes: string[] = []
    const run = () => {
      const { ctx } = makeCtx([])
      drawClipFrame({
        ctx,
        clip,
        localTime: 0,
        asset: SOURCE,
        canvasW: 480,
        canvasH: 270,
        source: { width: 1920, height: 1080 } as unknown as CanvasImageSource,
        sourceWidth: 1920,
        sourceHeight: 1080,
        createCanvas: (w, h) => {
          sizes.push(`${w}x${h}`)
          return createCanvas(w, h)
        },
      })
    }
    run()
    const firstCount = sizes.length
    run()
    // 第二次仍然需要「画面」离屏（每帧都要画），但蒙版那张应当命中缓存。
    expect(sizes.length).toBe(firstCount + (firstCount - 1))
  })

  it('注入不了离屏画布时退化为无蒙版绘制（不崩）', () => {
    const { ops } = drawMasked(clipWithMask(normalizeMask({ shape: 'rect' })!), false)
    expect(ops.includes('drawImage')).toBe(true)
  })

  it('属性复制包含 mask，没有蒙版时不写入该字段', () => {
    const mask = normalizeMask({ shape: 'rect' })!
    expect(captureVisualAttrs(clipWithMask(mask)).mask).toEqual(mask)
    expect(captureVisualAttrs(createClip(SOURCE.url, 0, 5, {}, 'plain')).mask).toBeUndefined()
  })
})