import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { createInitialProject } from '../src/editor/core/operations'
import type { MediaAsset, SourceInfo } from '../src/editor/core/types'
import type { RecognitionResult, RecognizeAssetsOptions } from '../src/editor/services/asr/transcribeAssets'
import type { TranscribeProvider } from '../src/editor/services/asr/types'

/**
 * 识别人声检测（VAD）失败时的降级回归。
 *
 * 真实场景：`public/vad/silero_vad.onnx` 没被部署（该目录是 .gitignore 的生成物）、
 * 或宿主 CSP 禁了 worker。修复前直接抛错 → 用户点「开始识别」只得到一句 ONNX 内部
 * 错误，智能字幕完全不可用。修复后必须：
 * 1. 降级为「固定 28s 切块识别」，仍然出字幕；
 * 2. 只提示一次「人声检测不可用」；
 * 3. **用户取消**（AbortError）不能被当成降级继续跑；
 * 4. 素材没有音轨时只跳过该素材，不整轮失败。
 *
 * VAD / 音频抽取都用 mock 隔离（真实实现依赖 worker / FFmpeg wasm）。
 */

const vad = vi.hoisted(() => ({
  mode: 'fail' as 'fail' | 'ok',
  calls: 0,
  abortOnRun: null as null | (() => void),
  aborted: false,
}))

function abortError(): Error {
  const error = new Error('已取消')
  error.name = 'AbortError'
  return error
}

vi.mock('../src/editor/services/asr/sileroVad', () => ({
  runSileroVad: async () => {
    vad.calls += 1
    // 模拟「VAD 正在跑的时候用户点了取消」：真实链路里 runSileroVad 会抛 AbortError。
    vad.abortOnRun?.()
    if (vad.aborted) throw abortError()
    if (vad.mode === 'fail') throw new Error('silero_vad.onnx 404')
    return { spans: [], maxProb: 0 }
  },
  vadUnavailableReason: () => (vad.mode === 'fail' ? '人声检测不可用' : null),
}))

const extract = vi.hoisted(() => ({
  fail: false,
  pcm: null as Float32Array | null,
}))

vi.mock('../src/editor/services/asr/audioExtract', () => ({
  extractPcm16k: async () => {
    if (extract.fail) throw new Error('没有音轨')
    return extract.pcm ?? new Float32Array(0)
  },
  cleanupExtractCache: async () => undefined,
}))

const SAMPLE_RATE = 16_000

/** 4 秒「有声音」的 PCM（440Hz 方波近似，保证 hasAudibleSignal 为真）。 */
function audiblePcm(seconds = 4): Float32Array {
  const pcm = new Float32Array(Math.round(seconds * SAMPLE_RATE))
  for (let index = 0; index < pcm.length; index += 1) {
    pcm[index] = index % 8 < 4 ? 0.4 : -0.4
  }
  return pcm
}

const SOURCE: SourceInfo = {
  url: 'blob:src',
  name: 'src.mp4',
  size: 1024,
  duration: 4,
  width: 0,
  height: 0,
  kind: 'video',
}

const ASSET: MediaAsset = { ...SOURCE, id: 'asset-1' }

function providerStub(): TranscribeProvider & { calls: number } {
  const provider = {
    id: 'stub-asr',
    label: '测试识别器',
    calls: 0,
    async transcribe() {
      provider.calls += 1
      return [{ text: '你好', start: 0, end: 0.4 }]
    },
  }
  return provider as unknown as TranscribeProvider & { calls: number }
}

type Module = typeof import('../src/editor/services/asr/transcribeAssets')

/** 每个测试用全新模块实例（asrCache 会缓存 databasePromise）+ 全新内存 IDB。 */
async function loadRecognition(): Promise<Module> {
  vi.resetModules()
  return import('../src/editor/services/asr/transcribeAssets')
}

function options(provider: TranscribeProvider, extra: Partial<RecognizeAssetsOptions> = {}): RecognizeAssetsOptions {
  return { language: 'zh', modelId: 'stub-model', provider, ...extra }
}

