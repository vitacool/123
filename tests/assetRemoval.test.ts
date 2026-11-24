import { describe, expect, it } from 'vitest'
import {
  assetUrlSet,
  countAssetReferences,
  isAssetReferenced,
  isClipAssetMissing,
  reversedDependents,
  unusedAssets,
} from '../src/editor/core/assets'
import { createRemoveAssetClipsCommand, createDeleteManyCommand } from '../src/editor/core/commands'
import { buildExportPlan } from '../src/editor/core/exportPlan'
import { createInitialProject, removeClipsForAsset } from '../src/editor/core/operations'
import { createEditorStore } from '../src/editor/store/editorStore'
import type {
  AudioClip,
  AudioTrack,
  Clip,
  MediaAsset,
  OverlayTrack,
  Project,
  SourceInfo,
  TextClip,
  TextTrack,
} from '../src/editor/core/types'

const source = (url: string, name = url): SourceInfo => ({
  url,
  name,
  size: 1024,
  duration: 10,
  width: 640,
  height: 360,
})

const asset = (id: string, url: string): MediaAsset => ({ ...source(url), id, kind: 'video' })

const clip = (id: string, url: string, extra: Partial<Clip> = {}): Clip => ({
  id,
  sourceUrl: url,
  sourceStart: 0,
  sourceEnd: 4,
  type: 'video',
  rotation: 0,
  flipH: false,
  flipV: false,
  crop: { x: 0, y: 0, w: 1, h: 1 },
  scale: 1,
  position: { x: 0, y: 0 },
  gapBefore: 0,
  ...extra,
})

const overlayTrack = (id: string, clips: Clip[]): OverlayTrack => ({
  id,
  name: id,
  muted: false,
  hidden: false,
  enabled: true,
  locked: false,
  solo: false,
  clips,
})

const audioClip = (id: string, url: string): AudioClip => ({
  id,
  sourceUrl: url,
  sourceStart: 0,
  sourceEnd: 4,
  start: 0,
  volume: 1,
  fadeIn: 0,
  fadeOut: 0,
})

const audioTrack = (id: string, clips: AudioClip[]): AudioTrack => ({
  id,
  name: id,
  muted: false,
  hidden: false,
  enabled: true,
  locked: false,
  solo: false,
  volume: 1,
  clips,
})

const textClip = (id: string, assetId: string): TextClip =>
  ({
    id,
    text: '字幕',
    start: 0,
    end: 2,
    link: { assetId },
  }) as unknown as TextClip

const textTrack = (id: string, clips: TextClip[]): TextTrack => ({
  id,
  name: id,
  kind: 'caption',
  muted: false,
  hidden: false,
  enabled: true,
  locked: false,
  solo: false,
  clips,
})

/** 工程：主轨 2 段（都用 A），叠加轨 1 段（A），音频轨 1 段（B），字幕 1 条（link A）。 */
function projectWithReferences(): Project {
  const base = createInitialProject({ url: 'u1', duration: 10 }, 'main-1')
  return {
    ...base,
    clips: [
      clip('main-1', 'u1', { sourceEnd: 4 }),
      { ...clip('main-2', 'u1', { sourceStart: 4, sourceEnd: 8 }), gapBefore: 0 },
    ],
    overlayTracks: [overlayTrack('ov1', [clip('ov-clip', 'u1')])],
    audioTracks: [audioTrack('au1', [audioClip('au-clip', 'u2')])],
    textTracks: [textTrack('tx1', [textClip('tx-clip', 'asset-a')])],
  }
}

