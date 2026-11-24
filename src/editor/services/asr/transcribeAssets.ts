import {
  buildAsrCacheKey,
  type AsrLanguage,
  type AsrScript,
  type AsrWord,
} from '../../core/asr'
import { cleanAsrWords } from '../../core/asrFilters'
import { buildSpeechBlocks, snapSpeechBlockBoundaries } from '../../core/asrVad'
import { audioRms, hasAudibleSignal } from '../../core/captions'
import { mergeSourceIntervals } from '../../core/asrIntervals'
import {
  mapWordsToTimeline,
  type TimelineWord,
  type WordsBySource,
} from '../../core/captionMapping'
import { getOverlayTracks, getTimeline } from '../../core/timeline'
import { isAudioTrackActive, isMainAudioActive } from '../../core/tracks'
import type { MediaAsset, Project, SourceInfo } from '../../core/types'
import { loadAsrWords, saveAsrWords } from './asrCache'
import { cleanupExtractCache, extractPcm16k } from './audioExtract'
import { runSileroVad } from './sileroVad'
import type { TranscribeProvider } from './types'

const GAP_TOLERANCE_SECONDS = 1
const PAD_SECONDS = 0.5

export type AssetStage = 'prepare' | 'extract' | 'vad' | 'transcribe' | 'cache' | 'done'

export interface AssetProgress {
  assetIndex: number
  assetCount: number
  stage: AssetStage
  /** Overall progress in [0, 100]. */
  percent: number
  detail: string
  /** True when this asset came straight from IndexedDB. */
  fromCache?: boolean
}

export interface RecognizeAssetsOptions {
  language: AsrLanguage
  /** 输出字形；缺省 simplified（保持历史行为）。 */
  script?: AsrScript
  modelId: string
  provider: TranscribeProvider
  /** Overlay-track audio recognition; defaults to off. */
  includeOverlay?: boolean
  /** Audio-track (voiceover) recognition; defaults to on. */
  includeAudio?: boolean
  /** When set, only this main-track clip is recognised (识别范围：仅选中片段). */
  clipId?: string | null
  signal?: AbortSignal
  onProgress?: (progress: AssetProgress) => void
}

export interface RecognitionStats {
  assetCount: number
  skippedAssets: number
  speechSpans: number
  whisperCalls: number
  cacheHits: number
  vadMaxProb: number
  /** 最大 RMS（音量），用于判断「静音 / 有声但无人声 / 有人声」。 */
  audioRms: number
}

export interface RecognitionResult {
  wordsBySource: WordsBySource
  timelineWords: TimelineWord[]
  cachedIntervalCount: number
  transcribedIntervalCount: number
  stats: RecognitionStats
}

interface Slice {
  start: number
  end: number
}

interface AssetPlan {
  asset: MediaAsset
  intervals: Slice[]
}

function addSlice(map: Map<string, Slice[]>, url: string, start: number, end: number): void {
  if (end <= start) return
  const list = map.get(url)
  if (list) list.push({ start, end })
  else map.set(url, [{ start, end }])
}

function collectSlices(
  project: Project,
  includeOverlay: boolean,
  includeAudio: boolean,
  clipId?: string | null,
): Map<string, Slice[]> {
  const slices = new Map<string, Slice[]>()

  if (isMainAudioActive(project)) {
    for (const segment of getTimeline(project.clips)) {
      const clip = segment.clip
      if (clip.type === 'freeze') continue
      if (clipId && clip.id !== clipId) continue
      addSlice(slices, clip.sourceUrl, clip.sourceStart, clip.sourceEnd)
    }
  }

  if (includeOverlay) {
    for (const track of getOverlayTracks(project)) {
      for (const segment of getTimeline(track.clips)) {
        const clip = segment.clip
        if (clip.type === 'freeze') continue
        addSlice(slices, clip.sourceUrl, clip.sourceStart, clip.sourceEnd)
      }
    }
  }

  if (includeAudio) {
    for (const track of project.audioTracks ?? []) {
      if (!isAudioTrackActive(project, track)) continue
      for (const clip of track.clips) {
        addSlice(slices, clip.sourceUrl, clip.sourceStart, clip.sourceEnd)
      }
    }
  }

  return slices
}

