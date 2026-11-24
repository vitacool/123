import { describe, expect, it } from 'vitest'
import { addAudioClipToProject, addAudioTrackToProject } from '../src/editor/core/audio'
import {
  buildAudioExportArgs,
  buildAudioExportPlan,
  buildExportArgs,
  buildExportPlan,
} from '../src/editor/core/exportPlan'
import { createInitialProject, createClip } from '../src/editor/core/operations'
import type { AudioClip, Project, SourceInfo } from '../src/editor/core/types'

const SOURCE: SourceInfo = {
  url: 'blob:audio-export',
  name: 'audio-export.mp4',
  size: 1_000_000,
  duration: 20,
  width: 1920,
  height: 1080,
  kind: 'video',
  hasAudio: true,
}

const clipAudio = (extra: Partial<AudioClip> = {}): AudioClip => ({
  id: 'audio-clip',
  sourceUrl: SOURCE.url,
  sourceStart: 0,
  sourceEnd: 3,
  start: 0,
  volume: 1,
  fadeIn: 0,
  fadeOut: 0,
  ...extra,
})

function makeProject(): Project {
  const base = createInitialProject({ url: SOURCE.url, duration: 20 }, 'clip-a')
  return {
    ...base,
    aspectRatio: '16:9',
    clips: [{ ...base.clips[0], sourceStart: 0, sourceEnd: 4 }],
    exportQuality: { resolution: '480p', fps: 30 },
  }
}

function withLoudness(project: Project, loudness: 'platform' | 'off'): Project {
  return {
    ...project,
    exportQuality: { ...project.exportQuality, loudness },
  }
}

describe('audio-only export plan', () => {
  it('graph 只包含音频链，不含视频输出与视频滤镜', () => {
    const plan = buildAudioExportPlan(makeProject(), [SOURCE], true)
    expect(plan.audioLabel).toBe('outa')
    expect(plan.graph).toContain('[0:a]')
    expect(plan.graph).not.toContain('[outv]')
    expect(plan.graph).not.toContain('[0:v]')
    expect(plan.graph).not.toContain('format=yuv420p')
    expect(plan.inputs).toHaveLength(1)
    expect(plan.inputs[0].hasAudio).toBe(true)
  })

  it('m4a args 不包含视频编码器，包含 -vn + aac 192k', () => {
    const plan = buildAudioExportPlan(makeProject(), [SOURCE], true)
    const args = buildAudioExportArgs(plan, 'graph.txt', 'out.m4a', 'm4a')
    expect(args).not.toContain('-c:v')
    expect(args).not.toContain('-r')
    expect(args).toContain('-vn')
    expect(args[args.indexOf('-c:a') + 1]).toBe('aac')
    expect(args[args.indexOf('-b:a') + 1]).toBe('192k')
    expect(args).toContain('[outa]')
    expect(args).not.toContain('[outv]')
  })

  it('mp3 args 使用 libmp3lame，仍然不含视频编码器', () => {
    const plan = buildAudioExportPlan(makeProject(), [SOURCE], true)
    const args = buildAudioExportArgs(plan, 'graph.txt', 'out.mp3', 'mp3')
    expect(args[args.indexOf('-c:a') + 1]).toBe('libmp3lame')
    expect(args).toContain('-vn')
    expect(args).not.toContain('-c:v')
  })

  it('音频导出遵守 loudness 设置', () => {
    const plan = buildAudioExportPlan(withLoudness(makeProject(), 'platform'), [SOURCE], true)
    expect(plan.graph.match(/loudnorm/g) ?? []).toHaveLength(1)
    expect(plan.audioLabel).toBe('outa_norm')
    const args = buildAudioExportArgs(plan, 'graph.txt', 'out.m4a', 'm4a')
    expect(args).toContain('[outa_norm]')
  })

  it('没有可用音频时不生成音频标签，args 构造明确报错', () => {
    const silent: SourceInfo = { ...SOURCE, hasAudio: false }
    const plan = buildAudioExportPlan(makeProject(), [silent], true)
    expect(plan.audioLabel).toBeNull()
    expect(() => buildAudioExportArgs(plan, 'graph.txt', 'out.m4a', 'm4a')).toThrow()
  })

  it('只有音频轨（主轨空）也能生成纯音频 graph，空图不会被前导分号污染', () => {
    let project: Project = { ...makeProject(), clips: [] }
    project = addAudioTrackToProject(project, 'audio-track').project
    project = addAudioClipToProject(project, 'audio-track', clipAudio())!
    const plan = buildAudioExportPlan(project, [SOURCE], false)
    expect(plan.audioLabel).toBe('outa')
    expect(plan.graph.startsWith(';')).toBe(false)
    expect(plan.graph).not.toContain('[outv]')
    expect(plan.graph).toContain('[0:a]')
    const args = buildAudioExportArgs(plan, 'graph.txt', 'out.m4a', 'm4a')
    expect(args).toContain('-t')
    expect(args[args.indexOf('-t') + 1]).toBe('3')
  })

  it('多轨混音终点有限幅器（避免 100% + 100% 削波）', () => {
    let project = makeProject()
    project = addAudioTrackToProject(project, 'audio-track').project
    project = addAudioClipToProject(project, 'audio-track', clipAudio())!
    const plan = buildExportPlan(project, [SOURCE], true)
    expect(plan.graph).toContain('alimiter=limit=0.97:level=false')
    expect(plan.graph).toContain('[amix]alimiter')
  })

  it('主轨有转场时音频仍用 acrossfade，且图里没有任何视频标签', () => {
    const base = makeProject()
    const template = base.clips[0]
    const project: Project = {
      ...base,
      clips: [
        {
          ...template,
          id: 'a',
          sourceStart: 0,
          sourceEnd: 3,
          transitionOut: { type: 'fade', duration: 0.5 },
        },
        { ...template, id: 'b', sourceStart: 3, sourceEnd: 6 },
      ],
    }
    const plan = buildAudioExportPlan(project, [SOURCE], true)
    expect(plan.graph).toContain('acrossfade=d=0.5')
    expect(plan.graph).not.toContain('xfade')
    expect(plan.graph).not.toContain('[outv]')
  })

  it('MP4 路径保持视频输出与视频编码器', () => {
    const plan = buildExportPlan(makeProject(), [SOURCE], true)
    expect(plan.graph).toContain('[outv]')
    const args = buildExportArgs(plan, 'graph.txt', 'out.mp4')
    expect(args).toContain('-c:v')
    expect(args).not.toContain('-vn')
  })
})