describe('素材引用关系（core/assets）', () => {
  it('统计引用数：主轨 + 叠加轨 + 音频轨 + 字幕 link', () => {
    const project = projectWithReferences()
    expect(countAssetReferences(project, { id: 'asset-a', url: 'u1' })).toBe(4)
    expect(countAssetReferences(project, { id: 'asset-b', url: 'u2' })).toBe(1)
    expect(countAssetReferences(project, { id: 'asset-c', url: 'u3' })).toBe(0)
    expect(isAssetReferenced(project, { id: 'asset-c', url: 'u3' })).toBe(false)
  })

  it('unusedAssets 只返回完全没有引用的素材', () => {
    const project = projectWithReferences()
    const assets = [asset('a', 'u1'), asset('b', 'u2'), asset('c', 'u3')]
    expect(unusedAssets(project, assets).map((item) => item.id)).toEqual(['c'])
  })

  it('isClipAssetMissing 按 url 判断', () => {
    const urls = assetUrlSet([asset('a', 'u1')])
    expect(isClipAssetMissing(urls, { sourceUrl: 'u1' })).toBe(false)
    expect(isClipAssetMissing(urls, { sourceUrl: 'u9' })).toBe(true)
  })

  it('倒放素材引用的原素材不算「未使用」（清理时保留，才能恢复正放）', () => {
    // 片段只用了倒放素材 rev；原素材 orig 没有任何片段直接引用。
    const project: Project = {
      ...createInitialProject(source('orig'), 'clip-a'),
      clips: [clip('clip-a', 'rev')],
    }
    const original: MediaAsset = asset('orig', 'orig')
    const reversed: MediaAsset = {
      ...asset('rev', 'rev'),
      reversedFrom: { assetId: 'orig', sourceUrl: 'orig', start: 0, end: 4 },
    }
    expect(unusedAssets(project, [original, reversed]).map((item) => item.id)).toEqual([])
    // 没有倒放素材依赖它时才会被清理。
    expect(unusedAssets(project, [original]).map((item) => item.id)).toEqual(['orig'])
  })

  it('链式倒放：只保留最外层也会连带保留上游原素材', () => {
    const project: Project = {
      ...createInitialProject(source('orig'), 'clip-a'),
      clips: [clip('clip-a', 'rev2')],
    }
    const original: MediaAsset = asset('orig', 'orig')
    const first: MediaAsset = {
      ...asset('rev1', 'rev1'),
      reversedFrom: { assetId: 'orig', sourceUrl: 'orig', start: 0, end: 4 },
    }
    const second: MediaAsset = {
      ...asset('rev2', 'rev2'),
      reversedFrom: { assetId: 'rev1', sourceUrl: 'rev1', start: 0, end: 4 },
    }
    expect(unusedAssets(project, [original, first, second]).map((item) => item.id)).toEqual([])
  })

  it('reversedDependents 找出依赖该素材的倒放素材（删除前提示用）', () => {
    const original: MediaAsset = asset('orig', 'orig')
    const other: MediaAsset = asset('other', 'other')
    const reversed: MediaAsset = {
      ...asset('rev', 'rev'),
      reversedFrom: { assetId: 'orig', sourceUrl: 'orig', start: 0, end: 4 },
    }
    expect(reversedDependents([original, other, reversed], original).map((item) => item.id)).toEqual(
      ['rev'],
    )
    expect(reversedDependents([original, other, reversed], other)).toEqual([])
  })
})

describe('删除素材关联片段（operations / commands）', () => {
  it('一次删除主轨 + 叠加轨 + 音频轨 + 字幕里所有引用该素材的片段', () => {
    const project = projectWithReferences()
    const next = removeClipsForAsset(project, { url: 'u1', assetId: 'asset-a' })

    expect(next.clips).toHaveLength(0)
    expect(next.overlayTracks![0].clips).toHaveLength(0)
    // 音频轨引用的是 u2，不动
    expect(next.audioTracks![0].clips).toHaveLength(1)
    // 字幕 link 指向 asset-a，删掉
    expect(next.textTracks![0].clips).toHaveLength(0)
  })

  it('没有片段引用时返回原 project（不产生历史）', () => {
    const project = projectWithReferences()
    const untouched = removeClipsForAsset(project, { url: 'u9', assetId: 'asset-z' })
    expect(untouched).toBe(project)
    expect(createRemoveAssetClipsCommand({ url: 'u9', assetId: 'asset-z' }).execute(project)).toBe(project)
  })

  /**
   * 批量删除（Ctrl+X / 框选后删除）以前完全不看 locked：锁了轨还能删掉片段，
   * 用户会觉得「锁定形同虚设」。单选 Delete 走的是另一条路径（那里判了锁）。
   */
  it('createDeleteManyCommand 跳过锁定轨道；全部被锁时返回原对象', () => {
    const base = createInitialProject({ url: 'u1', duration: 10 }, 'a')
    const project: Project = {
      ...base,
      clips: [clip('a', 'u1'), clip('b', 'u1')],
      audioTracks: [
        {
          id: 'at',
          name: '配音',
          muted: false,
          hidden: false,
          enabled: true,
          locked: true,
          solo: false,
          volume: 1,
          clips: [
            { id: 'ac', sourceUrl: 'u1', sourceStart: 0, sourceEnd: 5, start: 0, volume: 1, fadeIn: 0, fadeOut: 0 },
          ],
        },
      ],
    }

    // 锁定音频轨：它的片段不能被删，但主轨的可以
    const partial = createDeleteManyCommand(['a', 'ac']).execute(project)
    expect(partial.clips.map((item) => item.id)).toEqual(['b'])
    expect(partial.audioTracks?.[0].clips.map((item) => item.id)).toEqual(['ac'])

    // 全部命中的都在锁定轨 → 原对象（不进历史）
    expect(createDeleteManyCommand(['ac']).execute(project)).toBe(project)

    // 锁定主轨后，主轨片段同样受保护
    const mainLocked: Project = { ...project, mainTrack: { ...project.mainTrack, locked: true } as Project['mainTrack'] }
    expect(createDeleteManyCommand(['a']).execute(mainLocked)).toBe(mainLocked)
  })
})

