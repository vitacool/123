import type { CoverMode, ProjectCover, SourceInfo } from './types'

/** 封面图最长边上限（dataURL 体积与导出质量的平衡点）。 */
export const COVER_MAX_SHORT_SIDE = 1280

/** 帧来源的封面在视频里覆盖的时长（一帧）。 */
export function coverFrameSeconds(fps: number): number {
  const safe = Number.isFinite(fps) && fps > 0 ? fps : 30
  return 1 / safe
}

/** 强制偶数（H.264 要求宽高为偶数）。 */
export function evenSize(value: number): number {
  const rounded = Math.max(2, Math.round(value))
  return rounded - (rounded % 2)
}

/**
 * 封面渲染尺寸：跟随画布比例，短边不超过 `maxShortSide`，宽高强制偶数。
 * 与文本层 PNG 的做法一致（都用画布尺寸出图），只是这里额外限制短边。
 */
export function coverTargetSize(
  canvasWidth: number,
  canvasHeight: number,
  maxShortSide = COVER_MAX_SHORT_SIDE,
): { width: number; height: number } {
  const width = Math.max(2, canvasWidth)
  const height = Math.max(2, canvasHeight)
  const shortSide = Math.min(width, height)
  const scale = shortSide > maxShortSide ? maxShortSide / shortSide : 1
  return { width: evenSize(width * scale), height: evenSize(height * scale) }
}

/**
 * cover 裁剪（不是 contain）：按目标比例居中裁出源图，避免拉伸变形。
 * 返回源图上的裁剪矩形。
 */
export function coverCropRect(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): { x: number; y: number; width: number; height: number } {
  if (sourceWidth <= 0 || sourceHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) {
    return { x: 0, y: 0, width: Math.max(1, sourceWidth), height: Math.max(1, sourceHeight) }
  }
  const sourceRatio = sourceWidth / sourceHeight
  const targetRatio = targetWidth / targetHeight
  if (sourceRatio > targetRatio) {
    // 源更宽：按高度铺满，左右裁掉
    const width = sourceHeight * targetRatio
    return { x: (sourceWidth - width) / 2, y: 0, width, height: sourceHeight }
  }
  // 源更高：按宽度铺满，上下裁掉
  const height = sourceWidth / targetRatio
  return { x: 0, y: (sourceHeight - height) / 2, width: sourceWidth, height }
}

/** 把一张图按 cover 方式画满目标画布（居中裁剪，不拉伸）。 */
export function drawCoverInto(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): void {
  const crop = coverCropRect(sourceWidth, sourceHeight, targetWidth, targetHeight)
  context.drawImage(
    image,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    targetWidth,
    targetHeight,
  )
}

/** 容忍旧数据 / 手改工程文件：字段不合法就当作没有封面。 */
export function normalizeCover(value: unknown): ProjectCover | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Partial<ProjectCover>
  if (typeof raw.dataUrl !== 'string' || !raw.dataUrl.startsWith('data:image/')) return undefined
  const mode: CoverMode = raw.mode === 'first-frame' ? 'first-frame' : 'separate'
  const source = raw.source
  if (!source || typeof source !== 'object') {
    return { dataUrl: raw.dataUrl, source: { kind: 'image' }, mode }
  }
  if ((source as { kind?: string }).kind === 'frame') {
    const frame = source as { assetId?: string; time?: number }
    return {
      dataUrl: raw.dataUrl,
      source: {
        kind: 'frame',
        time: Number.isFinite(frame.time) ? Math.max(0, frame.time as number) : 0,
        ...(typeof frame.assetId === 'string' ? { assetId: frame.assetId } : {}),
      },
      mode,
    }
  }
  const image = source as { name?: string }
  return {
    dataUrl: raw.dataUrl,
    source: { kind: 'image', ...(typeof image.name === 'string' ? { name: image.name } : {}) },
    mode,
  }
}

/** 是否存在封面。 */
export function hasCover(project: { cover?: ProjectCover }): boolean {
  return Boolean(project.cover?.dataUrl)
}

/** 视频首帧是否需要被封面覆盖。 */
export function coverOverlaysFirstFrame(project: { cover?: ProjectCover }): boolean {
  return Boolean(project.cover?.dataUrl) && project.cover?.mode === 'first-frame'
}

/**
 * 从视频元素截一帧作为封面 dataURL（JPEG，质量 0.9）。
 * 绘制方式与文本层出图一致：canvas 尺寸 = 目标尺寸，按 cover 居中裁剪。
 * `time` 超出素材范围时会被夹到有效区间。
 */
