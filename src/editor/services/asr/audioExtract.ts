import { mixToMono, resamplePcm, slicePcm } from '../../core/captions'
import {
  acquireRuntime,
  currentGeneration,
  execOnRuntime,
  isGenerationCurrent,
  RuntimeRestartedError,
} from '../ffmpegRuntime'
import type { MediaAsset } from '../../core/types'

/** Assets up to this length are decoded with Web Audio; longer ones are sliced
 *  by FFmpeg so we never decode a whole hour-long file into memory. */
const WEB_AUDIO_MAX_SECONDS = 60

function extensionFor(source: Pick<MediaAsset, 'name' | 'url'>): string {
  const name = (source.name || source.url || '').split('?')[0]
  const match = /\.([a-zA-Z0-9]{1,5})$/.exec(name)
  return match ? `.${match[1].toLowerCase()}` : '.mp4'
}

async function readBytes(source: MediaAsset): Promise<Uint8Array> {
  if (source.file) return new Uint8Array(await source.file.arrayBuffer())
  const response = await fetch(source.url)
  if (!response.ok) throw new Error(`无法读取素材「${source.name}」（HTTP ${response.status}）`)
  return new Uint8Array(await (await response.blob()).arrayBuffer())
}

async function extractWithWebAudio(
  source: MediaAsset,
  start: number,
  end: number,
): Promise<Float32Array> {
  const bytes = await readBytes(source)
  const Context =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  if (!Context) throw new Error('浏览器不支持 Web Audio。')
  const context = new Context()
  try {
    const arrayBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer
    const buffer = await context.decodeAudioData(arrayBuffer)
    const channels: Float32Array[] = []
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      channels.push(buffer.getChannelData(channel))
    }
    const mono = mixToMono(channels)
    const slice = slicePcm(mono, buffer.sampleRate, start, end)
    return resamplePcm(slice, buffer.sampleRate, 16000)
  } finally {
    void context.close().catch(() => undefined)
  }
}

function bytesToFloat32(data: Uint8Array): Float32Array {
  const pcm = new Float32Array(Math.floor(data.byteLength / 4))
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  for (let index = 0; index < pcm.length; index += 1) {
    pcm[index] = view.getFloat32(index * 4, true)
  }
  return pcm
}

let fileCounter = 0
/**
 * 已写入运行时 MEMFS 的源文件缓存。
 *
 * key 里带**实例代次**：运行时一旦重启（导出取消 / 超时 / 降级），旧 worker 的文件系统
 * 随实例一起销毁，旧缓存必须视为无效——否则会拿着一个不存在的文件名去 exec，
 * 得到一个「文件找不到」却看不出原因的失败。
 */
const writtenSources = new Map<string, { generation: number; file: string }>()

/** 丢掉上一代的缓存条目（文件已随旧 worker 消失，不需要 deleteFile）。 */
function pruneStaleGenerations(generation: number): void {
  for (const [key, entry] of writtenSources) {
    if (entry.generation !== generation) writtenSources.delete(key)
  }
}

async function extractWithFFmpeg(
  source: MediaAsset,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<Float32Array> {
  const runtime = await acquireRuntime({ signal })
  const ffmpeg = runtime.ffmpeg
  if (!isGenerationCurrent(runtime.generation)) {
    throw new RuntimeRestartedError(currentGeneration())
  }
  pruneStaleGenerations(runtime.generation)
  const cacheKey = `${runtime.generation}|${source.url}`
  let cached = writtenSources.get(cacheKey)
  if (!cached) {
    const bytes = await readBytes(source)
    fileCounter += 1
    const srcName = `asr-src-${fileCounter}${extensionFor(source)}`
    await ffmpeg.writeFile(srcName, bytes)
    cached = { generation: runtime.generation, file: srcName }
    writtenSources.set(cacheKey, cached)
  }
  fileCounter += 1
  const outName = `asr-out-${fileCounter}.pcm`
  try {
    const code = await execOnRuntime(runtime, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      start.toFixed(3),
      '-t',
      Math.max(0, end - start).toFixed(3),
      '-i',
      cached.file,
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      'f32le',
      outName,
    ], { signal })
    if (code !== 0) throw new Error(`FFmpeg 音频抽取失败（退出码 ${code}）。`)
    const data = await ffmpeg.readFile(outName)
    if (typeof data === 'string') throw new Error('FFmpeg 返回了文本而非 PCM 数据。')
    return bytesToFloat32(data)
  } finally {
    await ffmpeg.deleteFile(outName).catch(() => undefined)
  }
}

/** 释放所有已缓存到 FFmpeg 虚拟文件系统的源文件。 */
export async function cleanupExtractCache(): Promise<void> {
  const generation = currentGeneration()
  const entries = [...writtenSources.values()]
  writtenSources.clear()
  // 旧代次的文件已随 worker 销毁，deleteFile 只会打到死实例上 → 直接忽略。
  const live = entries.filter((entry) => entry.generation === generation)
  if (live.length === 0) return
  const runtime = await acquireRuntime().catch(() => null)
  if (!runtime) return
  for (const entry of live) {
    await runtime.ffmpeg.deleteFile(entry.file).catch(() => undefined)
  }
}

/** Extracts 16 kHz mono PCM for a source-time range [start, end]. */
export async function extractPcm16k(
  asset: MediaAsset,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<Float32Array> {
  const clamped = Math.max(0, start)
  const capped = Math.min(asset.duration > 0 ? asset.duration : end, end)
  if (capped <= clamped) return new Float32Array(0)
  const longAsset = asset.duration > 0 && asset.duration > WEB_AUDIO_MAX_SECONDS
  if (longAsset) return extractWithFFmpeg(asset, clamped, capped, signal)
  return extractWithWebAudio(asset, clamped, capped)
}