describe('导出：素材缺失的片段输出画布背景', () => {
  const sources = [source('u1'), source('u2')]

  it('缺失素材的片段生成 color 分支，不再复用别的输入', () => {
    const base = createInitialProject({ url: 'u1', duration: 10 }, 'keep')
    const project: Project = {
      ...base,
      clips: [clip('keep', 'u1'), clip('gone', 'u3')],
    }
    const plan = buildExportPlan(project, sources, true)
    // 只有 u1 一个输入
    expect(plan.inputs.map((item) => item.url)).toEqual(['u1'])
    // 第二段为纯色背景
    expect(plan.graph).toContain('color=c=0x000000:s=640x360')
    expect(plan.graph).toContain('concat=n=2:v=1:a=0[outv]')
  })

  it('素材缺失的叠加片段不参与合成', () => {
    const base = createInitialProject({ url: 'u1', duration: 10 }, 'keep')
    const project: Project = {
      ...base,
      clips: [clip('keep', 'u1')],
      overlayTracks: [overlayTrack('ov1', [clip('ov-gone', 'u3')])],
    }
    const plan = buildExportPlan(project, sources, true)
    expect(plan.graph).not.toContain('[ov0]')
    expect(plan.inputs.map((item) => item.url)).toEqual(['u1'])
  })
})

