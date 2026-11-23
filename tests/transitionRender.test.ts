import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TRANSITION_RENDER_KINDS,
  paintTransitionFrame,
  resetTransitionScratch,
  type TransitionCanvasTarget,
} from '../src/editor/core/transitionRender'
import type { TransitionType } from '../src/editor/core/types'

/**
 * 记录调用的 mock 2D 上下文：只验证「画了什么、画的顺序、透明度」，
 * 不做真实像素断言（node 环境没有 Canvas）。
 */
function makeCtx(ops: string[]) {
  const gradient = { addColorStop: vi.fn() }
  const ctx = {
    canvas: { width: 100, height: 100 } as unknown as HTMLCanvasElement,
    filter: 'none',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000',
    imageSmoothingEnabled: true,
    setTransform: vi.fn((...args: number[]) => ops.push(`setTransform:${args.join(',')}`)),
    save: vi.fn(() => ops.push('save')),
    restore: vi.fn(() => ops.push('restore')),
    beginPath: vi.fn(() => ops.push('beginPath')),
    closePath: vi.fn(() => ops.push('closePath')),
    rect: vi.fn((...args: number[]) => ops.push(`rect:${args.join(',')}`)),
    arc: vi.fn((...args: number[]) => ops.push(`arc:${args.join(',')}`)),
    moveTo: vi.fn(() => ops.push('moveTo')),
    clip: vi.fn(() => ops.push('clip')),
    fillRect: vi.fn((...args: number[]) => ops.push(`fillRect:${args.join(',')}`)),
    drawImage: vi.fn(() => ops.push('drawImage')),
    translate: vi.fn((...args: number[]) => ops.push(`translate:${args.join(',')}`)),
    scale: vi.fn((...args: number[]) => ops.push(`scale:${args.join(',')}`)),
    createLinearGradient: vi.fn(() => {
      ops.push('createLinearGradient')
      return gradient
    }),
    clearRect: vi.fn(),
  }
  return ctx as unknown as CanvasRenderingContext2D
}

/** 注入的离屏画布：同样是 mock，记录「画到离屏」的痕迹。 */
function makeCreateCanvas(ops: string[]) {
  return (width: number, height: number): TransitionCanvasTarget | null => {
    const innerOps: string[] = []
    const ctx = makeCtx(innerOps)
    ops.push(`createCanvas:${width}x${height}`)
    return { canvas: { width, height } as unknown as CanvasImageSource, ctx }
  }
}

interface DrawLog {
  left: number[]
  right: number[]
  order: ('left' | 'right')[]
}

function draw(progress: number, type: TransitionType, options: { createCanvas?: boolean } = {}) {
  // 离屏画布是全局缓存：每次绘制前清空，保证断言针对「本次绘制」而不是上一次的缓存。
  resetTransitionScratch()
  const ops: string[] = []
  const rects: number[][] = []
  const log: DrawLog = { left: [], right: [], order: [] }
  paintTransitionFrame({
    ctx: makeCtx(ops),
    width: 1920,
    height: 1080,
    type,
    progress,
    drawLeft: (_target, alpha) => {
      log.left.push(alpha)
      log.order.push('left')
    },
    drawRight: (_target, alpha) => {
      log.right.push(alpha)
      log.order.push('right')
    },
    createCanvas:
      options.createCanvas === false ? undefined : makeCreateCanvas(ops),
  })
  // 单独收集 rect 参数（mock 的 ops 是字符串，面积判断需要数值）。
  for (const op of ops) {
    if (op.startsWith('rect:')) rects.push(op.slice(5).split(',').map(Number))
  }
  return { ops, log, rects }
}

const ALL_TYPES: readonly TransitionType[] = TRANSITION_RENDER_KINDS

/** 有自己绘制分支的类型（不能悄悄落回 fade）。 */
const NON_FADE = ALL_TYPES.filter((type) => type !== 'fade')

beforeEach(() => {
  resetTransitionScratch()
})

