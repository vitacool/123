import { describe, expect, it } from 'vitest'
import {
  addClipToTrackAtTime,
  addEmptyOverlayTrack,
  createInitialProject,
  displayToArrayIndex,
  moveAudioTrackInProject,
  moveOverlayTrackInProject,
  moveTrackInProject,
} from '../src/editor/core/operations'
import { createMoveTrackCommand } from '../src/editor/core/commands'
import { buildExportPlan } from '../src/editor/core/exportPlan'
import { createClip } from '../src/editor/core/operations'
import type { AudioTrack, Clip, Project, SourceInfo, TextTrack } from '../src/editor/core/types'

const SOURCE: SourceInfo = {
  url: 'blob:order',
  name: 'src.mp4',
  size: 1_000_000,
  duration: 30,
  width: 1920,
  height: 1080,
}

const base = (): Project => ({
  ...createInitialProject({ url: SOURCE.url, duration: 30 }, 'main'),
  aspectRatio: '16:9',
  exportQuality: { resolution: '480p', fps: 30 },
  clips: [createClip(SOURCE.url, 0, 10, {}, 'main')],
})

// 两条叠加轨的片段要**内容不同**（不同源区间），否则交换顺序后的 graph 完全相同，
// 就测不出「顺序 = 合成层级」。
const overlayClip = (id: string): Clip => ({
  ...createClip(SOURCE.url, id === 'c-a' ? 0 : 12, id === 'c-a' ? 4 : 16, {}, id),
  ...({ start: 0 } as object),
})

function withOverlays(ids: readonly string[]): Project {
  let project = base()
  for (const id of ids) {
    const created = addEmptyOverlayTrack(project, id)!
    project = created.project
  }
  for (const id of ids) {
    project = addClipToTrackAtTime(project, overlayClip(`c-${id}`), id, 0)!
  }
  return project
}

const audioTrack = (id: string, name = id): AudioTrack => ({
  id,
  name,
  muted: false,
  hidden: false,
  enabled: true,
  locked: false,
  solo: false,
  volume: 1,
  clips: [],
})

const textTrack = (id: string, name = id): TextTrack => ({
  id,
  name,
  muted: false,
  hidden: false,
  locked: false,
  clips: [],
})

describe('显示顺序 ↔ 数组顺序换算', () => {
  it('叠加轨倒序（数组末尾 = 界面最上面），音频/文字轨同序', () => {
    expect(displayToArrayIndex('overlay', 0, 3)).toBe(2)
    expect(displayToArrayIndex('overlay', 2, 3)).toBe(0)
    expect(displayToArrayIndex('audio', 0, 3)).toBe(0)
    expect(displayToArrayIndex('text', 2, 3)).toBe(2)
  })
})

describe('叠加轨：移到顶/底/中间、方向换算', () => {
  it('界面往上移 = 数组下标变大（最上层 = 数组末尾）', () => {
    const project = withOverlays(['a', 'b', 'c'])
    // 界面顺序（上→下）：c, b, a
    // 界面顺序（上→下）是 c、b、a；a 上移一层 → 界面变成 c、a、b → 数组 [b, a, c]
    const up = moveOverlayTrackInProject(project, 'a', 'up')
    expect((up.overlayTracks ?? []).map((t) => t.id)).toEqual(['b', 'a', 'c'])
  })

  it('移到界面最上面 → 数组最后一位', () => {
    const project = withOverlays(['a', 'b', 'c'])
    // 界面下标 0 是 c；把 a（界面下标 2）移到 0
    const moved = moveTrackInProject(project, 'overlay', 'a', 0)
    // a 移到界面最上面 → 数组末尾 → [b, c, a]
    expect((moved.overlayTracks ?? []).map((t) => t.id)).toEqual(['b', 'c', 'a'])
  })

  it('移到界面最下面 → 数组第 0 位', () => {
    const project = withOverlays(['a', 'b', 'c'])
    const moved = moveTrackInProject(project, 'overlay', 'c', 2)
    // c 移到界面最下面 → 数组第 0 位 → [c, a, b]
    expect((moved.overlayTracks ?? []).map((t) => t.id)).toEqual(['c', 'a', 'b'])
  })

  it('移到中间 + 位置不变时返回原对象（不产生撤销记录）', () => {
    const project = withOverlays(['a', 'b', 'c'])
    const same = moveTrackInProject(project, 'overlay', 'b', 1)
    expect(same).toBe(project)

    // b 从界面下标 1 移到 2（界面最下面）
    const moved = moveTrackInProject(project, 'overlay', 'b', 2)
    // b 移到界面最下面 → 数组第 0 位 → [b, a, c]
    expect((moved.overlayTracks ?? []).map((t) => t.id)).toEqual(['b', 'a', 'c'])
  })

  it('越过锁定轨道也能移动；锁定轨道本身不能移动（由 UI 禁用，核心层不拦）', () => {
    const project = withOverlays(['a', 'b', 'c'])
    const locked: Project = {
      ...project,
      overlayTracks: (project.overlayTracks ?? []).map((track) =>
        track.id === 'b' ? { ...track, locked: true } : track,
      ),
    }
    // a（界面最下）移到界面最上，越过锁定的 b
    const moved = moveTrackInProject(locked, 'overlay', 'a', 0)
    expect((moved.overlayTracks ?? []).map((t) => t.id)).toEqual(['b', 'c', 'a'])
  })

  it('轨道名与片段内容不因移动改变', () => {
    const project = withOverlays(['a', 'b'])
    const before = (project.overlayTracks ?? []).find((t) => t.id === 'a')!
    const moved = moveTrackInProject(project, 'overlay', 'a', 0)
    const after = (moved.overlayTracks ?? []).find((t) => t.id === 'a')!
    expect(after.name).toBe(before.name)
    expect(after.clips).toEqual(before.clips)
  })
})

