import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyAttributePatch,
  createClip,
  createInitialProject,
} from '../src/editor/core/operations'
import {
  createPasteAudioAttributesCommand,
  createPasteVisualAttributesCommand,
} from '../src/editor/core/commands'
import {
  captureAudioAttrs,
  captureVisualAttrs,
  clear,
  getAudio,
  getVisual,
  hasAudio,
  hasVisual,
  setAudio,
  setVisual,
} from '../src/editor/core/attributeClipboard'
import { createEditorStore } from '../src/editor/store/editorStore'
import type { Clip, Project, SourceInfo } from '../src/editor/core/types'

const SOURCE: SourceInfo = {
  url: 'blob:test',
  name: 'test.mp4',
  size: 1024,
  duration: 20,
  width: 1920,
  height: 1080,
}

/** 主轨三个片段：c0 作为源，c1/c2 作为粘贴目标。 */
function threeClips(overrides: Record<number, Partial<Clip>> = {}): Project {
  const base = createInitialProject({ url: SOURCE.url, duration: 20 }, 'c0')
  const clips = [0, 1, 2].map((index) =>
    createClip(
      SOURCE.url,
      index * 4,
      index * 4 + 4,
      {
        id: `c${index}`,
        scale: 1,
        rotation: 0,
        volume: 1,
        ...(overrides[index] ?? {}),
      } as Partial<Clip>,
      `c${index}`,
    ),
  )
  return { ...base, clips }
}

const byId = (project: Project, id: string): Clip =>
  project.clips.find((clip) => clip.id === id)!

beforeEach(() => {
  clear()
})

describe('属性剪贴板（模块级单例）', () => {
  it('只有 set 过的分组才是 has* 为 true', () => {
    expect(hasVisual()).toBe(false)
    expect(hasAudio()).toBe(false)
    setVisual({ scale: 2 })
    expect(hasVisual()).toBe(true)
    expect(hasAudio()).toBe(false)
    setAudio({ volume: 0.5 })
    expect(hasAudio()).toBe(true)
    expect(getVisual()).toEqual({ scale: 2 })
    expect(getAudio()).toEqual({ volume: 0.5 })
    clear()
    expect(hasVisual()).toBe(false)
    expect(hasAudio()).toBe(false)
    expect(getVisual()).toBeNull()
  })

  it('capture 只取属性字段（不含 id / sourceUrl / sourceStart / speed / transitionOut）', () => {
    const clip = {
      ...createClip(SOURCE.url, 0, 4, {}, 'x'),
      scale: 1.5,
      rotation: 30,
      opacity: 0.5,
      blendMode: 'screen' as const,
      volume: 0.5,
      speed: 2,
      transitionOut: { type: 'fade' as const, duration: 0.5 },
    }
    const visual = captureVisualAttrs(clip)
    expect(visual.scale).toBe(1.5)
    expect(visual.rotation).toBe(30)
    expect(visual.opacity).toBe(0.5)
    expect(visual.blendMode).toBe('screen')
    for (const forbidden of ['id', 'sourceUrl', 'sourceStart', 'sourceEnd', 'type', 'speed', 'transitionOut', 'volume']) {
      expect(Object.keys(visual)).not.toContain(forbidden)
    }
    const audio = captureAudioAttrs(clip)
    expect(audio).toEqual({ volume: 0.5, fadeIn: 0, fadeOut: 0 })
  })

  it('源片段没有 color 字段时不复制 color（避免把默认调色硬写进目标）', () => {
    const clip = createClip(SOURCE.url, 0, 4, {}, 'x')
    expect('color' in captureVisualAttrs(clip)).toBe(false)
    const withColor = { ...clip, color: { saturation: 40 } }
    expect(captureVisualAttrs(withColor).color).toEqual({ saturation: 40 })
  })
})