describe('store：removeAsset / cleanupUnusedAssets', () => {
  const makeStore = () => {
    const store = createEditorStore()
    store.getState().loadSource(source('u1'))
    return store
  }

  /**
   * 空会话里只导入音频也必须分配 projectId：否则 buildDraftRecord 返回 null、
   * 保存被整体跳过 —— 刷新后音频素材与已写入 IndexedDB 的 blob 全丢。
   */
  it('纯音频首次导入也会分配 projectId（否则刷新后素材全丢）', () => {
    const store = createEditorStore()
    expect(store.getState().projectId).toBeNull()
    store.getState().addAssets([{ ...asset('bgm', 'u-audio'), kind: 'audio', name: 'bgm.mp3' }])
    const state = store.getState()
    expect(state.assets).toHaveLength(1)
    expect(state.projectId, '纯音频会话必须拿到项目身份，草稿才会落盘').toBeTruthy()
    expect(state.projectName).toBeTruthy()
  })

  it('未被引用的素材直接删除，assets 收缩、source 保留', () => {
    const store = makeStore()
    store.getState().addAssets([{ ...asset('extra', 'u2'), name: 'extra.mp4' }])
    expect(store.getState().assets).toHaveLength(2)

    store.getState().removeAsset('extra', { removeClips: false })
    const state = store.getState()
    expect(state.assets.map((item) => item.id)).toEqual([state.assets[0].id])
    expect(state.assets).toHaveLength(1)
    expect(state.source?.url).toBe('u1')
    expect(state.toast?.message).toContain('已删除素材')
  })

  it('删除当前 source 时自动切到下一个素材', () => {
    const store = makeStore()
    const mainAssetId = store.getState().assets[0].id
    store.getState().addAssets([asset('second', 'u2')])
    store.getState().removeAsset(mainAssetId, { removeClips: false })
    expect(store.getState().source?.url).toBe('u2')
  })

  it('removeClips=true：片段一起删除，Ctrl+Z 一次恢复片段**和素材**', () => {
    const store = makeStore()
    const assetId = store.getState().assets[0].id
    store.getState().setPlayhead(4)
    store.getState().splitAtPlayhead()
    expect(store.getState().project.clips).toHaveLength(2)

    store.getState().removeAsset(assetId, { removeClips: true })
    expect(store.getState().project.clips).toHaveLength(0)
    expect(store.getState().assets).toHaveLength(0)

    store.getState().undo()
    // 片段回来了 → 素材也必须回到素材库（否则片段指向已 revoke 的源，就是坏片段）
    expect(store.getState().project.clips).toHaveLength(2)
    expect(store.getState().assets).toHaveLength(1)
    expect(store.getState().assets[0].url).toBe('u1')
    // 撤销后不再有「待回收」素材
    expect(store.getState().pendingReclaim).toEqual({})
  })

  it('removeClips=false：片段保留（引用一个已不在 assets 里的 url），并写入 missingAssets', () => {
    const store = makeStore()
    const assetId = store.getState().assets[0].id
    store.getState().removeAsset(assetId, { removeClips: false })
    expect(store.getState().project.clips).toHaveLength(1)
    expect(store.getState().assets).toHaveLength(0)
    // 片段引用的 url 已无对应素材 → 缺失
    expect(isClipAssetMissing(assetUrlSet(store.getState().assets), store.getState().project.clips[0])).toBe(true)
    // 必须写进 missingAssets：否则刷新后 pruneProjectUrls 会把片段剔掉，
    // 「片段变空白」变成「片段直接消失」。
    expect(store.getState().missingAssets).toEqual([
      expect.objectContaining({ url: 'u1', kind: 'video' }),
    ])
  })

  it('removeClips=true：不留下占位记录', () => {
    const store = makeStore()
    const assetId = store.getState().assets[0].id
    store.getState().removeAsset(assetId, { removeClips: false })
    expect(store.getState().missingAssets).toHaveLength(1)
    // 撤销回片段后，再次连带删除素材：占位记录应被清掉
    store.getState().addAssets([{ ...asset('again', 'u1'), name: 'again.mp4' }])
    store.getState().removeAsset('again', { removeClips: true })
    expect(store.getState().missingAssets).toHaveLength(0)
  })

  it('setAssetFolder：写入/清空文件夹，空名视为未分类', () => {
    const store = makeStore()
    const assetId = store.getState().assets[0].id
    store.getState().setAssetFolder(assetId, '  旅行  ')
    expect(store.getState().assets[0].folder).toBe('旅行')
    store.getState().setAssetFolder(assetId, '')
    expect(store.getState().assets[0].folder).toBeUndefined()
  })

  it('renameAsset：素材与主素材显示名一起更新，空名/同名不改', () => {
    const store = makeStore()
    const assetId = store.getState().assets[0].id
    store.getState().renameAsset(assetId, '  新名字  ')
    expect(store.getState().assets[0].name).toBe('新名字')
    expect(store.getState().source?.name).toBe('新名字')
    store.getState().renameAsset(assetId, '   ')
    expect(store.getState().assets[0].name).toBe('新名字')
  })

  it('updateAssetThumbnail：素材与主素材缩略图一起更新', () => {
    const store = makeStore()
    const assetId = store.getState().assets[0].id
    store.getState().updateAssetThumbnail(assetId, 'data:image/jpeg;base64,AAA')
    expect(store.getState().assets[0].thumbnail).toBe('data:image/jpeg;base64,AAA')
    expect(store.getState().source?.thumbnail).toBe('data:image/jpeg;base64,AAA')
  })

  it('cleanupUnusedAssets 删除闲置素材并报告数量', () => {
    const store = makeStore()
    store.getState().addAssets([asset('x', 'u2'), asset('y', 'u3')])
    expect(store.getState().assets).toHaveLength(3)

    store.getState().cleanupUnusedAssets()
    expect(store.getState().assets).toHaveLength(1)
    expect(store.getState().toast?.message).toContain('已清理 2 个未使用素材')

    // 没有闲置素材时再点一次：提示且不变化
    store.getState().cleanupUnusedAssets()
    expect(store.getState().assets).toHaveLength(1)
    expect(store.getState().toast?.message).toContain('没有未使用的素材')
  })
})