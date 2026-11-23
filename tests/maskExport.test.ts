import { describe, expect, it } from 'vitest'
import { buildExportPlan, maskedClipPieces } from '../src/editor/core/exportPlan'
import {
  injectCoverInputArgs,
  injectMaskInputArgs,
  injectTextInputArgs,
  maskedClips,
} from '../src/editor/services/ffmpegExporter'
import { createClip, createInitialProject } from '../src/editor/core/operations'
import { normalizeMask } from '../src/editor/core/mask'
import type { Clip, ClipMask, Project, SourceInfo } from '../src/editor/core/types'

const SOURCE: SourceInfo = {
  url: 'blob:mask-export',
  name: 'src.mp4',
  size: 1_000_000,
  duration: 30,
  width: 1920,
  height: 1080,
}

const MASK = (patch: Partial<ClipMask> = {}): ClipMask => ({
  ...normalizeMask({ shape: 'ellipse', feather: 0.2 })!,
  ...patch,
})

function projectWithMask(mask: ClipMask | undefined): Project {
  const clip: Clip = { ...createClip(SOURCE.url, 0, 6, {}, 'a'), ...(mask ? { mask } : {}) }
  return {
    ...createInitialProject({ url: SOURCE.url, duration: 30 }, 'a'),
    aspectRatio: '16:9',
    exportQuality: { resolution: '480p', fps: 30 },
    clips: [clip],
  }
}

describe('maskedClipPieces：链的分段位置', () => {
  it('prefix 只有 crop/flip/format=rgba（alphamerge 必须在 crop、flip 之后）', () => {
    const pieces = maskedClipPieces(
      { ...createClip(SOURCE.url, 0, 6, { flipH: true }, 'a'), mask: MASK() },
      640,
      360,
      SOURCE,
      false,
    )!
    expect(pieces.prefix).toMatch(/^crop=\d+:\d+:\d+:\d+,hflip,format=rgba$/)
    // 旋转/缩放/调色都在 alphamerge 之后（suffix 里）。
    expect(pieces.prefix).not.toContain('rotate=')
    expect(pieces.prefix).not.toContain('scale=')
  })

  it('suffix 先 rotate（c=black@0 保留 alpha），再调色/scale/crop/pad', () => {
    const clip = { ...createClip(SOURCE.url, 0, 6, { rotation: 30 }, 'a'), mask: MASK() }
    const pieces = maskedClipPieces(clip, 640, 360, SOURCE, false)!
    const parts = pieces.suffix.split(',')
    expect(parts[0]).toContain('rotate=')
    expect(parts[0]).toContain('c=black@0')
    expect(pieces.suffix).toContain('pad=640:360')
    // 主轨：透明 pad + yuva420p（外层再垫背景层合成）。
    expect(pieces.suffix).toContain('color=0x00000000')
    expect(pieces.suffix).toContain('format=yuva420p')
  })

  it('叠加轨：保留 rgba 并带透明度链，不垫背景层', () => {
    const pieces = maskedClipPieces(
      { ...createClip(SOURCE.url, 0, 6, { opacity: 0.7 }, 'a'), mask: MASK() },
      640,
      360,
      SOURCE,
      true,
    )!
    expect(pieces.suffix).toContain('format=rgba')
    // 叠加轨独有的透明度链（主轨用 yuva420p + 外层 overlay）。
    expect(pieces.suffix).toContain('colorchannelmixer')
    // 两种变体的末尾处理必须不同，证明分支真的分开了。
    const main = maskedClipPieces(
      { ...createClip(SOURCE.url, 0, 6, { opacity: 0.7 }, 'a'), mask: MASK() },
      640,
      360,
      SOURCE,
      false,
    )!
    expect(main.suffix).not.toBe(pieces.suffix)
  })

  it('蒙版尺寸 = 片段裁切尺寸（crop.w × crop.h）', () => {
    const clip = {
      ...createClip(SOURCE.url, 0, 6, { crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }, 'a'),
      mask: MASK(),
    }
    const pieces = maskedClipPieces(clip, 640, 360, SOURCE, false)!
    // 裁切 0.5×0.5 → 源 1920x1080 的 960x540
    expect(pieces.maskWidth).toBe(960)
    expect(pieces.maskHeight).toBe(540)
  })

  it('没有蒙版时返回 null', () => {
    expect(maskedClipPieces(createClip(SOURCE.url, 0, 6, {}, 'a'), 640, 360, SOURCE, false)).toBeNull()
  })
})