describe('粘贴画面 / 音频属性命令', () => {
  it('画面属性只覆盖视觉字段，目标片段其它字段（含音频）保持原值', () => {
    const project = threeClips({ 1: { volume: 0.5, speed: 2 } })
    const source = byId(project, 'c0')
    const visual = {
      ...captureVisualAttrs({ ...source, scale: 1.5, rotation: 30 }),
    }
    const command = createPasteVisualAttributesCommand(['c1'], visual)
    const next = command.execute(project)
    expect(next).not.toBe(project)

    const target = byId(next, 'c1')
    expect(target.scale).toBe(1.5)
    expect(target.rotation).toBe(30)
    // 音频 / 变速 / 身份字段不受影响
    expect(target.volume).toBe(0.5)
    expect(target.speed).toBe(2)
    expect(target.id).toBe('c1')
    expect(target.sourceUrl).toBe(SOURCE.url)
    expect(target.sourceStart).toBe(4)
  })

  it('音频属性只覆盖音量与淡入淡出', () => {
    const project = threeClips({ 0: { volume: 0.8, fadeIn: 1, fadeOut: 0.5 }, 1: { scale: 1.2, rotation: 15 } })
    const audio = captureAudioAttrs(byId(project, 'c0'))
    const next = createPasteAudioAttributesCommand(['c1'], audio).execute(project)

    const target = byId(next, 'c1')
    expect(target.volume).toBe(0.8)
    expect(target.fadeIn).toBe(1)
    expect(target.fadeOut).toBe(0.5)
    // 画面属性不受影响
    expect(target.scale).toBe(1.2)
    expect(target.rotation).toBe(15)
  })

  it('一次命令覆盖多个片段（多选 1 步撤销）', () => {
    const project = threeClips()
    const visual = captureVisualAttrs({ ...byId(project, 'c0'), scale: 2, rotation: 45 })
    const next = createPasteVisualAttributesCommand(['c0', 'c1', 'c2'], visual).execute(project)
    for (const id of ['c0', 'c1', 'c2']) {
      expect(byId(next, id).scale).toBe(2)
      expect(byId(next, id).rotation).toBe(45)
    }
  })

  it('空 patch / 空目标 / 目标不存在时返回原 project（不写历史）', () => {
    const project = threeClips()
    expect(applyAttributePatch(project, ['c1'], {}).project).toBe(project)
    expect(applyAttributePatch(project, [], { scale: 2 }).project).toBe(project)
    expect(applyAttributePatch(project, ['nope'], { scale: 2 }).project).toBe(project)
    expect(createPasteVisualAttributesCommand(['nope'], { scale: 2 }).execute(project)).toBe(project)
  })
})

