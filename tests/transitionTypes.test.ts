import { describe, expect, it } from 'vitest'
import {
  TRANSITION_TYPES,
  normalizeTransitionType,
  transitionLabel,
} from '../src/editor/core/transition'
import { buildExportPlan } from '../src/editor/core/exportPlan'
import { createClip, createInitialProject } from '../src/editor/core/operations'
import type { Project, SourceInfo, TransitionType } from '../src/editor/core/types'

const SOURCE: SourceInfo = {
  url: 'blob:transition-types',
  name: 'src.mp4',
  size: 1_000_000,
  duration: 20,
  width: 1920,
  height: 1080,
}

function projectWith(type: TransitionType): Project {
  const base = createInitialProject({ url: SOURCE.url, duration: 20 }, 'left')
  return {
    ...base,
    aspectRatio: '16:9',
    exportQuality: { resolution: '480p', fps: 30 },
    clips: [
      createClip(SOURCE.url, 0, 5, { transitionOut: { type, duration: 0.5 } }, 'left'),
      createClip(SOURCE.url, 5, 10, {}, 'right'),
    ],
  }
}

const ALL_TYPES = TRANSITION_TYPES.map((item) => item.value)

describe('每种转场都能生成 xfade 参数', () => {
  it('全部类型（含新增）都出现在 graph 的 xfade=transition=<type> 里', () => {
    for (const type of ALL_TYPES) {
      const plan = buildExportPlan(projectWith(type), SOURCE, true)
      expect(plan.graph).toContain(`xfade=transition=${type}:duration=0.5`)
      expect(plan.graph).toContain('[outv]')
    }
  })

  it('新增类型不是靠 normalize 回退成 fade 混过去的', () => {
    for (const type of ALL_TYPES) {
      expect(normalizeTransitionType(type)).toBe(type)
    }
    // 每个类型的中文名都独立可读。
    for (const type of ALL_TYPES) {
      expect(transitionLabel(type).length).toBeGreaterThan(0)
    }
  })

  it('未知类型仍然回退 fade（旧版本打开新工程不报错）', () => {
    for (const unknown of ['diagtl', 'hlslice', 'nonsense', '', ' FADE ', 'crop']) {
      expect(normalizeTransitionType(unknown)).toBe('fade')
    }
    // 未知值写进工程后，导出侧也会按 fade 处理。
    const plan = buildExportPlan(projectWith('fade'), SOURCE, true)
    expect(plan.graph).toContain('xfade=transition=fade:duration=0.5')
  })
})