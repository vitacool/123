import { IMAGE_DEFAULT_DURATION } from '../core/image'
import { createId } from '../core/ids'
import type { MediaAsset } from '../core/types'
import { decodeAudioDuration } from './audioWaveform'
import { transcodeToH264 } from './videoTranscoder'

/**
 * 把用户选的 File 读成 MediaAsset：探测时长 / 尺寸 / 缩略图，
 * 必要时把 HEVC 之类浏览器解不了的视频本地转码成 H.264。
 *
 * 编辑器导入素材与宿主 API 的 loadProject 都用同一套逻辑，
 * 避免两处探测结果不一致。
 */

function isSupportedVideo(file: File): boolean {
  if (file.type.startsWith('video/')) return true
  return /\.(mp4|m4v|webm|mov|ogv|ogg|mkv)$/i.test(file.name)
}

function isSupportedAudio(file: File): boolean {
  if (file.type.startsWith('audio/')) return true
  return /\.(mp3|wav|m4a|aac|ogg|oga|flac)$/i.test(file.name)
}

function isSupportedImage(file: File): boolean {
  if (file.type === 'image/jpeg' || file.type === 'image/png' || file.type === 'image/webp' || file.type === 'image/gif') {
    return true
  }
  return /\.(jpg|jpeg|png|webp|gif)$/i.test(file.name)
}

export function isSupportedMedia(file: File): boolean {
  return isSupportedVideo(file) || isSupportedAudio(file) || isSupportedImage(file)
}

/** 读取图片尺寸并生成缩略图（静帧素材没有时长概念，用默认 3 秒占位）。 */
async function readImageAsset(file: File, url: string): Promise<MediaAsset> {
  const image = await loadImageElement(url)
  const thumbnail = imageThumbnail(image)
  return {
    id: createId('asset'),
    url,
    name: file.name,
    size: file.size,
    duration: IMAGE_DEFAULT_DURATION,
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height,
    kind: 'image',
    file,
    hasAudio: false,
    thumbnail: thumbnail ?? undefined,
  }
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('浏览器无法解码这张图片。'))
    image.src = url
  })
}

/** 把图片等比缩到最大 320px 生成缩略图 dataURL。 */
function imageThumbnail(image: HTMLImageElement): string | null {
  try {
    const maxSide = 320
    const w = image.naturalWidth || image.width
    const h = image.naturalHeight || image.height
    if (w <= 0 || h <= 0) return null
    const scale = Math.min(1, maxSide / Math.max(w, h))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(w * scale))
    canvas.height = Math.max(1, Math.round(h * scale))
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.82)
  } catch {
    return null
  }
}

export function remoteName(url: string): string {
  if (url.startsWith('data:')) return '内嵌视频'
  if (url.startsWith('blob:')) return '本地视频'
  const tail = url.split('/').pop()?.split('?')[0]
  if (!tail) return '远程视频'
  try {
    return decodeURIComponent(tail)
  } catch {
    return tail
  }
}

export function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      window.clearTimeout(timer)
      video.removeEventListener('loadedmetadata', check)
      video.removeEventListener('loadeddata', check)
      video.removeEventListener('durationchange', check)
      video.removeEventListener('error', onError)
    }
    const finish = () => {
      if (settled) return
      if (
        video.videoWidth > 0 &&
        video.videoHeight > 0 &&
        Number.isFinite(video.duration) &&
        video.duration > 0.01
      ) {
        settled = true
        cleanup()
        resolve()
      }
    }
    const check = () => finish()
    const onError = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('浏览器无法解码这个视频文件。'))
    }
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('读取视频信息超时。'))
    }, 15000)
    video.addEventListener('loadedmetadata', check)
    video.addEventListener('loadeddata', check)
    video.addEventListener('durationchange', check)
    video.addEventListener('error', onError)
    video.load()
  })
}

