import type { FFmpeg } from '@ffmpeg/ffmpeg'
import { backgroundCssColor, clipBackground } from '../core/background'
import { clipFreezeFrame, clipSpanSourceAt, clipTimelineDuration } from '../core/clipTime'
import { drawClipFrame } from '../core/clipRender'
import { resolveClipOverrides } from '../core/animation'
import { animationFrameCount } from '../core/animationExport'
import type { Clip, Project, SourceInfo } from '../core/types'

export interface RenderAnimatedClipOptions {
  clip: Clip
  asset: SourceInfo
  /** 片段所在的层：主轨 null；叠加轨为轨道 id（仅用于命名与背景烘焙策略）。 */
  trackId: string | null
  project: Project
  width: number
  height: number
  fps: number
  /** 该片段在本次渲染中的序号（从 0 开始），用于文件名。 */
  index: number
  ffmpeg: FFmpeg
  signal: AbortSignal | null
  /** 每渲染完一帧回调一次（done, total）。 */
  onFrame?: (done: number, total: number) => void
}

const throwIfAborted = (signal: AbortSignal | null): void => {
  if (signal?.aborted) {
    const error = new Error('导出已取消')
    error.name = 'AbortError'
    throw error
  }
}

const waitForEvent = (
  target: HTMLVideoElement | HTMLImageElement,
  event: string,
  timeoutMs: number,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error(`等待 ${event} 超时`))
    }, timeoutMs)
    const done = () => {
      cleanup()
      resolve()
    }
    const fail = () => {
      cleanup()
      reject(new Error('素材解码失败'))
    }
    const cleanup = () => {
      window.clearTimeout(timer)
      target.removeEventListener(event, done)
      target.removeEventListener('error', fail)
    }
    target.addEventListener(event, done, { once: true })
    target.addEventListener('error', fail, { once: true })
  })

/** 打开一个可用于逐帧绘制的画面源（视频元素或已解码图片）。 */
async function openSource(
  asset: SourceInfo,
): Promise<{ draw: CanvasImageSource; width: number; height: number; seek: ((time: number) => Promise<void>) | null; dispose: () => void }> {
  if (asset.kind === 'image') {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.src = asset.url
    await waitForEvent(image, 'load', 8000)
    return {
      draw: image,
      width: image.naturalWidth || asset.width,
      height: image.naturalHeight || asset.height,
      seek: null,
      dispose: () => {
        image.removeAttribute('src')
      },
    }
  }

  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.crossOrigin = 'anonymous'
  video.src = asset.url
  await waitForEvent(video, 'loadeddata', 15000)
  return {
    draw: video,
    width: video.videoWidth || asset.width,
    height: video.videoHeight || asset.height,
    seek: async (time: number) => {
      const target = Math.max(0, time)
      if (video.readyState >= 2 && Math.abs(video.currentTime - target) < 1e-3) return
      await waitForEvent(video, 'seeked', 8000)
      video.currentTime = target
      // currentTime 赋值后再等一次 seeked（部分浏览器会同步触发，上面的监听已覆盖）
      await new Promise<void>((resolve) => {
        const done = () => {
          video.removeEventListener('seeked', done)
          resolve()
        }
        if (Math.abs(video.currentTime - target) < 1e-3) {
          resolve()
          return
        }
        video.addEventListener('seeked', done, { once: true })
        window.setTimeout(done, 3000)
      })
    },
    dispose: () => {
      video.pause()
      video.removeAttribute('src')
      try {
        video.load()
      } catch {
        // 忽略：元素即将被 GC。
      }
    },
  }
}

/**
 * 把一个带动画的片段逐帧渲染成 PNG 序列，再用 ffmpeg 编码成一个中间 MP4。
 *
 * 约束：渲染完一个片段后立刻删除它的全部帧文件（以及中间 mp4），
 * 只把最终的 File 返回给调用方，避免多片段的帧同时堆在内存/虚拟文件系统里。
 */
export async function renderAnimatedClipToFile(
  options: RenderAnimatedClipOptions,
): Promise<File> {
  const { clip, asset, project, width, height, fps, index, ffmpeg, signal, onFrame } = options
  const duration = clipTimelineDuration(clip)
  const total = animationFrameCount(clip, fps)
  const canvasW = Math.max(2, Math.round(width / 2) * 2)
  const canvasH = Math.max(2, Math.round(height / 2) * 2)
  const canvas = document.createElement('canvas')
  canvas.width = canvasW
  canvas.height = canvasH
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建动画渲染画布。')

  const background = clipBackground(clip, project)
  const backgroundFill = backgroundCssColor(background)
  const frameFiles: string[] = []
  const outputName = `anim_${index}.mp4`
  const source = await openSource(asset)

  try {
    for (let frame = 0; frame < total; frame += 1) {
      throwIfAborted(signal)
      const localTime = Math.min(duration, frame / fps)
      // 该帧对应的源时间（变速/裁剪已包含在 clipSpanSourceAt 里）。
      if (source.seek) {
        const sourceTime =
          clip.type === 'freeze' ? clipFreezeFrame(clip) : clipSpanSourceAt(clip, localTime)
        await source.seek(sourceTime)
      }
      // 背景烘焙：中间视频不带 alpha，先把该时刻的画面背景铺上，再画片段。
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
      ctx.filter = 'none'
      ctx.clearRect(0, 0, canvasW, canvasH)
      ctx.fillStyle = backgroundFill
      ctx.fillRect(0, 0, canvasW, canvasH)
      ctx.restore()

      drawClipFrame({
        ctx,
        clip,
        localTime,
        asset,
        canvasW,
        canvasH,
        source: source.draw,
        sourceWidth: source.width,
        sourceHeight: source.height,
        overrides: resolveClipOverrides(clip, localTime, duration),
      })

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((result) => resolve(result), 'image/png'),
      )
      if (!blob) throw new Error('动画帧渲染失败。')
      const name = `anim_${index}_${String(frame).padStart(5, '0')}.png`
      await ffmpeg.writeFile(name, new Uint8Array(await blob.arrayBuffer()))
      frameFiles.push(name)
      onFrame?.(frame + 1, total)
    }

    throwIfAborted(signal)
    const code = await ffmpeg.exec([
      '-hide_banner',
      '-y',
      '-framerate',
      String(fps),
      '-i',
      `anim_${index}_%05d.png`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      outputName,
    ])
    if (code !== 0) throw new Error(`动画片段编码失败（退出码 ${code}）。`)
    const data = await ffmpeg.readFile(outputName)
    if (typeof data === 'string') throw new Error('动画片段编码返回了文本数据。')
    const copy = new Uint8Array(data.byteLength)
    copy.set(data)
    return new File([copy.buffer], outputName, { type: 'video/mp4' })
  } finally {
    source.dispose()
    for (const file of [...frameFiles, outputName]) {
      try {
        await ffmpeg.deleteFile(file)
      } catch {
        // 尽力清理；文件可能已被删除。
      }
    }
  }
}