function progressDetails(events: { detail: string }[]): string[] {
  return events.map((event) => event.detail)
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  vad.mode = 'fail'
  vad.calls = 0
  vad.abortOnRun = null
  vad.aborted = false
  extract.fail = false
  extract.pcm = audiblePcm()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('recognizeAssets：VAD 不可用时降级', () => {
  it('仍然产出字幕（按固定 28s 切块），并只提示一次', async () => {
    const { recognizeAssets } = await loadRecognition()
    const provider = providerStub()
    const events: { detail: string }[] = []
    const result: RecognitionResult = await recognizeAssets(
      createInitialProject(SOURCE, 'clip-1'),
      [ASSET],
      SOURCE,
      options(provider, { onProgress: (progress) => events.push(progress) }),
    )

    const warnings = progressDetails(events).filter((detail) => detail.includes('人声检测不可用'))
    expect(warnings).toHaveLength(1)
    expect(result.wordsBySource['asset-1']?.map((word) => word.text)).toEqual(['你好'])
    expect(result.stats.whisperCalls).toBeGreaterThanOrEqual(1)
    // 降级不应把「人声检测」统计成有人声。
    expect(result.stats.speechSpans).toBe(0)
    expect(vad.calls).toBe(1)
  })

  it('第二次识别命中缓存（不再调 provider），也不会重复提示', async () => {
    const { recognizeAssets } = await loadRecognition()
    const provider = providerStub()
    const project = createInitialProject(SOURCE, 'clip-1')
    await recognizeAssets(project, [ASSET], SOURCE, options(provider))
    const callsAfterFirst = provider.calls

    const events: { detail: string }[] = []
    const second = await recognizeAssets(
      project,
      [ASSET],
      SOURCE,
      options(provider, { onProgress: (progress) => events.push(progress) }),
    )
    expect(provider.calls).toBe(callsAfterFirst)
    expect(second.stats.cacheHits).toBeGreaterThanOrEqual(1)
    expect(progressDetails(events).some((detail) => detail.includes('使用缓存'))).toBe(true)
  })

  it('VAD 正常时不出现降级提示', async () => {
    vad.mode = 'ok'
    const { recognizeAssets } = await loadRecognition()
    const provider = providerStub()
    const events: { detail: string }[] = []
    await recognizeAssets(
      createInitialProject(SOURCE, 'clip-1'),
      [ASSET],
      SOURCE,
      options(provider, { onProgress: (progress) => events.push(progress) }),
    )
    expect(progressDetails(events).some((detail) => detail.includes('人声检测不可用'))).toBe(false)
  })

  it('用户取消不能被吞成降级（AbortError 必须原样上抛）', async () => {
    const { recognizeAssets } = await loadRecognition()
    const provider = providerStub()
    const controller = new AbortController()
    // 模拟：VAD 正在跑的时候用户点了取消（真实实现随后抛 AbortError）。
    vad.abortOnRun = () => {
      vad.aborted = true
      controller.abort()
    }

    await expect(
      recognizeAssets(
        createInitialProject(SOURCE, 'clip-1'),
        [ASSET],
        SOURCE,
        options(provider, { signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    // 取消时绝不能继续调识别。
    expect(provider.calls).toBe(0)
  })

  it('素材没有音轨时只跳过该素材，不整轮失败', async () => {
    extract.fail = true
    const { recognizeAssets } = await loadRecognition()
    const provider = providerStub()
    const project = createInitialProject(SOURCE, 'clip-1')
    const result = await recognizeAssets(project, [ASSET], SOURCE, options(provider))
    expect(result.wordsBySource['asset-1']).toEqual([])
    expect(provider.calls).toBe(0)
    expect(result.stats.assetCount).toBe(1)
  })

  it('没有可识别素材时给出可读错误', async () => {
    const { recognizeAssets } = await loadRecognition()
    const emptyProject = { ...createInitialProject(SOURCE, 'clip-1'), clips: [] }
    await expect(
      recognizeAssets(emptyProject, [], null, options(providerStub())),
    ).rejects.toThrow(/没有可识别的素材/)
  })
})