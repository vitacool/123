import type { MediaAsset } from '../core/types'
import { readAssetBytes } from './animationRenderer'
import {
  canCleanup,
  execOnRuntime,
  isAbortError,
  isRuntimeRestarted,
  loadExecRuntimeHandle,
  retryOnRestartOnce,
} from './ffmpegRuntime'

export interface ReverseAudioOptions {
  signal?: AbortSignal
  onStatus?: (message: string) => void
}

/**
 * 生成整段倒放的音频资产（m4a/AAC）。
 *
 * 为什么整段而不是片段区间：整段倒放后只要把片段的源区间镜像（D-end … D-start），
 * 就能保留原有的裁剪/拖动/再次裁剪能力；只倒放当前区间会丢失区间外的素材。
 * 音频时长短、`areverse` 内存占用低，无需像视频那样分段。
 */
export async function reverseAudioAsset(
  asset: MediaAsset,
  options: ReverseAudioOptions = {},
): Promise<File> {
  return retryOnRestartOnce(() => reverseAudioAssetOnce(asset, options))
}

async function reverseAudioAssetOnce(
  asset: MediaAsset,
  options: ReverseAudioOptions,
): Promise<File> {
  if (asset.kind !== 'audio') throw new Error('只有音频素材支持音频倒放')
  const { signal, onStatus } = options
  const throwIfAborted = (): void => {
    if (!signal?.aborted) return
    const error = new Error('已取消倒放音频')
    error.name = 'AbortError'
    throw error
  }
  throwIfAborted()
  onStatus?.('正在加载 FFmpeg 核心…')
  const runtime = await loadExecRuntimeHandle()
  const ffmpeg = runtime.ffmpeg
  const bytes = await readAssetBytes(asset)
  if (!bytes || bytes.byteLength === 0) throw new Error('无法读取音频文件，倒放失败')

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const inputFile = `ra-input-${stamp}${/\.[a-z0-9]{1,5}$/i.exec(asset.name)?.[0] ?? '.mp3'}`
  const outputFile = `ra-output-${stamp}.m4a`
  try {
    onStatus?.('正在写入音频…')
    await ffmpeg.writeFile(inputFile, bytes)
    throwIfAborted()
    onStatus?.('正在倒放音频…')
    let code: number
    try {
      code = await execOnRuntime(
        runtime,
        [
          '-hide_banner',
          '-y',
          '-i',
          inputFile,
          '-vn',
          '-af',
          'areverse',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-movflags',
          '+faststart',
          outputFile,
        ],
        { signal },
      )
    } catch (error) {
      if (isAbortError(error) || isRuntimeRestarted(error)) throw error
      code = -1
    }
    if (code !== 0) throw new Error('音频倒放失败（FFmpeg 退出码非零）')
    throwIfAborted()
    onStatus?.('正在读取倒放音频…')
    const data = await ffmpeg.readFile(outputFile)
    if (typeof data === 'string' || data.byteLength === 0) {
      throw new Error('倒放音频输出为空')
    }
    const copy = new Uint8Array(data.byteLength)
    copy.set(data)
    const base = asset.name.replace(/\.[^.]+$/, '')
    return new File([copy.buffer], `${base || 'audio'}-reversed.m4a`, {
      type: 'audio/mp4',
    })
  } finally {
    if (canCleanup(runtime.generation)) {
      for (const file of [inputFile, outputFile]) {
        try {
          await ffmpeg.deleteFile(file)
        } catch {
          // 清理尽力而为。
        }
      }
    }
  }
}