describe('音频轨 / 文字轨', () => {
  it('音频轨：上传下移与数组下标同向', () => {
    const project: Project = {
      ...base(),
      audioTracks: [audioTrack('a1', '音频轨 1'), audioTrack('a2', '音频轨 2')],
    }
    const down = moveAudioTrackInProject(project, 'a1', 'down')
    expect((down.audioTracks ?? []).map((t) => t.id)).toEqual(['a2', 'a1'])
    const back = moveAudioTrackInProject(down, 'a1', 'up')
    expect((back.audioTracks ?? []).map((t) => t.id)).toEqual(['a1', 'a2'])
  })

  it('文字轨：移到顶/底、越界夹取、位置不变返回原对象', () => {
    const project: Project = {
      ...base(),
      textTracks: [textTrack('t1'), textTrack('t2'), textTrack('t3')],
    }
    const top = moveTrackInProject(project, 'text', 't3', 0)
    expect((top.textTracks ?? []).map((t) => t.id)).toEqual(['t3', 't1', 't2'])
    const bottom = moveTrackInProject(project, 'text', 't1', 99)
    expect((bottom.textTracks ?? []).map((t) => t.id)).toEqual(['t2', 't3', 't1'])
    expect(moveTrackInProject(project, 'text', 't2', 1)).toBe(project)
  })

  it('未知轨道 id 返回原对象', () => {
    const project = withOverlays(['a'])
    expect(moveTrackInProject(project, 'overlay', 'nope', 0)).toBe(project)
    expect(moveTrackInProject(project, 'audio', 'nope', 0)).toBe(project)
  })
})

describe('命令：一次拖动 = 一步撤销', () => {
  it('撤销恢复原顺序，重做再应用', () => {
    const project = withOverlays(['a', 'b', 'c'])
    const command = createMoveTrackCommand('overlay', 'a', 0)
    expect(command.label).toBe('调整叠加轨顺序')
    const moved = command.execute(project)
    expect((moved.overlayTracks ?? []).map((t) => t.id)).toEqual(['b', 'c', 'a'])
    // 命令是纯函数：原 project 未被修改
    expect((project.overlayTracks ?? []).map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })

  it('label 按类型区分', () => {
    expect(createMoveTrackCommand('audio', 'x', 0).label).toBe('调整音频轨顺序')
    expect(createMoveTrackCommand('text', 'x', 0).label).toBe('调整文字轨顺序')
  })
})

describe('叠加轨顺序 = 合成层级（导出 graph 随之变化）', () => {
  it('调整顺序后 overlay 链的顺序改变', () => {
    const project = withOverlays(['a', 'b'])
    const before = buildExportPlan(project, SOURCE, true).graph
    const moved = moveTrackInProject(project, 'overlay', 'a', 0)
    const after = buildExportPlan(moved, SOURCE, true).graph
    expect(after).not.toBe(before)
    // 两条轨道都在图里各出现一次 overlay
    expect((before.match(/overlay=/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect((after.match(/overlay=/g) ?? []).length).toBe(
      (before.match(/overlay=/g) ?? []).length,
    )
  })

  it('没有调整顺序时快照不变（同一 project 的两次构建一致）', () => {
    const project = withOverlays(['a', 'b'])
    expect(buildExportPlan(project, SOURCE, true).graph).toBe(
      buildExportPlan(project, SOURCE, true).graph,
    )
  })
})