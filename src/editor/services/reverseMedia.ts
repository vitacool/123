import {
  REVERSE_CONCAT_FILE,
  REVERSE_OUTPUT_FILE,
  buildReverseChunkArgs,
  buildReverseConcatArgs,
  buildReverseConcatList,
  reverseAssetFileName,
  reverseChunkFile,
  reverseChunks,
  reverseOrder,
  reverseScalePlan,
} from '../core/reverse'
import type { MediaAsset } from '../core/types'
import { readAssetBytes } from './animationRenderer'
import {
  canCleanup,
  execOnRuntime,
  isAbortError,
  isRuntimeRestarted,
  loadExecRuntimeHandle,
  retryOnRestartOnce,
  type RuntimeHandle,
} from './ffmpegRuntime'

/**
 * 生成倒放素材：对素材的源区间逐段 reverse / areverse，再按逆序拼成新的 MP4。
 *
 * 内存策略（核心取舍）：`reverse` 会把一整段帧缓存在内存里，整段倒放几乎必然 OOM。
 * 所以按约 2 秒分段，每段只驻留 2 秒的帧；再先把每段缩到长边 ≤1080（4K 单帧约
 * 12MB，1080p 约 3MB），把峰值从 GB 级压到数百 MB。代价是倒放素材分辨率上限
 * 1080p——它只是新素材，导出分辨率仍由工程设置决定。
 */

export interface ReverseMediaOptions {
  asset: MediaAsset
  /** 源区间（秒，素材时间）。 */
  sourceStart: number
  sourceEnd: number
  /** 取消信号：只在分段之间检查（每段约 2 秒），不会中断正在执行的那一段。 */
  signal?: AbortSignal
  /** 整体进度 0–100。 */
  onProgress?: (progress: number) => void
  onStatus?: (message: string) => void
  /** 需要用户知晓的降级（例如音频倒放失败、改为无声倒放）。 */
  onWarning?: (message: string) => void
}

const createAbortError = (): Error => {
  const error = new Error('已取消倒放')
  error.name = 'AbortError'
  return error
}

export function isReverseAbort(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError'
  )
}

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw createAbortError()
}

/** 用 `-i` 的日志判断素材是否有音轨（video 素材的 hasAudio 经常未知）。 */
async function probeHasAudio(
  runtime: RuntimeHandle,
  inputFile: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const ffmpeg = runtime.ffmpeg
  const lines: string[] = []
  const onLog = ({ message }: { message: string }) => lines.push(message)
  ffmpeg.on('log', onLog)
  try {
    await execOnRuntime(runtime, ['-hide_banner', '-i', inputFile], { signal })
  } catch {
    // -i 只在探测流信息，非零退出是正常的。
  } finally {
    ffmpeg.off('log', onLog)
  }
  const text = lines.join('\n')
  if (/Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: Audio:/.test(text)) return true
  if (/Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: Video:/.test(text)) return false
  // 日志拿不到只能按「有音频」猜；分段命令里音频映射是可选的（0:a:0?），
  // 真没有音轨时那一段会失败，调用方会换成无声参数重试。
  return true
}

/**
 * 生成倒放素材文件。成功返回一个新的 MP4（File）；取消抛 `name === 'AbortError'`
 * 的错误；其它失败抛带可读原因的 Error。**不会改动工程**（工程改动由调用方用
 * EditorCommand 完成），也不会留下 FFmpeg 虚拟文件系统里的临时文件。
 */
export async function reverseAssetSpan(options: ReverseMediaOptions): Promise<File> {
  // 运行时要是在中途被重启（导出取消 / 超时都会重启共享实例），整个流程重做一次：
  // 文件型流程只重试单次 exec 会「文件不存在」。
  return retryOnRestartOnce(() => reverseAssetSpanOnce(options))
}

