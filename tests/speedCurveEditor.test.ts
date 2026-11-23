// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SpeedCurveEditor } from '../src/editor/components/SpeedCurveEditor'

const POINTS = [
  { at: 0, speed: 1 },
  { at: 0.5, speed: 3 },
  { at: 1, speed: 1 },
]

type EditorProps = ComponentProps<typeof SpeedCurveEditor>

const render = (overrides: Partial<EditorProps> = {}): string =>
  renderToStaticMarkup(
    createElement(SpeedCurveEditor, {
      curve: POINTS,
      onPreview: () => {},
      onCommit: () => {},
      ...overrides,
    }),
  )

describe('速度曲线编辑器：静态渲染', () => {
  it('渲染出 SVG 曲线、3 个可拖控制点与网格刻度', () => {
    const html = render()
    expect(html).toContain('<svg')
    expect(html).toContain('speed-curve-line')
    // 3 个控制点 = 3 个热区 + 3 个圆点
    expect(html.match(/speed-curve-hit/g)).toHaveLength(3)
    expect(html.match(/speed-curve-dot/g)).toHaveLength(3)
    // 网格刻度：0.25 / 0.5 / 1 / 2 / 4
    for (const label of ['0.25x', '0.5x', '1x', '2x', '4x']) expect(html).toContain(label)
  })

  it('每个控制点都是可访问的 slider，标签带进度与速度', () => {
    const html = render()
    expect(html.match(/role="slider"/g)).toHaveLength(3)
    expect(html).toContain('第 1 个控制点：进度 0%、速度 1x')
    expect(html).toContain('第 2 个控制点：进度 50%、速度 3x')
    expect(html).toContain('第 3 个控制点：进度 100%、速度 1x')
  })

  it('曲线用 80 个采样点画折线（与导出用的 16 段采样互相独立）', () => {
    const html = render()
    const line = /<polyline[^>]*points="([^"]+)"/.exec(html)?.[1] ?? ''
    expect(line.split(' ').filter(Boolean)).toHaveLength(80)
    // 面积多边形 = 两个基线点 + 同一条曲线
    const area = /<polygon[^>]*points="([^"]+)"/.exec(html)?.[1] ?? ''
    expect(area.split(' ').filter(Boolean)).toHaveLength(82)
  })

  it('disabled 时不可聚焦、加 is-disabled 类', () => {
    const html = render({ disabled: true })
    expect(html).toContain('speed-curve-editor is-disabled')
    expect(html).toContain('tabindex="-1"')
  })

  it('控制点数量达到上限后「加控制点」按钮禁掉', () => {
    const html = render({
      curve: [
        { at: 0, speed: 1 },
        { at: 0.25, speed: 2 },
        { at: 0.5, speed: 1 },
        { at: 0.75, speed: 2 },
        { at: 1, speed: 1 },
      ],
    })
    expect(html.match(/role="slider"/g)).toHaveLength(5)
    expect(html).toContain('加控制点')
    expect(html).toContain('disabled=""')
  })

  it('静态渲染不触发拖动回调', () => {
    const onPreview = vi.fn()
    const onCommit = vi.fn()
    render({ onPreview, onCommit })
    expect(onPreview).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
  })
})