describe('store：属性复制粘贴 action', () => {

  it('复制/粘贴画面属性（真实两片段）', () => {
    const store = createEditorStore()
    store.getState().loadSource(SOURCE)
    // 在播放头处切一刀，得到两个片段
    store.getState().setPlayhead(6)
    store.getState().splitAtPlayhead()
    const [first, second] = store.getState().project.clips
    expect(second).toBeTruthy()

    store.getState().selectClip(first.id)
    store.getState().setScale(1.5)
    store.getState().setRotation(30)
    store.getState().setClipAudio(first.id, { volume: 0.9 }, '测试音量')

    store.getState().copyVisualAttributes(first.id)
    expect(getVisual()).toBeTruthy()

    store.getState().selectClip(second.id)
    store.getState().setClipAudio(second.id, { volume: 0.5 }, '测试音量')
    store.getState().pasteVisualAttributes([second.id])

    const target = store.getState().project.clips.find((clip) => clip.id === second.id)!
    expect(target.scale).toBeCloseTo(1.5, 5)
    expect(target.rotation).toBe(30)
    // 音频属性没有被画面粘贴污染
    expect(target.volume).toBeCloseTo(0.5, 5)

    // 1 步撤销即回到粘贴前
    store.getState().undo()
    const undone = store.getState().project.clips.find((clip) => clip.id === second.id)!
    expect(undone.scale).not.toBeCloseTo(1.5, 5)
  })

  it('多选 3 个片段粘贴：Toast 计数 3，且 Ctrl+Z 一次全部还原', () => {
    const store = createEditorStore()
    store.getState().loadSource(SOURCE)
    store.getState().setPlayhead(5)
    store.getState().splitAtPlayhead()
    store.getState().setPlayhead(10)
    store.getState().splitAtPlayhead()
    const ids = store.getState().project.clips.map((clip) => clip.id)
    expect(ids.length).toBe(3)

    store.getState().selectClip(ids[0])
    store.getState().setScale(1.75)
    store.getState().copyVisualAttributes(ids[0])

    store.getState().selectIds(ids)
    store.getState().pasteVisualAttributes(ids)
    for (const clip of store.getState().project.clips) {
      expect(clip.scale).toBeCloseTo(1.75, 5)
    }
    expect(store.getState().toast?.message).toContain('已粘贴到 3 个片段')

    store.getState().undo()
    const scales = store.getState().project.clips.map((clip) => clip.scale)
    expect(scales.filter((scale) => Math.abs(scale - 1.75) < 1e-6).length).toBe(1)
  })

  it('剪贴板为空时粘贴：Toast 警告且不产生历史', () => {
    const store = createEditorStore()
    store.getState().loadSource(SOURCE)
    const clipId = store.getState().selectedClipId!
    clear()
    const before = store.getState().project
    store.getState().pasteVisualAttributes([clipId])
    expect(store.getState().project).toBe(before)
    expect(store.getState().canUndo).toBe(false)
    expect(store.getState().toast?.message).toContain('剪贴板为空')
  })

  it('粘贴到锁定轨道上的片段：无变化、无历史、有警告', () => {
    const store = createEditorStore()
    store.getState().loadSource(SOURCE)
    const mainId = store.getState().selectedClipId!

    // 先复制一份画面属性
    store.getState().setScale(1.6)
    store.getState().copyVisualAttributes(mainId)

    // 建一个叠加轨并加片段，锁定该轨
    store.getState().addOverlayTrack()
    const trackId = store.getState().project.overlayTracks![0].id
    const assetId = store.getState().assets[0].id
    store.getState().addAssetToTimeline(assetId, trackId, 0)
    const overlayClipId = store.getState().project.overlayTracks![0].clips[0].id
    store.getState().toggleTrackFlag('overlay', trackId, 'locked')

    const before = store.getState().project
    const historyBefore = store.getState().canUndo
    store.getState().pasteVisualAttributes([overlayClipId])

    expect(store.getState().project).toBe(before)
    expect(store.getState().canUndo).toBe(historyBefore)
    expect(store.getState().toast?.message).toContain('锁定')
    const overlayClip = store.getState().project.overlayTracks![0].clips[0]
    expect(overlayClip.scale).not.toBeCloseTo(1.6, 5)
  })

  it('音频属性复制粘贴独立于画面属性', () => {
    const store = createEditorStore()
    store.getState().loadSource(SOURCE)
    store.getState().setPlayhead(6)
    store.getState().splitAtPlayhead()
    const [first, second] = store.getState().project.clips

    store.getState().setClipAudio(first.id, { volume: 0.8, fadeIn: 1 }, '测试音量')
    store.getState().copyAudioAttributes(first.id)
    expect(getAudio()).toEqual({ volume: 0.8, fadeIn: 1, fadeOut: 0 })

    store.getState().setScale(1.9)
    const visualBefore = store
      .getState()
      .project.clips.find((clip) => clip.id === second.id)!.scale
    store.getState().pasteAudioAttributes([second.id])
    const target = store.getState().project.clips.find((clip) => clip.id === second.id)!
    expect(target.volume).toBeCloseTo(0.8, 5)
    expect(target.fadeIn).toBe(1)
    // 画面属性没有被动过
    expect(target.scale).toBeCloseTo(visualBefore, 6)
  })

  it('主轨片段也能被粘贴（回归）', () => {
    const store = createEditorStore()
    store.getState().loadSource(SOURCE)
    store.getState().setPlayhead(6)
    store.getState().splitAtPlayhead()
    const [first, second] = store.getState().project.clips
    // 切完刀后选中的是右段，这里显式回到左段再改属性
    store.getState().selectClip(first.id)
    store.getState().setScale(1.25)
    store.getState().copyVisualAttributes(first.id)
    store.getState().pasteVisualAttributes([second.id])
    const target = store.getState().project.clips.find((clip) => clip.id === second.id)!
    expect(target.scale).toBeCloseTo(1.25, 5)
  })
})