/**
 * 「A 在上层收拢/挤压」的类型：B 先铺底，A 后画并覆盖整个画面。
 * 它们在 p=0 时看不到 B 是因为 A 把整屏盖住了，而不是 B 被裁掉。
 */
const A_ON_TOP: readonly TransitionType[] = ['circleclose', 'vertclose', 'horzclose', 'squeezeh', 'squeezev']

describe('paintTransitionFrame：端点行为', () => {
  it('每种类型在 progress=0 时右段完全不出现（alpha 都是 0）', () => {
    for (const type of ALL_TYPES) {
      const { log, rects, ops } = draw(0, type)
      if (A_ON_TOP.includes(type)) {
        // 反向结构：最后一笔必须是 A（且不透明），说明 A 完整覆盖了 B。
        expect(log.order.at(-1), `${type} 在 p=0 不是由 A 覆盖`).toBe('left')
        expect(log.left.at(-1)).toBe(1)
        continue
      }
      // 三种隐藏方式都表示「完全看不到 B」：
      // 1) alpha=0（淡入淡出类）；2) 零面积裁剪（擦除/形状类）；
      // 3) 画进离屏缓冲后再被渐变/噪声遮罩掉（柔边、溶解、像素化）。
      const hiddenByAlpha = log.right.every((alpha) => alpha === 0)
      // 圆/扇形类用 arc 裁剪：半径 0 时面积同样为 0。
      const arcs = ops
        .filter((op) => op.startsWith('arc:'))
        .map((op) => op.slice(4).split(',').map(Number))
      const hiddenByClip =
        (rects.length > 0 && rects.every((r) => r[2] === 0 || r[3] === 0)) ||
        (arcs.length > 0 &&
          arcs.every((a) => (a[2] ?? 1) === 0 || Math.abs((a[4] ?? 1) - (a[3] ?? 0)) < 1e-9))
      const maskedOffscreen = ops.some((op) => op.startsWith('createCanvas'))
      // 4) 滑动类把 B 平移出画布：setTransform(1,0,0,1,dx,dy) 里 |dx|>=宽 / |dy|>=高。
      const offCanvas = ops.some((op) => {
        if (!op.startsWith('setTransform:')) return false
        const parts = op.slice('setTransform:'.length).split(',').map(Number)
        const dx = parts[4] ?? 0
        const dy = parts[5] ?? 0
        return Math.abs(dx) >= 1920 || Math.abs(dy) >= 1080
      })
      expect(
        hiddenByAlpha || hiddenByClip || maskedOffscreen || offCanvas,
        `${type} 在 p=0 露出了右段`,
      ).toBe(true)
      if (!hiddenByAlpha && !maskedOffscreen) {
        expect(log.right.every((alpha) => alpha === 1)).toBe(true)
      }
      // 左段必须画过（pixelize 会画进离屏画布，也仍会调用 drawLeft）。
      expect(log.left.length, `${type} 在 p=0 没有画左段`).toBeGreaterThan(0)
      expect(log.left[0]).toBe(1)
    }
  })

  it('每种类型在 progress=1 时右段以 alpha=1 出现', () => {
    for (const type of ALL_TYPES) {
      const { log } = draw(1, type)
      expect(log.right.length, `${type} 在 p=1 没有画右段`).toBeGreaterThan(0)
      expect(Math.max(...log.right), `${type} 在 p=1 右段不是完全不透明`).toBe(1)
    }
  })

  it('纯淡入淡出（fade）只靠 alpha，不做任何裁剪/变换/离屏', () => {
    const { ops, log } = draw(0.5, 'fade')
    expect(log.order).toEqual(['left', 'right'])
    expect(log.left).toEqual([1])
    expect(log.right).toEqual([0.5])
    for (const forbidden of ['clip', 'rect:', 'arc:', 'drawImage', 'scale:', 'translate:', 'createCanvas']) {
      expect(ops.some((op) => op.startsWith(forbidden)), `fade 不应出现 ${forbidden}`).toBe(false)
    }
  })

  it('每个新增类型都有自己的绘制分支（有裁剪/变换/离屏/滤镜之一，不是落回 fade）', () => {
    for (const type of NON_FADE) {
      const { ops } = draw(0.5, type)
      const special = ops.some((op) =>
        ['clip', 'rect:', 'arc:', 'drawImage', 'scale:', 'translate:', 'setTransform:', 'createCanvas', 'createLinearGradient', 'fillRect'].some(
          (token) => op.startsWith(token),
        ),
      )
      // fadegrays / hblur 用滤镜而不是几何，单独判断。
      const usesFilter = type === 'fadegrays' || type === 'hblur'
      expect(special || usesFilter, `${type} 看起来落回了默认的 fade`).toBe(true)
    }
  })
})

