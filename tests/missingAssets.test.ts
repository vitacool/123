import { describe, expect, it } from 'vitest'
import { createInitialProject } from '../src/editor/core/operations'
import type { DraftAsset, MissingAsset } from '../src/editor/core/draft'
import type { AudioClip, Project, TextClip } from '../src/editor/core/types'
import {
  applyPickOutcome,
  assignPickedFiles,
  countClipReferences,
  emptyMissingAssetsSelection,
  filterReferencedMissingAssets,
  matchPickedFiles,
  mergeMissingAssets,
  missingAssetFromDraft,
  missingAssetsForUnpicked,
  missingSelectionSummary,
  normalizeAssetName,
  pendingMissingAssets,
  skipAllMissingAssets,
  skipMissingAsset,
} from '../src/editor/core/missingAssets'

const fileOf = (name: string): File => new File([new Uint8Array([1])], name, { type: 'video/mp4' })

const draftAsset = (id: string, name: string, url = `blob:${id}`): DraftAsset => ({
  id,
  url,
  name,
  size: 10,
  duration: 5,
  width: 320,
  height: 180,
  kind: 'video',
  local: true,
})

const item = (id: string, name: string) => ({ id, name })

describe('normalizeAssetName / 文件名匹配', () => {
  it('忽略扩展名、大小写与首尾空白', () => {
    expect(normalizeAssetName(' Clip.MP4 ')).toBe('clip')
  })

  it('按文件名自动匹配（可一次多选）', () => {
    const pending = [item('a', 'a.mp4'), item('b', 'b.mp4')]
    const { assignments, unmatched } = matchPickedFiles(pending, [
      fileOf('b.mp4'),
      fileOf('a.MP4'),
    ])
    expect(assignments.get('a')?.name).toBe('a.MP4')
    expect(assignments.get('b')?.name).toBe('b.mp4')
    expect(unmatched).toEqual([])
  })

  it('同名素材按顺序分配；多出来的文件算未匹配', () => {
    const pending = [item('a1', 'clip.mp4'), item('a2', 'clip.mp4')]
    const { assignments, unmatched } = matchPickedFiles(pending, [
      fileOf('clip.mp4'),
      fileOf('clip-2.mp4'),
      fileOf('other.mp4'),
    ])
    expect([...assignments.keys()]).toEqual(['a1'])
    expect(unmatched.map((file) => file.name)).toEqual(['clip-2.mp4', 'other.mp4'])
  })

  it('只选了一个文件且指定了目标行：名字不同也绑定该行', () => {
    const pending = [item('a', 'original.mp4')]
    const { assignments, unmatched } = matchPickedFiles(pending, [fileOf('renamed.mov')], 'a')
    expect(assignments.get('a')?.name).toBe('renamed.mov')
    expect(unmatched).toEqual([])
  })
})

describe('选择状态：取消 = 标记为跳过', () => {
  it('skipMissingAsset 把素材标记为跳过（取消选择框走这里）', () => {
    const selection = skipMissingAsset(emptyMissingAssetsSelection(), 'a')
    const items = [item('a', 'a.mp4'), item('b', 'b.mp4')]
    expect(missingSelectionSummary(items, selection)).toEqual({ picked: 0, skipped: 1, pending: 1 })
    expect(missingAssetsForUnpicked([draftAsset('a', 'a.mp4'), draftAsset('b', 'b.mp4')], selection)).toEqual([
      expect.objectContaining({ url: 'blob:a' }),
      expect.objectContaining({ url: 'blob:b' }),
    ])
  })

  it('assignPickedFiles 写入文件并解除跳过', () => {
    const selection = skipMissingAsset(emptyMissingAssetsSelection(), 'a')
    const { selection: next, unmatched } = assignPickedFiles(
      selection,
      [item('a', 'a.mp4')],
      [fileOf('a.mp4')],
      'a',
    )
    expect(unmatched).toEqual([])
    expect(next.picked.get('a')?.name).toBe('a.mp4')
    expect(next.skipped.has('a')).toBe(false)
    expect(missingAssetsForUnpicked([draftAsset('a', 'a.mp4')], next)).toEqual([])
  })

  it('全部跳过：所有素材都在 missingAssets 里，且没有待选项', () => {
    const items = [draftAsset('a', 'a.mp4'), draftAsset('b', 'b.mp4')]
    const selection = skipAllMissingAssets(
      emptyMissingAssetsSelection(),
      items.map((asset) => asset.id),
    )
    expect(missingSelectionSummary(items, selection)).toEqual({ picked: 0, skipped: 2, pending: 0 })
    expect(pendingMissingAssets(items, selection)).toEqual([])
    expect(missingAssetsForUnpicked(items, selection)).toHaveLength(2)
  })
})

