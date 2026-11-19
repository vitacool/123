import {
  buildAsrCacheKey,
  type AsrLanguage,
  type AsrWord,
} from '../../core/asr'
import { cleanAsrWords } from '../../core/asrFilters'
import { buildSpeechBlocks } from '../../core/asrVad'
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
        pcm = await extractPcm16k(asset, interval.start, interval.end)
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
      const vad = await runSileroVad(pcm)
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
      const blocks = buildSpeechBlocks(vad.spans, intervalDuration, {
        padSeconds: 0.2,
        mergeGapSeconds: 2,
        maxBlockSeconds: 28,
      })
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
        await saveAsrWords(cacheKey, cleaned)
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
  await cleanupExtractCache()
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