export async function captureThumbnail(video: HTMLVideoElement, duration: number): Promise<string | null> {
  try {
    if (video.readyState < 2) {
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 1800)
        const done = () => {
          window.clearTimeout(timer)
          video.removeEventListener('loadeddata', done)
          resolve()
        }
        video.addEventListener('loadeddata', done)
      })
    }
    if (video.readyState < 2 || video.videoWidth === 0) return null
    const target = Math.min(Math.max(0.1, duration * 0.08), Math.max(0.1, Math.min(3, duration - 0.1)))
    if (Math.abs(video.currentTime - target) > 0.05) {
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 2200)
        const done = () => {
          window.clearTimeout(timer)
          video.removeEventListener('seeked', done)
          resolve()
        }
        video.addEventListener('seeked', done)
        try {
          video.currentTime = target
        } catch {
          done()
        }
      })
    }
    const canvas = document.createElement('canvas')
    canvas.width = 360
    canvas.height = 202
    const context = canvas.getContext('2d')
    if (!context) return null
    context.fillStyle = '#101111'
    context.fillRect(0, 0, canvas.width, canvas.height)
    const fit = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight)
    const width = video.videoWidth * fit
    const height = video.videoHeight * fit
    context.drawImage(
      video,
      (canvas.width - width) / 2,
      (canvas.height - height) / 2,
      width,
      height,
    )
    return canvas.toDataURL('image/jpeg', 0.7)
  } catch {
    return null
  }
}

export interface ReadAssetOptions {
  allowTranscode?: boolean
  onTranscodeStatus?: (message: string) => void
  onTranscodeProgress?: (progress: number) => void
}

export async function readAssetFile(
  file: File,
  options: ReadAssetOptions = {},
): Promise<MediaAsset> {
  const audioOnly = isSupportedAudio(file) && !isSupportedVideo(file)
  let url = URL.createObjectURL(file)
  // 图片素材：静态解码尺寸 + 缩略图，不需要 video/audio 加载器。
  if (isSupportedImage(file) && !isSupportedVideo(file)) {
    try {
      return await readImageAsset(file, url)
    } catch (error) {
      URL.revokeObjectURL(url)
      throw error
    }
  }
  let sourceFile = file
  const loader = document.createElement(audioOnly ? 'audio' : 'video')
  loader.preload = 'auto'
  if (loader instanceof HTMLVideoElement) {
    loader.muted = true
    loader.playsInline = true
  }
  loader.src = url
  try {
    if (audioOnly) {
      let duration: number
      try {
        await waitForAudioMetadata(loader as HTMLAudioElement)
        duration = (loader as HTMLAudioElement).duration
      } catch {
        duration = await decodeAudioDuration(file)
      }
      return {
        id: createId('asset'),
        url,
        name: file.name,
        size: file.size,
        duration,
        width: 0,
        height: 0,
        kind: 'audio',
        file,
      }
    }
    const video = loader as HTMLVideoElement
    try {
      await waitForVideoMetadata(video)
    } catch (error) {
      if (!options.allowTranscode) throw error
      options.onTranscodeStatus?.('检测到浏览器不支持的视频编码，正在转码…')
      const converted = await transcodeToH264(file, {
        onStatus: options.onTranscodeStatus,
        onProgress: options.onTranscodeProgress,
      })
      URL.revokeObjectURL(url)
      sourceFile = converted
      url = URL.createObjectURL(converted)
      loader.src = url
      await waitForVideoMetadata(video)
      options.onTranscodeStatus?.('转码完成，正在读取视频信息…')
    }
    const duration = video.duration
    const thumbnail = await captureThumbnail(video, duration)
    return {
      id: createId('asset'),
      url,
      name: sourceFile.name,
      size: sourceFile.size,
      duration,
      width: video.videoWidth,
      height: video.videoHeight,
      kind: 'video',
      file: sourceFile,
      thumbnail: thumbnail ?? undefined,
    }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  } finally {
    loader.pause()
    loader.removeAttribute('src')
    try {
      loader.load()
    } catch {
      // Detached media teardown is best-effort.
    }
  }
}

function waitForAudioMetadata(audio: HTMLAudioElement): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      window.clearTimeout(timer)
      audio.removeEventListener('loadedmetadata', check)
      audio.removeEventListener('durationchange', check)
      audio.removeEventListener('error', fail)
    }
    const finish = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const check = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0.01) finish()
    }
    const fail = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('浏览器无法解码这个音频文件。'))
    }
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('读取音频信息超时。'))
    }, 15000)
    audio.addEventListener('loadedmetadata', check)
    audio.addEventListener('durationchange', check)
    audio.addEventListener('error', fail)
  })
}