describe('applyPickOutcome：取消按跳过处理', () => {
  it('单行选择被取消 → Promise 结果标记该素材为跳过', () => {
    const selection = emptyMissingAssetsSelection()
    const items = [draftAsset('a', 'a.mp4'), draftAsset('b', 'b.mp4')]
    const applied = applyPickOutcome(selection, items, { files: [], cancelled: true }, 'a')
    expect(applied.selection.skipped.has('a')).toBe(true)
    expect(applied.selection.picked.has('a')).toBe(false)
    expect(missingSelectionSummary(items, applied.selection)).toEqual({
      picked: 0,
      skipped: 1,
      pending: 1,
    })
  })

  it('一次多选被取消 → 状态不变（不误标跳过）', () => {
    const selection = emptyMissingAssetsSelection()
    const applied = applyPickOutcome(
      selection,
      [draftAsset('a', 'a.mp4')],
      { files: [], cancelled: true },
    )
    expect(applied.selection).toBe(selection)
  })

  it('选到文件 → 自动匹配并解除跳过', () => {
    const selection = skipMissingAsset(emptyMissingAssetsSelection(), 'a')
    const applied = applyPickOutcome(
      selection,
      [draftAsset('a', 'a.mp4')],
      { files: [fileOf('a.mp4')], cancelled: false },
      'a',
    )
    expect(applied.selection.picked.get('a')?.name).toBe('a.mp4')
    expect(applied.selection.skipped.has('a')).toBe(false)
    expect(applied.unmatched).toEqual([])
  })
})

describe('缺失素材元信息', () => {
  it('missingAssetFromDraft 只保留展示需要的字段', () => {
    expect(missingAssetFromDraft(draftAsset('a', 'a.mp4'))).toEqual({
      url: 'blob:a',
      name: 'a.mp4',
      kind: 'video',
      duration: 5,
    })
  })

  it('mergeMissingAssets 按 url 去重（后出现的补全元信息）', () => {
    const first: MissingAsset[] = [{ url: 'blob:a' }]
    const second: MissingAsset[] = [{ url: 'blob:a', name: 'a.mp4' }]
    expect(mergeMissingAssets(first, second)).toEqual([{ url: 'blob:a', name: 'a.mp4' }])
  })

  it('filterReferencedMissingAssets 只保留仍被工程引用的项', () => {
    const project = createInitialProject({ url: 'blob:a', duration: 5 }, 'clip-1')
    const filtered = filterReferencedMissingAssets(
      [{ url: 'blob:a' }, { url: 'blob:unused' }],
      project,
    )
    expect(filtered).toEqual([{ url: 'blob:a' }])
  })

  it('countClipReferences 统计主轨 / 叠加 / 音频 / 字幕引用', () => {
    const base = createInitialProject({ url: 'blob:a', duration: 5 }, 'clip-1')
    const audio: AudioClip = {
      id: 'audio-1',
      sourceUrl: 'blob:a',
      sourceStart: 0,
      sourceEnd: 5,
      start: 0,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
    }
    const text: TextClip = {
      id: 'text-1',
      text: '字幕',
      start: 0,
      end: 2,
      x: 0.5,
      y: 0.85,
      fontSize: 0.06,
      color: '#fff',
      background: 'transparent',
      align: 'center',
      bold: false,
      link: {
        clipId: 'clip-1',
        sourceUrl: 'blob:a',
        sourceStart: 0,
        sourceEnd: 5,
        padStart: 0,
        padEnd: 0,
      },
    }
    const project: Project = {
      ...base,
      overlayTracks: [
        {
          id: 'overlay-1',
          name: '叠加轨 1',
          muted: false,
          hidden: false,
          clips: [{ ...base.clips[0], id: 'overlay-clip' }],
        },
      ],
      audioTracks: [{ id: 'audio-track', name: '音频轨 1', muted: false, hidden: false, volume: 1, clips: [audio] }],
      textTracks: [{ id: 'text-track', name: '字幕轨', muted: false, hidden: false, clips: [text] }],
    }
    expect(countClipReferences(project, 'blob:a')).toBe(4)
  })
})