import { describe, expect, it } from 'vitest'
import { buildExportPlan } from '../src/editor/core/exportPlan'
import { createInitialProject } from '../src/editor/core/operations'
import { hasAnyAnimation } from '../src/editor/core/animationExport'
import type { Clip, Project, SourceInfo } from '../src/editor/core/types'

const SOURCE: SourceInfo = {
  url: 'blob:test',
  name: 'test.mp4',
  size: 1024,
  duration: 20,
  width: 1920,
  height: 1080,
  kind: 'video',
  hasAudio: true,
}

const clip = (id: string, extra: Partial<Clip> = {}): Clip => ({
  ...createInitialProject({ url: SOURCE.url, duration: 20 }, id).clips[0],
  ...extra,
})

/** 一段普通的、没有关键帧的工程（两段拼接 + 一段叠加轨）。 */
function staticProject(): Project {
  const base = createInitialProject({ url: SOURCE.url, duration: 20 }, 'c1')
  return {
    ...base,
    aspectRatio: '16:9',
    clips: [
      clip('c1', { sourceEnd: 4 }),
      { ...clip('c2', { sourceStart: 4, sourceEnd: 8 }), gapBefore: 0.5 },
    ],
    overlayTracks: [
      {
        id: 'ov',
        name: '叠加 1',
        muted: false,
        hidden: false,
        enabled: true,
        locked: false,
        solo: false,
        clips: [clip('ov1', { sourceEnd: 3, scale: 0.5, position: { x: 0.2, y: 0.1 } })],
      },
    ],
    exportQuality: { resolution: '480p', fps: 30 },
  }
}

describe('无动画项目的导出图（验收 #7 回归保护）', () => {
  it('hasAnyAnimation 为 false（动画预处理整段跳过）', () => {
    expect(hasAnyAnimation(staticProject())).toBe(false)
  })

  it('滤镜图与「动画功能引入前」的基线完全一致', () => {
    const plan = buildExportPlan(staticProject(), [SOURCE], true)
    // 该基线在 commit 50500d7（动画功能引入前）即为此值：
    // exportPlan.ts 在这之后没有任何改动（git diff 50500d7..HEAD -- exportPlan.ts 为空）。
    expect(plan.graph).toMatchSnapshot('static-project-graph')
    expect(plan.graph).not.toContain('anim_')
    expect(plan.width).toBe(854)
    expect(plan.height).toBe(480)
  })

  it('给同一工程加上关键帧后，plan 本身仍然是「无动画」的形状（几何由烘焙负责）', () => {
    const project = staticProject()
    const animated: Project = {
      ...project,
      clips: [
        {
          ...project.clips[0],
          anim: { 'position.x': [{ t: 0, value: 0, ease: 'linear' }, { t: 1, value: 0.3, ease: 'linear' }] },
        },
        project.clips[1],
      ],
    }
    expect(hasAnyAnimation(animated)).toBe(true)
    // exportPlan 不读 anim 字段：同一 sourceUrl/几何下图完全相同（动画由中间视频烘焙）
    const plainPlan = buildExportPlan(project, [SOURCE], true)
    const animPlan = buildExportPlan(animated, [SOURCE], true)
    expect(animPlan.graph).toBe(plainPlan.graph)
  })
})