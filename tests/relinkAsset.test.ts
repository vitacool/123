import { describe, expect, it, vi } from 'vitest'
import { createRelinkAssetCommand } from '../src/editor/core/commands'
import { createClip, createInitialProject } from '../src/editor/core/operations'
import { cueToCaptionClip } from '../src/editor/core/text'
import { createEditorStore } from '../src/editor/store/editorStore'
import type { AudioTrack, OverlayTrack, Project, TextTrack } from '../src/editor/core/types'

// 重链需要读文件 + 落盘 Blob；单元测试里用可预测的返回值替代。
vi.mock('../src/editor/services/assetReader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/editor/services/assetReader')>()
  return {
    ...actual,
    readAssetFile: vi.fn(async () => ({
      id: 'new-asset-id',
      url: 'blob:new-asset',
      name: 'old.mp4',
      size: 1024,
      duration: 10,
      width: 640,
      height: 360,
      kind: 'video',
    })),
  }
})
vi.mock('../src/editor/services/draftStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/editor/services/draftStore')>()
  return {
    ...actual,
    persistImportedAssets: vi.fn(async () => ({ saved: 1, failed: 0 })),
  }
})

const OLD = 'blob:old-asset'
const NEW = 'blob:new-asset'

function projectWithMissingAsset(): Project {
  const base = createInitialProject({ url: OLD, duration: 10 }, 'clip-a')
  const overlay: OverlayTrack = {
    id: 'overlay-1',
    name: '叠加轨 1',
    muted: false,
    hidden: false,
    clips: [createClip(OLD, 0, 3, {}, 'overlay-clip')],
  }
  const audio: AudioTrack = {
    id: 'audio-1',
    name: '音频轨 1',
    muted: false,
    hidden: false,
    volume: 1,
    clips: [
      {
        id: 'audio-clip',
        sourceUrl: OLD,
        sourceStart: 1,
        sourceEnd: 4,
        start: 2,
        volume: 0.8,
        fadeIn: 0.2,
        fadeOut: 0.3,
      },
    ],
  }
  const caption = cueToCaptionClip(
    {
      start: 0,
      end: 2,
      text: '你好',
      link: {
        clipId: 'clip-a',
        assetId: 'old-asset-id',
        sourceUrl: OLD,
        sourceStart: 0,
        sourceEnd: 4,
        padStart: 0,
        padEnd: 0.1,
      },
    },
    'caption-1',
    '16:9',
  )
  const text: TextTrack = {
    id: 'text-1',
    name: '导入字幕',
    kind: 'caption',
    muted: false,
    hidden: false,
    clips: [caption],
  }
  return {
    ...base,
    clips: [{ ...base.clips[0], sourceUrl: OLD }],
    overlayTracks: [overlay],
    audioTracks: [audio],
    textTracks: [text],
    canvasBackground: { type: 'image', imageUrl: OLD },
  }
}

describe('重新链接素材命令', () => {
  it('把主轨 / 叠加 / 音频 / 字幕 link / 背景图统一改到新 URL，并同步字幕 assetId', () => {
    const before = projectWithMissingAsset()
    const after = createRelinkAssetCommand(OLD, NEW, 'new-asset-id').execute(before)

    expect(after.clips[0].sourceUrl).toBe(NEW)
    // 入出点与关键数据不动。
    expect(after.clips[0].sourceStart).toBe(before.clips[0].sourceStart)
    expect(after.clips[0].sourceEnd).toBe(before.clips[0].sourceEnd)

    expect(after.overlayTracks?.[0].clips[0].sourceUrl).toBe(NEW)
    expect(after.audioTracks?.[0].clips[0].sourceUrl).toBe(NEW)
    expect(after.audioTracks?.[0].clips[0]).toMatchObject({
      start: 2,
      volume: 0.8,
      fadeIn: 0.2,
      fadeOut: 0.3,
    })

    const link = after.textTracks?.[0].clips[0].link
    expect(link?.sourceUrl).toBe(NEW)
    expect(link?.assetId, '字幕 link 的稳定素材 id 必须同步，否则重新对齐会指向旧素材').toBe(
      'new-asset-id',
    )
    expect(after.canvasBackground?.imageUrl).toBe(NEW)
  })

  it('新旧 URL 相同或为空时是 no-op（不产生无意义的历史步）', () => {
    const before = projectWithMissingAsset()
    expect(createRelinkAssetCommand(OLD, OLD, 'x').execute(before)).toBe(before)
    expect(createRelinkAssetCommand('', NEW, 'x').execute(before)).toBe(before)
  })

  it('store：重链后关联字幕不能被字幕联动误删（先注册新素材再执行命令）', async () => {
    const store = createEditorStore()
    store.getState().hydrateDraft({
      project: projectWithMissingAsset(),
      assets: [],
      missingAssets: [{ url: OLD, name: 'old.mp4', kind: 'video', duration: 10 }],
      source: null,
      timelineZoom: 1,
      timelineSettings: {
        mainTrackMagnet: false,
        autoSnap: true,
        linkage: false,
        previewAxis: true,
        captionFollow: true,
        exportRange: null,
      },
      playhead: 0,
    })
    const ok = await store.getState().relinkMissingAsset(
      OLD,
      new File(['x'], 'old.mp4', { type: 'video/mp4' }),
    )
    expect(ok).toBe(true)
    const state = store.getState()
    expect(state.project.clips[0].sourceUrl, '主轨片段改到新 URL').toBe('blob:new-asset')
    expect(state.project.textTracks?.[0].clips, '关联字幕不能被删').toHaveLength(1)
    expect(state.project.textTracks?.[0].clips[0].link?.assetId).toBe('new-asset-id')
    expect(state.assets.some((item) => item.url === 'blob:new-asset')).toBe(true)
    expect(state.source?.url, '原主素材丢失后要重新接回 source').toBe('blob:new-asset')
  })
})