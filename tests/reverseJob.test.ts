import { beforeEach, describe, expect, it, vi } from 'vitest'

// 「生成倒放素材」的副作用全部 mock 掉：这里只验证 store 的编排
// （任务被取消 / 工程被切换后，晚到的结果不能写进工程；完成时使用片段最新数据）。
vi.mock('../src/editor/services/reverseMedia', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/editor/services/reverseMedia')>()
  return { ...actual, reverseAssetSpan: vi.fn() }
})

vi.mock('../src/editor/services/assetReader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/editor/services/assetReader')>()
  return { ...actual, readAssetFile: vi.fn() }
})

vi.mock('../src/editor/services/draftStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/editor/services/draftStore')>()
  return {
    ...actual,
    saveMediaBlob: vi.fn(async () => undefined),
    deleteMediaBlob: vi.fn(async () => undefined),
  }
})

import { createEditorStore } from '../src/editor/store/editorStore'
import { createUpdateAnyClipCommand } from '../src/editor/core/commands'
import { reverseAssetSpan } from '../src/editor/services/reverseMedia'
import { readAssetFile } from '../src/editor/services/assetReader'
import { deleteMediaBlob, saveMediaBlob } from '../src/editor/services/draftStore'
import type { MediaAsset, SourceInfo } from '../src/editor/core/types'

const SOURCE: SourceInfo = {
  url: 'blob:reverse-job-source',
  name: 'source.mp4',
  size: 1024,
  duration: 12,
  width: 1920,
  height: 1080,
  kind: 'video',
}
const OTHER: SourceInfo = {
  url: 'blob:other-project',
  name: 'other.mp4',
  size: 1024,
  duration: 8,
  width: 1280,
  height: 720,
  kind: 'video',
}

/** 可控的 Promise，用来模拟「生成中 / 保存中」。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const reversedAsset = (): MediaAsset => ({
  id: 'asset-new',
  url: 'blob:reverse-job-new',
  name: 'source-倒放.mp4',
  size: 10,
  duration: 12,
  width: 1080,
  height: 608,
  kind: 'video',
  reversedFrom: {
    assetId: 'asset-source-placeholder',
    sourceUrl: SOURCE.url,
    start: 0,
    end: 12,
  },
})

const videoFile = (): File => new File([new Uint8Array([1, 2, 3])], 'source-倒放.mp4', {
  type: 'video/mp4',
})

/** 建一个带 12 秒主轨片段的 store。 */
function makeStore() {
  const store = createEditorStore()
  store.getState().loadSource(SOURCE)
  return store
}

const clipIdOf = (store: ReturnType<typeof makeStore>): string =>
  store.getState().project.clips[0].id

beforeEach(() => {
  vi.mocked(reverseAssetSpan).mockReset()
  vi.mocked(readAssetFile).mockReset()
  vi.mocked(saveMediaBlob).mockReset()
  vi.mocked(deleteMediaBlob).mockReset()
  vi.mocked(saveMediaBlob).mockImplementation(async () => undefined)
  vi.mocked(deleteMediaBlob).mockImplementation(async () => undefined)
})

describe('倒放任务：完成时使用片段最新数据（B7）', () => {
  it('生成期间修改的关键帧会生效，不会被任务开始时的旧值镜像覆盖', async () => {
    const store = makeStore()
    const clipId = clipIdOf(store)
    store.getState().execute(
      createUpdateAnyClipCommand(
        clipId,
        {
          anim: {
            'position.x': [
              { t: 0, value: 0, ease: 'linear' },
              { t: 1, value: 1, ease: 'linear' },
            ],
          },
        },
        '初始关键帧',
      ),
    )

    const producing = deferred<File>()
    vi.mocked(reverseAssetSpan).mockReturnValue(producing.promise)
    vi.mocked(readAssetFile).mockResolvedValue(reversedAsset())
    store.getState().reverseClip(clipId)

    // 生成期间用户改关键帧（0/1 → 0.25/0.75）。
    store.getState().execute(
      createUpdateAnyClipCommand(
        clipId,
        {
          anim: {
            'position.x': [
              { t: 0, value: 0.25, ease: 'linear' },
              { t: 1, value: 0.75, ease: 'linear' },
            ],
          },
        },
        '改关键帧',
      ),
    )

    producing.resolve(videoFile())
    await vi.waitFor(() => expect(store.getState().reverseJob).toBeNull())

    const clip = store.getState().project.clips[0]
    expect(clip.sourceUrl).toBe(reversedAsset().url)
    // 用的是最新关键帧的镜像：末值在前。
    expect(clip.anim!['position.x']!.map((key) => key.value)).toEqual([0.75, 0.25])
  })
})