function resolveAssets(
  slices: Map<string, Slice[]>,
  assets: MediaAsset[],
  source: SourceInfo | null,
): { plans: AssetPlan[]; skippedAssets: number } {
  const byUrl = new Map(assets.map((asset) => [asset.url, asset]))
  const plans: AssetPlan[] = []
  let skippedAssets = 0
  for (const [url, intervals] of slices) {
    let asset = byUrl.get(url)
    if (!asset && source?.url === url) {
      asset = { ...source, id: `source:${url}` } as MediaAsset
    }
    if (!asset) {
      skippedAssets += 1
      continue
    }
    plans.push({ asset, intervals })
  }
  return { plans, skippedAssets }
}

function progressPercent(assetIndex: number, assetCount: number, within: number): number {
  if (assetCount <= 0) return 0
  return ((assetIndex + within) / assetCount) * 100
}

/** 人声检测结果；不可用时退化为「没有 spans」，由下面的固定 28s 切块兜底。 */
interface SpeechDetection {
  spans: { start: number; end: number }[]
  maxProb: number
}

/** 只提示一次「VAD 不可用」，避免每个素材刷一条。 */
let vadFallbackNoticed = false

/**
 * 跑 Silero VAD，失败时**降级**而不是整轮失败。
 *
 * 真实场景：`public/vad/silero_vad.onnx` 没有被部署（该目录是 .gitignore 的生成物，
 * 但仓库里并没有生成它的脚本）、或宿主 CSP 禁了 worker。此时若直接抛错，用户
 * 点「开始识别」只会得到一句 ONNX 内部错误、字幕功能完全不可用。
 * 降级后仍能按有声信号做 28s 切块识别，只是少了「按人声切块」的精度。
 */
async function detectSpeech(
  pcm: Float32Array,
  context: {
    signal?: AbortSignal
    assetIndex: number
    assetCount: number
    within: number
    onProgress?: (progress: AssetProgress) => void
  },
): Promise<SpeechDetection> {
  try {
    return await runSileroVad(pcm, context.signal)
  } catch (error) {
    /**
     * 取消必须上抛成 AbortError：既不能让「用户取消」变成「降级继续跑」，
     * 也不能把与取消无关的底层错误（如 ONNX 模型 404）抛给用户 ——
     * 用户按下取消后应该看到「已取消」，而不是「识别失败：silero_vad.onnx 404」。
     *
     * VAD 失败与 abort 可能同时发生（404 先于取消到达），这里以 abort 为准：
     * 只有 abort 时把「不是 AbortError 的底层错误」换成 AbortError。
     */
    if (context.signal?.aborted) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      throw new DOMException('已取消', 'AbortError')
    }
    if (!vadFallbackNoticed) {
      vadFallbackNoticed = true
      console.warn('[asr] 人声检测不可用，改用固定 28s 切块识别：', error)
    }
    context.onProgress?.({
      assetIndex: context.assetIndex,
      assetCount: context.assetCount,
      stage: 'vad',
      percent: progressPercent(context.assetIndex - 1, context.assetCount, context.within),
      detail: '人声检测不可用，改为按固定 28s 切块识别',
    })
    return { spans: [], maxProb: 0 }
  }
}

/**
 * Recognises speech per source asset (not per clip): overlapping/nearby source
 * ranges are merged into one interval, transcribed once, and cached to
 * IndexedDB. Word timestamps stay in source time; the caller maps them onto the
 * timeline with `mapWordsToTimeline` — even after clips are reordered.
 */
export async function recognizeAssets(
  project: Project,
  assets: MediaAsset[],
  source: SourceInfo | null,
  options: RecognizeAssetsOptions,
): Promise<RecognitionResult> {
  try {
    return await runRecognition(project, assets, source, options)
  } finally {
    // 成功 / 失败 / 取消都要清理：抽取缓存把源文件写进了共享 MEMFS，
    // 不清理会一直占着运行时的文件系统。旧实例已死时 deleteFile 会失败，忽略即可。
    await cleanupExtractCache().catch(() => undefined)
  }
}

