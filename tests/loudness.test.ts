import { describe, expect, it } from 'vitest'
import { normalizeProjectExportQuality } from '../src/editor/core/draft'
import { buildExportArgs, buildExportPlan } from '../src/editor/core/exportPlan'
import { createInitialProject } from '../src/editor/core/operations'
import type {
  ExportLoudness,
  Project,
  SourceInfo,
} from '../src/editor/core/types'

const SOURCE: SourceInfo = {
  url: 'blob:loudness',
  name: 'loudness.mp4',
  size: 1_000_000,
  duration: 20,
  width: 1920,
  height: 1080,
  kind: 'video',
  hasAudio: true,
}

function makeProject(loudness?: ExportLoudness): Project {
  const base = createInitialProject({ url: SOURCE.url, duration: 20 }, 'clip-a')
  return {
    ...base,
    aspectRatio: '16:9',
    clips: [{ ...base.clips[0], sourceStart: 0, sourceEnd: 4 }],
    exportQuality: {
      resolution: '480p',
      fps: 30,
      ...(loudness ? { loudness } : {}),
    },
  }
}

describe('响度标准化导出图', () => {
  it('off 与缺省都不出现 loudnorm，graph/args 与原有路径逐字一致', () => {
    const implicit = buildExportPlan(makeProject(), [SOURCE], true)
    const off = buildExportPlan(makeProject('off'), [SOURCE], true)
    expect(implicit.graph).toBe(off.graph)
    expect(buildExportArgs(implicit, 'graph.txt', 'out.mp4')).toEqual(
      buildExportArgs(off, 'graph.txt', 'out.mp4'),
    )
    expect(implicit.graph).not.toContain('loudnorm')
    expect(implicit.audioLabel).toBe('outa')
  })

  it('platform 在最终混音后恰好追加一次 loudnorm 与 aresample', () => {
    const plan = buildExportPlan(makeProject('platform'), [SOURCE], true)
    expect(plan.graph.match(/loudnorm/g) ?? []).toHaveLength(1)
    expect(plan.graph).toContain(
      '[outa]loudnorm=I=-14:TP=-1:LRA=11,aresample=48000[outa_norm]',
    )
    expect(
      plan.graph.endsWith(
        'loudnorm=I=-14:TP=-1:LRA=11,aresample=48000[outa_norm]',
      ),
    ).toBe(true)
    expect(plan.audioLabel).toBe('outa_norm')
    expect(buildExportArgs(plan, 'graph.txt', 'out.mp4')).toContain('[outa_norm]')
  })

  it('broadcast 使用 -23 LUFS 参数，且同样只出现一次', () => {
    const plan = buildExportPlan(makeProject('broadcast'), [SOURCE], true)
    expect(plan.graph.match(/loudnorm/g) ?? []).toHaveLength(1)
    expect(plan.graph).toContain(
      '[outa]loudnorm=I=-23:TP=-2:LRA=7,aresample=48000[outa_norm]',
    )
    expect(plan.graph).not.toContain('I=-14')
    expect(plan.audioLabel).toBe('outa_norm')
  })

  it('无音频工程（audioLabel=null）不追加 loudnorm', () => {
    const plan = buildExportPlan(makeProject('platform'), [SOURCE], false)
    expect(plan.audioLabel).toBeNull()
    expect(plan.graph).not.toContain('loudnorm')
  })
})

describe('旧草稿 loudness 归一化', () => {
  it('缺少 loudness 时补 off，并保持幂等', () => {
    const legacy = makeProject()
    const normalized = normalizeProjectExportQuality(legacy)
    expect(normalized.exportQuality.loudness).toBe('off')
    expect(normalizeProjectExportQuality(normalized)).toBe(normalized)
  })

  it('保留已有合法值，非法值回退 off', () => {
    const platform = makeProject('platform')
    expect(normalizeProjectExportQuality(platform)).toBe(platform)
    expect(normalizeProjectExportQuality(platform).exportQuality.loudness).toBe(
      'platform',
    )

    const invalid: Project = {
      ...makeProject(),
      exportQuality: {
        resolution: '480p',
        fps: 30,
        loudness: 'loud' as ExportLoudness,
      },
    }
    expect(normalizeProjectExportQuality(invalid).exportQuality.loudness).toBe('off')
  })
})