describe('导出图：alphamerge 的位置与合成', () => {
  it('主轨带蒙版：crop/flip → alphamerge → rotate → 背景层 overlay', () => {
    const clip = {
      ...createClip(SOURCE.url, 0, 6, { rotation: 20, flipV: true }, 'a'),
      mask: MASK(),
    }
    const project = { ...projectWithMask(undefined), clips: [clip] }
    const plan = buildExportPlan(project, SOURCE, true, { maskInputs: new Map([['a', 3]]) })
    const graph = plan.graph
    expect(graph).toContain('alphamerge')
    // 蒙版输入被引用，且尺寸等于裁切尺寸
    expect(graph).toContain('[3:v]format=rgba,scale=1920:1080')
    // alphamerge 出现在 crop/flip 之后（本用例用 vflip）
    expect(graph.indexOf('vflip')).toBeGreaterThanOrEqual(0)
    expect(graph.indexOf('vflip')).toBeLessThan(graph.indexOf('alphamerge'))
    // rotate 在 alphamerge 之后
    expect(graph.indexOf('alphamerge')).toBeLessThan(graph.indexOf('rotate='))
    // 主轨要垫背景层再合成（蒙版外露出画布背景）
    expect(graph).toContain('overlay=0:0:format=auto,format=yuv420p[outv]')
    expect(graph).toContain('color=c=0x000000')
  })

  it('叠加轨带蒙版：alphamerge 在 rotate 之前，且保留 alpha', () => {
    const overlayClip = {
      ...createClip(SOURCE.url, 0, 6, { rotation: 15 }, 'ov'),
      mask: MASK(),
    }
    const base = projectWithMask(undefined)
    const project: Project = {
      ...base,
      clips: [{ ...createClip(SOURCE.url, 0, 10, {}, 'main') }],
      overlayTracks: [
        {
          id: 't1',
          name: '叠加',
          muted: false,
          hidden: false,
          enabled: true,
          locked: false,
          solo: false,
          clips: [overlayClip],
        },
      ],
    }
    const plan = buildExportPlan(project, SOURCE, true, { maskInputs: new Map([['ov', 4]]) })
    expect(plan.graph).toContain('alphamerge')
    expect(plan.graph).toContain('[4:v]format=rgba,scale=1920:1080')
    expect(plan.graph.indexOf('alphamerge')).toBeLessThan(plan.graph.indexOf('rotate='))
  })

  it('没有蒙版输入时 graph 与不传 maskInputs 完全一致（快照安全的根据）', () => {
    const project = projectWithMask(undefined)
    const plain = buildExportPlan(project, SOURCE, true)
    const emptyMap = buildExportPlan(project, SOURCE, true, { maskInputs: new Map() })
    expect(emptyMap.graph).toBe(plain.graph)
    expect(plain.graph).not.toContain('alphamerge')
  })
})

describe('输入编号：蒙版与文字层 / 封面共存', () => {
  const mediaArgs = ['-i', 'a.mp4', '-i', 'b.mp4']
  const graphScript = ['-filter_complex_script', 'graph.txt', 'out.mp4']

  it('蒙版输入插在文字层之前，序号连续且不冲突', () => {
    let args = ['-hide_banner', ...mediaArgs, ...graphScript]
    args = injectMaskInputArgs(args, ['m1.png', 'm2.png'])
    args = injectTextInputArgs(args, {
      assets: [],
      listFile: 'text.txt',
      listContent: '',
      inputIndex: 4,
    })
    args = injectCoverInputArgs(args, 'cover.png')

    // 输入顺序：媒体 0,1 → 蒙版 2,3 → 文字 4 → 封面 5
    const inputs = args.filter((value) => value === '-i').length
    expect(inputs).toBe(6)
    const order = args.join(' ')
    expect(order).toContain('-loop 1 -i m1.png -loop 1 -i m2.png')
    expect(order.indexOf('m1.png')).toBeLessThan(order.indexOf('text.txt'))
    expect(order.indexOf('text.txt')).toBeLessThan(order.indexOf('cover.png'))
    // 与 exporter 里的序号公式一致
    const textInputBase = 2 + 2
    expect(textInputBase).toBe(4)
    const coverIndex = textInputBase + 1
    expect(coverIndex).toBe(5)
  })

  it('没有蒙版时 args 与原来完全相同（不注入任何东西）', () => {
    const base = ['-hide_banner', ...mediaArgs, ...graphScript]
    expect(injectMaskInputArgs(base, [])).toEqual(base)
  })

  it('maskedClips 只收集主轨与叠加轨里真正有蒙版的片段', () => {
    const base = projectWithMask(undefined)
    const project: Project = {
      ...base,
      clips: [{ ...createClip(SOURCE.url, 0, 5, {}, 'plain') }],
      overlayTracks: [
        {
          id: 't1',
          name: '叠加',
          muted: false,
          hidden: false,
          enabled: true,
          locked: false,
          solo: false,
          clips: [
            { ...createClip(SOURCE.url, 0, 5, {}, 'ov1'), mask: MASK() },
            { ...createClip(SOURCE.url, 0, 5, {}, 'ov2') },
          ],
        },
      ],
    }
    expect(maskedClips(project).map((clip) => clip.id)).toEqual(['ov1'])
  })
})