describe('纯音频 plan 的多条链分隔符合法', () => {
  /**
   * filter_complex_script 里的链必须用 `;` + **真正的换行**分隔。
   * 若误写成字面量 `\` + `n`，FFmpeg 会把下一条链解析成名为 n 的滤镜并报错，
   * 多片段工程的 M4A / MP3 导出必然失败。
   */
  const expectRealNewlineChains = (graph: string): void => {
    // 不能出现字面量的「反斜杠 + n」。
    expect(graph).not.toContain('\\n')
    const lines = graph.split('\n')
    expect(lines.length).toBeGreaterThan(1)
    // 除最后一行外，每行都以 ';' 结束（即链与链之间是 ';' + 真换行）。
    for (const line of lines.slice(0, -1)) {
      expect(line.endsWith(';')).toBe(true)
    }
    expect(lines[lines.length - 1].endsWith(';')).toBe(false)
  }

  it('主轨 3 个片段的纯音频 plan 用真实换行分隔', () => {
    const base = makeProject()
    const project: Project = {
      ...base,
      clips: [
        createClip(SOURCE.url, 0, 2, {}, 'clip-a'),
        createClip(SOURCE.url, 2, 4, {}, 'clip-b'),
        createClip(SOURCE.url, 4, 6, {}, 'clip-c'),
      ],
    }
    const plan = buildAudioExportPlan(project, [SOURCE], true)
    expect(plan.audioLabel).toBe('outa')
    expect(plan.graph).toContain('concat=n=3:v=0:a=1[outa]')
    expectRealNewlineChains(plan.graph)
    // 每条链都在自己的行上。
    expect(plan.graph.split('\n').length).toBeGreaterThanOrEqual(4)
  })

  it('主轨有空隙（gapBefore）的纯音频 plan 同样用真实换行分隔', () => {
    const base = makeProject()
    const project: Project = {
      ...base,
      clips: [
        createClip(SOURCE.url, 0, 2, { gapBefore: 2 }, 'clip-a'),
        createClip(SOURCE.url, 2, 4, {}, 'clip-b'),
      ],
    }
    const plan = buildAudioExportPlan(project, [SOURCE], true)
    expect(plan.audioLabel).toBe('outa')
    // 空隙分支会生成 anullsrc 链，一定是多行。
    expect(plan.graph).toContain('anullsrc=r=48000:cl=stereo')
    expectRealNewlineChains(plan.graph)
  })
})