async function reverseAssetSpanOnce(options: ReverseMediaOptions): Promise<File> {
  const { asset, signal, onProgress, onStatus, onWarning } = options
  const chunks = reverseChunks(options.sourceStart, options.sourceEnd)
  if (chunks.length === 0) throw new Error('片段太短，无法倒放')

  onStatus?.('正在加载 FFmpeg 核心…')
  throwIfAborted(signal)
  const runtime = await loadExecRuntimeHandle()
  const ffmpeg = runtime.ffmpeg
  /** 执行一次命令；只有「退出码非零」当失败处理，取消/重启必须原样上抛。 */
  const runExec = async (args: string[]): Promise<number> => {
    try {
      return await execOnRuntime(runtime, args, { signal })
    } catch (error) {
      if (isAbortError(error) || isRuntimeRestarted(error)) throw error
      return -1
    }
  }
  throwIfAborted(signal)

  const bytes = await readAssetBytes(asset)
  if (!bytes || bytes.byteLength === 0) throw new Error('无法读取素材文件，倒放失败')

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const inputFile = `rev-input-${stamp}${/\.[a-z0-9]{1,5}$/i.exec(asset.name)?.[0] ?? '.mp4'}`
  const chunkFiles = chunks.map((_, index) => `${stamp}-${reverseChunkFile(index)}`)
  const concatFile = `${stamp}-${REVERSE_CONCAT_FILE}`
  const outputFile = `${stamp}-${REVERSE_OUTPUT_FILE}`
  const logs: string[] = []
  const onLog = ({ message }: { message: string }) => {
    logs.push(message)
    if (logs.length > 120) logs.shift()
  }
  let currentChunk = 0
  let chunkProgress = 0
  /** 分段占 0–95%，拼接占剩余 5%。 */
  const reportProgress = (): void => {
    const chunkShare = 95 / chunks.length
    const overall = currentChunk * chunkShare + chunkProgress * chunkShare
    onProgress?.(Math.max(0, Math.min(95, overall)))
  }
  const onProgressEvent = ({ progress }: { progress: number }) => {
    if (!Number.isFinite(progress)) return
    chunkProgress = Math.max(0, Math.min(1, progress))
    reportProgress()
  }

  ffmpeg.on('log', onLog)
  ffmpeg.on('progress', onProgressEvent)
  try {
    onStatus?.('正在写入素材…')
    await ffmpeg.writeFile(inputFile, bytes)
    throwIfAborted(signal)

    const withAudio = asset.hasAudio === false ? false : await probeHasAudio(runtime, inputFile, signal)
    throwIfAborted(signal)

    const scale = reverseScalePlan(asset.width, asset.height)
    onStatus?.(
      `正在倒放 ${chunks.length} 段（${scale.width}×${scale.height}，每段约 ${
        chunks[0]?.duration.toFixed(1) ?? '2'
      } 秒）…`,
    )
    /**
     * 逐个分段倒放；失败时抛错（由调用方决定是「整体退回无声重做」还是放弃）。
     * 注意不能只把失败的那一段改成无声：那样前面的段有音轨、后面的段没有，
     * 拼接后会音画不同步。
     */
    const runChunkPass = async (withAudioChunk: boolean): Promise<string[]> => {
      const out: string[] = []
      for (let index = 0; index < chunks.length; index += 1) {
        throwIfAborted(signal)
        currentChunk = index
        chunkProgress = 0
        reportProgress()
        onStatus?.(`正在倒放第 ${index + 1}/${chunks.length} 段…`)
        const chunk = chunks[index]
        const code = await runExec(
          buildReverseChunkArgs({
            inputFile,
            outputFile: chunkFiles[index],
            start: chunk.start,
            duration: chunk.duration,
            scaleFilter: scale.filter,
            withAudio: withAudioChunk,
          }),
        )
        if (code !== 0) {
          const tail = logs.slice(-3).join(' | ')
          throw new Error(`第 ${index + 1} 段倒放失败${tail ? `（${tail}）` : ''}`)
        }
        out.push(chunkFiles[index])
      }
      return out
    }

    let produced: string[]
    if (withAudio) {
      try {
        produced = await runChunkPass(true)
      } catch (error) {
        // 取消不能被当成「音频失败」而重试。
        if (isReverseAbort(error)) throw error
        // 音频链在这个核心里不可用：丢弃已生成的分段，从头按无声重做，保证音画一致。
        onWarning?.('音频倒放失败，已生成无声倒放')
        onStatus?.('音频倒放失败，正在改用无声倒放重做…')
        currentChunk = 0
        chunkProgress = 0
        reportProgress()
        for (const file of chunkFiles) {
          await ffmpeg.deleteFile(file).catch(() => undefined)
        }
        produced = await runChunkPass(false)
      }
    } else {
      produced = await runChunkPass(false)
    }

    throwIfAborted(signal)
    currentChunk = chunks.length
    chunkProgress = 0
    onProgress?.(95)
    onStatus?.('正在拼接倒放片段…')
    // 段内已反向，段序再反向 → 整段反向。
    const ordered = reverseOrder(produced.length).map((index) => produced[index])
    const list = buildReverseConcatList(ordered)
    await ffmpeg.writeFile(concatFile, list)
    let concatCode = await runExec(
      buildReverseConcatArgs({ listFile: concatFile, outputFile }),
    )
    if (concatCode !== 0) {
      // 个别容器参数不一致时「-c copy」拼接会失败：退一步重编码拼一次。
      onStatus?.('正在重新拼接倒放片段…')
      concatCode = await runExec(
        buildReverseConcatArgs({ listFile: concatFile, outputFile, reencode: true }),
      )
    }
    if (concatCode !== 0) {
      const tail = logs.slice(-3).join(' | ')
      throw new Error(`倒放片段的拼接失败${tail ? `（${tail}）` : ''}`)
    }
    onStatus?.('正在读取倒放素材…')
    const data = await ffmpeg.readFile(outputFile)
    if (typeof data === 'string' || data.byteLength === 0) {
      throw new Error('倒放素材输出为空')
    }
    const copy = new Uint8Array(data.byteLength)
    copy.set(data)
    onProgress?.(100)
    return new File([copy.buffer], reverseAssetFileName(asset.name), { type: 'video/mp4' })
  } finally {
    ffmpeg.off('log', onLog)
    ffmpeg.off('progress', onProgressEvent)
    // 运行时被重启后旧 MEMFS 已随 worker 销毁，deleteFile 只会打到死实例上。
    const files = canCleanup(runtime.generation) ? [inputFile, concatFile, outputFile, ...chunkFiles] : []
    for (const file of files) {
      try {
        await ffmpeg.deleteFile(file)
      } catch {
        // 清理尽力而为；文件可能已被删除。
      }
    }
  }
}