describe('倒放任务：晚到的结果不能写进工程（B8）', () => {
  it('拼接刚返回就被取消：直接丢弃，不读文件也不写库', async () => {
    const store = makeStore()
    const clipId = clipIdOf(store)
    const producing = deferred<File>()
    vi.mocked(reverseAssetSpan).mockReturnValue(producing.promise)
    vi.mocked(readAssetFile).mockResolvedValue(reversedAsset())

    store.getState().reverseClip(clipId)
    store.getState().cancelReverse()
    // 服务端不理会 signal（模拟「拼接已完成、结果在路上」）。
    producing.resolve(videoFile())

    await vi.waitFor(() => expect(store.getState().reverseJob).toBeNull())
    expect(vi.mocked(readAssetFile)).not.toHaveBeenCalled()
    expect(vi.mocked(saveMediaBlob)).not.toHaveBeenCalled()
    expect(store.getState().assets.some((asset) => asset.id === 'asset-new')).toBe(false)
    expect(store.getState().project.clips[0].sourceUrl).toBe(SOURCE.url)
  })
  it('拼接完成、保存到 IndexedDB 之后被取消：丢弃结果并删掉已写入的 blob', async () => {
    const store = makeStore()
    const clipId = clipIdOf(store)
    const producing = deferred<File>()
    vi.mocked(reverseAssetSpan).mockReturnValue(producing.promise)
    vi.mocked(readAssetFile).mockResolvedValue(reversedAsset())
    const saving = deferred<void>()
    vi.mocked(saveMediaBlob).mockReturnValue(saving.promise)

    store.getState().reverseClip(clipId)
    producing.resolve(videoFile())
    // 等到「已经写完 blob」的那一刻再取消。
    await vi.waitFor(() => expect(saveMediaBlob).toHaveBeenCalled())
    store.getState().cancelReverse()
    saving.resolve()

    await vi.waitFor(() => expect(store.getState().reverseJob).toBeNull())
    // 素材库与工程都没被改动。
    expect(store.getState().assets.some((asset) => asset.id === 'asset-new')).toBe(false)
    expect(store.getState().project.clips[0].sourceUrl).toBe(SOURCE.url)
    // 已经写入 IndexedDB 的 blob 被清理。
    expect(vi.mocked(deleteMediaBlob)).toHaveBeenCalledWith('asset-new')
  })

  it('生成期间切换工程：结果被丢弃，新工程不受影响', async () => {
    const store = makeStore()
    const clipId = clipIdOf(store)
    const producing = deferred<File>()
    vi.mocked(reverseAssetSpan).mockReturnValue(producing.promise)
    vi.mocked(readAssetFile).mockResolvedValue(reversedAsset())

    store.getState().reverseClip(clipId)
    // 切到另一个工程（loadSource 会分配新的 projectId）。
    store.getState().loadSource(OTHER)
    producing.resolve(videoFile())

    await vi.waitFor(() => expect(store.getState().reverseJob).toBeNull())
    // 新工程的素材库只有它自己的素材；片段仍然指向新工程的主素材。
    expect(store.getState().assets.map((asset) => asset.url)).toEqual([OTHER.url])
    expect(store.getState().project.clips[0].sourceUrl).toBe(OTHER.url)
    // 没有读取/保存任何倒放结果。
    expect(vi.mocked(readAssetFile)).not.toHaveBeenCalled()
    expect(vi.mocked(saveMediaBlob)).not.toHaveBeenCalled()
  })
})