describe('paintTransitionFrame：几何与降级', () => {
  it('滑动类两段都位移（A 与 B 一起移动）', () => {
    const { ops } = draw(0.5, 'slideleft')
    // 两段各一个 translate：A 左移 -w*p，B 右移 +(1-p)*w（用 setTransform 实现）。
    const transforms = ops.filter((op) => op.startsWith('setTransform:'))
    expect(transforms.some((op) => op.includes(`-${1920 * 0.5}`))).toBe(true)
    expect(transforms.some((op) => op.includes(`${1920 * 0.5}`))).toBe(true)
  })

  it('擦除 / 形状类用 clip 限定右段区域', () => {
    for (const type of ['wipeleft', 'wiperight', 'wipeup', 'wipedown', 'circleopen', 'radial', 'rectcrop'] as TransitionType[]) {
      const { ops } = draw(0.5, type)
      expect(ops.includes('clip'), `${type} 没有用 clip`).toBe(true)
    }
  })

  it('柔边擦除 / 溶解 / 像素化需要离屏画布；注入失败时降级为 fade（不抛错、右段仍按 alpha 出现）', () => {
    for (const type of ['smoothleft', 'smoothright', 'smoothup', 'smoothdown', 'dissolve', 'pixelize'] as TransitionType[]) {
      const withCanvas = draw(0.5, type)
      expect(withCanvas.ops.some((op) => op.startsWith('createCanvas')), `${type} 没用离屏画布`).toBe(true)

      const without = draw(0.5, type, { createCanvas: false })
      // 降级后不崩，且右段按 fade 的透明度出现。
      expect(without.log.right).toContain(0.5)
    }
  })

  it('progress 超出 [0,1] 会被夹取', () => {
    const below = draw(-2, 'fade')
    expect(below.log.right).toEqual([0])
    const above = draw(3, 'fade')
    expect(above.log.right).toEqual([1])
  })

  /**
   * 像素化必须先在**全尺寸**离屏上画这一帧，再缩到小块。
   *
   * drawLeft/drawRight 的几何是按整幅 width/height 算的，直接画进只有 1/block 大小的
   * 画布会把画面整体推出画布外（或只剩左上角一块）—— 现象就是「选像素化后画面全黑」。
   */
  it('像素化先建全尺寸离屏画布，再缩到小块（否则画面被推出画布）', () => {
    // p=0.2 → block≈29 → 小块约 66×37；不能用 p=0.5（那时 block=1，小块就等于全尺寸）
    const { ops } = draw(0.2, 'pixelize')
    // 全尺寸离屏：1920×1080（几何按整幅算，必须先画在它上面）
    expect(
      ops.includes('createCanvas:1920x1080'),
      '缺少全尺寸离屏画布：几何会按整幅算，画进小块画布后被裁到画布外',
    ).toBe(true)
    // 同时还有一个小块离屏（缩略后再放大，才有像素块）
    expect(
      ops.some((op) => op.startsWith('createCanvas:') && op !== 'createCanvas:1920x1080'),
      '缺少小块离屏画布：像素化就没有块状效果',
    ).toBe(true)
    // 主画布最后一次 drawImage 把小块放大回全屏
    expect(ops.filter((op) => op === 'drawImage').length).toBeGreaterThanOrEqual(1)
  })
})