export async function captureCoverFrame(
  source: SourceInfo,
  time: number,
  targetWidth: number,
  targetHeight: number,
  quality = 0.9,
): Promise<string | null> {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.crossOrigin = 'anonymous'
  video.src = source.url

  const cleanup = () => {
    video.removeAttribute('src')
    try {
      video.load()
    } catch {
      // 忽略：元素即将被 GC。
    }
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => resolve(), 4000)
      const done = () => {
        window.clearTimeout(timer)
        video.removeEventListener('loadeddata', done)
        video.removeEventListener('error', fail)
        resolve()
      }
      const fail = () => {
        window.clearTimeout(timer)
        video.removeEventListener('loadeddata', done)
        video.removeEventListener('error', fail)
        reject(new Error('无法解码素材画面'))
      }
      video.addEventListener('loadeddata', done)
      video.addEventListener('error', fail)
    })

    const duration = Number.isFinite(video.duration) ? video.duration : source.duration
    const safeTime = Math.max(0, Math.min(time, Math.max(0, duration - 0.05)))
    if (video.readyState < 2 || Math.abs(video.currentTime - safeTime) > 0.02) {
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(() => resolve(), 2500)
        const done = () => {
          window.clearTimeout(timer)
          video.removeEventListener('seeked', done)
          resolve()
        }
        video.addEventListener('seeked', done)
        video.currentTime = safeTime
      })
    }
    if (video.readyState < 2 || video.videoWidth <= 0) return null

    const size = coverTargetSize(targetWidth, targetHeight)
    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const context = canvas.getContext('2d')
    if (!context) return null
    drawCoverInto(context, video, video.videoWidth, video.videoHeight, size.width, size.height)
    return canvas.toDataURL('image/jpeg', quality)
  } catch {
    return null
  } finally {
    cleanup()
  }
}

/** 读取用户上传的图片，按画布比例居中裁剪后转成 JPEG dataURL。 */
export async function readCoverImage(
  file: File,
  targetWidth: number,
  targetHeight: number,
  quality = 0.92,
): Promise<string | null> {
  const url = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement | null>((resolve) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => resolve(null)
      element.src = url
    })
    if (!image) return null
    const size = coverTargetSize(targetWidth, targetHeight)
    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const context = canvas.getContext('2d')
    if (!context) return null
    drawCoverInto(
      context,
      image,
      image.naturalWidth || image.width,
      image.naturalHeight || image.height,
      size.width,
      size.height,
    )
    return canvas.toDataURL('image/jpeg', quality)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * 把封面渲染成 PNG（导出用）。
 * 与文本层一脉相承：一块 canvas + `toBlob('image/png')`，尺寸取导出画布并强制偶数。
 */
export async function buildCoverPng(
  canvasWidth: number,
  canvasHeight: number,
  cover: ProjectCover,
): Promise<Uint8Array> {
  const width = evenSize(canvasWidth)
  const height = evenSize(canvasHeight)
  const image = await loadCoverImage(cover.dataUrl)
  if (!image) throw new Error('无法读取封面图片。')
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建封面渲染画布。')
  drawCoverInto(context, image, image.naturalWidth || image.width, image.naturalHeight || image.height, width, height)
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((result) => resolve(result), 'image/png'),
  )
  if (!blob) throw new Error('封面图像渲染失败。')
  return new Uint8Array(await blob.arrayBuffer())
}

/** 由 dataURL 载入图片元素。 */
export function loadCoverImage(dataUrl: string): Promise<HTMLImageElement | null> {
  // 非浏览器环境（SSR / 测试）没有 Image 构造器：当作读不到图，交给调用方报错。
  if (typeof Image === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = dataUrl
  })
}

/** 单独产出的封面图（JPEG，质量 0.92），尺寸取导出画布。 */
export async function buildCoverJpeg(
  canvasWidth: number,
  canvasHeight: number,
  cover: ProjectCover,
  quality = 0.92,
): Promise<Blob> {
  const width = evenSize(canvasWidth)
  const height = evenSize(canvasHeight)
  const image = await loadCoverImage(cover.dataUrl)
  if (!image) throw new Error('无法读取封面图片。')
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建封面渲染画布。')
  drawCoverInto(
    context,
    image,
    image.naturalWidth || image.width,
    image.naturalHeight || image.height,
    width,
    height,
  )
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((result) => resolve(result), 'image/jpeg', quality),
  )
  if (!blob) throw new Error('封面图导出失败。')
  return blob
}