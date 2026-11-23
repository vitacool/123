import { describe, expect, it } from 'vitest'
import { buildExportPlan } from '../src/editor/core/exportPlan'
import { createClip, createInitialProject } from '../src/editor/core/operations'
import type { Project, SourceInfo } from '../src/editor/core/types'

/**
 * 主轨旋转：预览里旋转后画面外是**画布背景**（纯色 / 模糊），因为 canvas 画布
 * 先铺背景再画旋转后的片段。导出原来用 `rotate=...:c=black` 把四角写成不透明黑，
 * 之后 pad 背景色/模糊层都盖不住 → 四角固定黑色。
 *
 * 修复后：旋转输出透明角（c=black@0 + alpha），再叠到背景层；调色放在 rotate 之前，
 * 不把透明角（或黑角）染灰。非旋转路径保持原滤镜图（性能）。
 */

const SOURCE: SourceInfo = {
  url: 'blob:v',
  name: 'v.mp4',
  size: 1_000_000,
  duration: 10,
  width: 1920,
  height: 1080,
}

/** 取主轨片段的那条滤镜链（[0:v]...）。 */
function mainChain(graph: string): string {
  for (const line of graph.split('\n')) {
    if (line.startsWith('[0:v]')) return line
  }
  throw new Error('没有找到主轨滤镜链：\n' + graph)
}

function projectWithMain(
  overrides: Partial<Parameters<typeof createClip>[3]> = {},
  background?: Project['canvasBackground'],
): Project {
  const base = createInitialProject({ url: SOURCE.url, duration: 10 }, 'c1')
  return {
    ...base,
    ...(background ? { canvasBackground: background } : {}),
    clips: [createClip(SOURCE.url, 0, 10, overrides, 'c1')],
  }
}

describe('主轨旋转：四角必须是透明（不能是黑）', () => {
  it('旋转 ±30°：rotate 使用 c=black@0，并在 rotate 前转成 rgba', () => {
    for (const rotation of [30, -30]) {
      const plan = buildExportPlan(projectWithMain({ rotation }), SOURCE, true)
      const chain = mainChain(plan.graph)
      expect(chain).toContain('rotate=')
      expect(chain).toContain('c=black@0')
      expect(chain).not.toContain(':c=black,')
      // alpha 必须先存在，否则透明角落无效。
      expect(chain.indexOf('format=rgba')).toBeLessThan(chain.indexOf('rotate='))
    }
  })

  it('纯色背景：旋转后合成到背景色上（不再把颜色 pad 进画面）', () => {
    const plan = buildExportPlan(
      projectWithMain({ rotation: 30 }, { type: 'color', color: '#c81e1e' }),
      SOURCE,
      true,
    )
    expect(plan.graph).toContain('color=c=0xc81e1e')
    expect(plan.graph).toContain('overlay=0:0')
    expect(mainChain(plan.graph)).toContain('c=black@0')
  })

  it('模糊背景：透明角落叠在模糊层上', () => {
    const plan = buildExportPlan(
      projectWithMain({ rotation: 30 }, { type: 'blur', blurAmount: 24 }),
      SOURCE,
      true,
    )
    expect(plan.graph).toContain('gblur=')
    expect(plan.graph).toContain('overlay=0:0')
    // 模糊路径里画面层单独一条链（split 之后），rotate 在含 fg 的那一行。
    const rotateLine = plan.graph.split('\n').find((line) => line.includes('rotate='))
    expect(rotateLine).toBeTruthy()
    expect(rotateLine).toContain('c=black@0')
    expect(rotateLine!.indexOf('format=rgba')).toBeLessThan(rotateLine!.indexOf('rotate='))
  })

  it('调色在 rotate 之前执行（黑角/透明角不会被提亮）', () => {
    const plan = buildExportPlan(
      projectWithMain({
        rotation: 30,
        color: { brightness: 60, contrast: 0, saturation: 0, temperature: 0 },
      }),
      SOURCE,
      true,
    )
    const chain = mainChain(plan.graph)
    expect(chain).toContain('eq=brightness=0.3')
    expect(chain.indexOf('eq=brightness')).toBeLessThan(chain.indexOf('rotate='))
  })

  it('旋转 + 不透明度：alpha 路径同时承载 opacity', () => {
    const plan = buildExportPlan(projectWithMain({ rotation: 30, opacity: 0.5 }), SOURCE, true)
    expect(mainChain(plan.graph)).toContain('colorchannelmixer=aa=0.5')
    expect(mainChain(plan.graph)).toContain('c=black@0')
  })
})

describe('主轨未旋转：不引入 alpha 合成（性能）', () => {
  it('rotation=0 + 纯色背景：仍是 pad 背景色，没有额外背景层', () => {
    const plan = buildExportPlan(
      projectWithMain({}, { type: 'color', color: '#c81e1e' }),
      SOURCE,
      true,
    )
    const chain = mainChain(plan.graph)
    expect(chain).not.toContain('c=black@0')
    expect(chain).not.toContain('format=yuva420p')
    expect(plan.graph).not.toContain('color=c=0xc81e1e')
    expect(plan.graph).not.toContain('overlay=0:0')
  })

  it('rotation=0 + 调色：滤镜图保持原位（调色在 scale 之前）', () => {
    const plan = buildExportPlan(
      projectWithMain({
        color: { brightness: 60, contrast: 0, saturation: 0, temperature: 0 },
      }),
      SOURCE,
      true,
    )
    const chain = mainChain(plan.graph)
    expect(chain).not.toContain('rotate=')
    expect(chain.indexOf('eq=brightness')).toBeLessThan(chain.indexOf('scale='))
  })
})