import {
  acquireRuntime,
  canCleanup,
  execOnRuntime,
  retryOnRestartOnce,
} from './ffmpegRuntime'

export interface TranscodeCallbacks {
  onProgress?: (progress: number) => void
  onStatus?: (message: string) => void
  /** 取消转码：立刻终止共享运行时（wasm exec 只能这样打断）。 */
  signal?: AbortSignal
}

const TRANSCODE_CRF = 22

function outputNameFor(file: File): string {
  const base = file.name.replace(/\.[^.]+$/, '')
  return `${base || 'video'}-h264.mp4`
}

/**
 * Browser codecs do not include HEVC/H.265 on most Windows installs. This
 * converts a local file to an H.264/AAC MP4 proxy using the bundled FFmpeg
 * wasm core, so the editor can decode, seek and export it.
 */
export async function transcodeToH264(
  file: File,
  callbacks: TranscodeCallbacks = {},
): Promise<File> {
  // 运行时可能在转码途中被重启（导出取消/超时都会重启共享实例）：整流程重做一次。
  return retryOnRestartOnce(() => transcodeOnce(file, callbacks))
}

async function transcodeOnce(
  file: File,
  callbacks: TranscodeCallbacks,
): Promise<File> {
  callbacks.onStatus?.('正在加载转码器…')
  const runtime = await acquireRuntime({ signal: callbacks.signal })
  const ffmpeg = runtime.ffmpeg
  const inputName = `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${file.name.split('.').pop() || 'mp4'}`
  const outputName = `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`
  const onProgress = ({ progress }: { progress: number }) => {
    if (Number.isFinite(progress)) {
      callbacks.onProgress?.(Math.max(0, Math.min(99, progress * 100)))
    }
  }
  let lastLogAt = 0
  const onLog = ({ message }: { message: string }) => {
    const now = Date.now()
    const time = message.match(/time=(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/)?.[1]
    if (time && now - lastLogAt > 500) {
      lastLogAt = now
      callbacks.onStatus?.(`正在转码 H.264 MP4… ${time}`)
    }
  }
  ffmpeg.on('progress', onProgress)
  ffmpeg.on('log', onLog)
  const logs: string[] = []
  const onTranscodeLog = ({ message }: { message: string }) => logs.push(message)
  ffmpeg.on('log', onTranscodeLog)
  try {
    await ffmpeg.writeFile(inputName, new Uint8Array(await file.arrayBuffer()))
    callbacks.onStatus?.('正在转码为 H.264 MP4…')
    await execOnRuntime(runtime, [
      '-threads', '1',
      '-i', inputName,
      '-threads', '1',
      '-filter_threads', '1',
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-x264-params', 'threads=1',
      '-crf', String(TRANSCODE_CRF),
      '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:a', 'aac',
      '-b:a', '160k',
      '-ac', '2',
      '-movflags', '+faststart',
      '-max_muxing_queue_size', '1024',
      outputName,
    ], { signal: callbacks.signal })
    callbacks.onProgress?.(100)
    const data = await ffmpeg.readFile(outputName)
    if (typeof data === 'string') throw new Error('转码输出为空')
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    const buffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(buffer).set(bytes)
    return new File([buffer], outputNameFor(file), {
      type: 'video/mp4',
      lastModified: file.lastModified,
    })
  } catch (error) {
    const tail = logs.slice(-4).join(' | ')
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${tail ? `（${tail}）` : ''}`,
    )
  } finally {
    ffmpeg.off('progress', onProgress)
    ffmpeg.off('log', onLog)
    ffmpeg.off('log', onTranscodeLog)
    // 运行时被重启后旧 MEMFS 已随 worker 销毁：跳过对死实例的删除。
    if (canCleanup(runtime.generation)) {
      await ffmpeg.deleteFile(inputName).catch(() => undefined)
      await ffmpeg.deleteFile(outputName).catch(() => undefined)
    }
  }
}