async function runRecognition(
  project: Project,
  assets: MediaAsset[],
  source: SourceInfo | null,
  options: RecognizeAssetsOptions,
): Promise<RecognitionResult> {
  const { signal } = options
  if (signal?.aborted) throw new DOMException('已取消', 'AbortError')

  const slices = collectSlices(
    project,
    options.includeOverlay ?? false,
    options.includeAudio ?? true,
    options.clipId ?? null,
  )
  if (slices.size === 0) {
    throw new Error('没有可识别的素材；请确认主轨/配音轨已启用且未静音。')
  }
  const { plans, skippedAssets } = resolveAssets(slices, assets, source)
  const assetCount = plans.length

  const wordsBySource: WordsBySource = {}
  let cachedIntervalCount = 0
  let transcribedIntervalCount = 0
  let speechSpans = 0
  let whisperCalls = 0
  let cacheHits = 0
  let vadMaxProb = 0
  let maxAudioRms = 0

  for (let assetIndex = 0; assetIndex < plans.length; assetIndex += 1) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
    const { asset, intervals: slicesForAsset } = plans[assetIndex]
    const merged = mergeSourceIntervals(slicesForAsset, {
      gapToleranceSeconds: GAP_TOLERANCE_SECONDS,
      padSeconds: PAD_SECONDS,
    }).map((interval) => ({
      start: Math.max(0, interval.start),
      end: asset.duration > 0 ? Math.min(asset.duration, interval.end) : interval.end,
    }))

    const wordsForSource: AsrWord[] = []
    options.onProgress?.({
      assetIndex: assetIndex + 1,
      assetCount,
      stage: 'prepare',
      percent: progressPercent(assetIndex, assetCount, 0),
      detail: `素材 ${assetIndex + 1}/${assetCount}「${asset.name}」`,
    })

    for (let intervalIndex = 0; intervalIndex < merged.length; intervalIndex += 1) {
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
      const interval = merged[intervalIndex]
      const within = intervalIndex / Math.max(1, merged.length)
      const cacheKey = buildAsrCacheKey({
        assetId: asset.id,
        start: interval.start,
        end: interval.end,
        providerId: options.provider.id,
        language: options.language,
        variant: options.script ?? 'simplified',
      })

      const cached = await loadAsrWords(cacheKey)
      if (cached && cached.length > 0) {
        cachedIntervalCount += 1
        cacheHits += 1
        wordsForSource.push(...cached)
        options.onProgress?.({
          assetIndex: assetIndex + 1,
          assetCount,
          stage: 'cache',
          percent: progressPercent(assetIndex, assetCount, within),
          detail: `素材 ${assetIndex + 1}/${assetCount} 使用缓存`,
          fromCache: true,
        })
        continue
      }

      options.onProgress?.({
        assetIndex: assetIndex + 1,
        assetCount,
        stage: 'extract',
        percent: progressPercent(assetIndex, assetCount, within),
        detail: `素材 ${assetIndex + 1}/${assetCount} 提取音轨`,
      })
      let pcm: Float32Array
      try {
        pcm = await extractPcm16k(asset, interval.start, interval.end, signal)
      } catch {
        // 素材无音轨/抽取失败：只跳过这一个素材，不整次失败。
        options.onProgress?.({
          assetIndex: assetIndex + 1,
          assetCount,
          stage: 'extract',
          percent: progressPercent(assetIndex, assetCount, 1),
          detail: `素材 ${assetIndex + 1}/${assetCount} 无音轨，已跳过`,
        })
        break
      }
      const rms = audioRms(pcm)
      if (rms > maxAudioRms) maxAudioRms = rms
      options.onProgress?.({
        assetIndex: assetIndex + 1,
        assetCount,
        stage: 'vad',
        percent: progressPercent(assetIndex, assetCount, within + 0.4 / Math.max(1, merged.length)),
        detail: `素材 ${assetIndex + 1}/${assetCount} 检测人声`,
      })
      const vad = await detectSpeech(pcm, {
        signal,
        assetIndex: assetIndex + 1,
        assetCount,
        within,
        onProgress: options.onProgress,
      })
      if (vad.maxProb > vadMaxProb) vadMaxProb = vad.maxProb

      const spanWords: AsrWord[] = []

      const transcribeChunk = async (
        chunk: Float32Array,
        baseSeconds: number,
        partIndex: number,
        partCount: number,
      ): Promise<void> => {
        if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
        whisperCalls += 1
        options.onProgress?.({
          assetIndex: assetIndex + 1,
          assetCount,
          stage: 'transcribe',
          percent: progressPercent(
            assetIndex,
            assetCount,
            within + (0.4 + (0.6 * partIndex) / Math.max(1, partCount)) / Math.max(1, merged.length),
          ),
          detail: `素材 ${assetIndex + 1}/${assetCount} 识别语音 ${partIndex + 1}/${partCount}`,
        })
        const words = await options.provider.transcribe(chunk, {
          language: options.language,
          script: options.script ?? 'simplified',
          signal,
        })
        for (const word of words) {
          spanWords.push({
            ...word,
            start: word.start + baseSeconds + interval.start,
            end: word.end + baseSeconds + interval.start,
          })
        }
      }

      // 按 VAD 人声块分别转录：以每块起点为时间基准，避免把包含长静音的整段
      // 一次性送 Whisper 导致词级时间戳被压缩到开头（字幕堆在 0 秒）。
      const intervalDuration = pcm.length / 16000
      // 算术切分（maxBlock=28s）常把词切两半：把切点挪到最近的低能量（停顿）处。
      const blocks = snapSpeechBlockBoundaries(
        buildSpeechBlocks(vad.spans, intervalDuration, {
          padSeconds: 0.2,
          mergeGapSeconds: 2,
          maxBlockSeconds: 28,
        }),
        pcm,
      )
      if (blocks.length > 0) {
        for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
          const block = blocks[blockIndex]
          const fromSample = Math.floor(block.start * 16000)
          const toSample = Math.min(pcm.length, Math.ceil(block.end * 16000))
          if (toSample - fromSample < 160) continue
          const chunk = pcm.slice(fromSample, toSample)
          await transcribeChunk(chunk, block.start, blockIndex, blocks.length)
        }
      } else if (vad.spans.length > 0 || hasAudibleSignal(pcm)) {
        // 兜底：VAD 没给出可用块但音频明显有信号，整段按 28s 切块。
        const CHUNK_SECONDS = 28
        const chunkSamples = CHUNK_SECONDS * 16000
        const parts = Math.max(1, Math.ceil(pcm.length / chunkSamples))
        let partIndex = 0
        for (let offset = 0; offset < pcm.length; offset += chunkSamples) {
          const chunk = pcm.slice(offset, Math.min(pcm.length, offset + chunkSamples))
          await transcribeChunk(chunk, offset / 16000, partIndex, parts)
          partIndex += 1
        }
      }
      speechSpans += vad.spans.length

      const cleaned = cleanAsrWords(spanWords).sort(
        (left, right) => left.start - right.start || left.end - right.end,
      )
      if (cleaned.length > 0) {
        try {
          await saveAsrWords(cacheKey, cleaned)
        } catch (error) {
          // 配额满 / 隐私模式禁 IndexedDB：缓存写失败不该让已经算完的结果作废。
          console.warn('[asr] 写入识别缓存失败，本次结果照常使用：', error)
        }
      }
      transcribedIntervalCount += 1
      wordsForSource.push(...cleaned)
    }

    wordsBySource[asset.id] = wordsForSource.sort(
      (left, right) => left.start - right.start || left.end - right.end,
    )
  }

  options.onProgress?.({
    assetIndex: assetCount,
    assetCount,
    stage: 'done',
    percent: 100,
    detail: '识别完成',
  })

  const urlToAssetId = new Map(assets.map((asset) => [asset.url, asset.id]))
  return {
    wordsBySource,
    timelineWords: mapWordsToTimeline(
      project,
      wordsBySource,
      {
        includeMainAudio: true,
        includeOverlay: options.includeOverlay ?? false,
        includeAudio: options.includeAudio ?? true,
      },
      urlToAssetId,
    ),
    cachedIntervalCount,
    transcribedIntervalCount,
    stats: {
      assetCount,
      skippedAssets,
      speechSpans,
      whisperCalls,
      cacheHits,
      vadMaxProb,
      audioRms: maxAudioRms,
    },
  }
}

/** Remaps previously recognised source words onto the current timeline. */
export function realign(
  project: Project,
  wordsBySource: WordsBySource,
  urlToAssetId?: Map<string, string>,
): TimelineWord[] {
  return mapWordsToTimeline(project, wordsBySource, { includeOverlay: false, includeAudio: true }, urlToAssetId)
}