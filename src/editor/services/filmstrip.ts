import type { SourceInfo } from '../core/types'

export interface ClipFrames {
  /** Horizontal sprite containing frames sampled across the clip range. */
  sprite: HTMLCanvasElement
  count: number
  tileWidth: number
  tileHeight: number
  start: number
  end: number
}

const TILE_WIDTH = 160
const TILE_HEIGHT = 90
const MIN_FRAMES = 8
const MAX_FRAMES = 24
const MAX_CACHE = 24
const MAX_CONCURRENT = 2
const SEEK_TIMEOUT_MS = 3000
const METADATA_TIMEOUT_MS = 12_000

const cache = new Map<string, Promise<ClipFrames>>()
let activeBuilds = 0
const waiting: (() => void)[] = []

async function withBuildSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeBuilds >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiting.push(resolve))
  }
  activeBuilds += 1
  try {
    return await task()
  } finally {
    activeBuilds -= 1
    const next = waiting.shift()
    next?.()
  }
}

/**
 * Builds (and caches) a filmstrip for one clip's source range. Sampling only
 * the range the clip actually shows is important: a short clip inside a long
 * asset would otherwise collapse to a single sampled frame.
 */
export function getClipFrames(
  asset: SourceInfo,
  sourceStart: number,
  sourceEnd: number,
): Promise<ClipFrames> {
  const start = Math.max(0, sourceStart)
  const end = Math.max(start + 0.02, sourceEnd)
  const key = `${asset.url}|${start.toFixed(3)}|${end.toFixed(3)}`
  const cached = cache.get(key)
  if (cached) return cached

  while (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value
    if (!oldest) break
    cache.delete(oldest)
  }

  const pending = withBuildSlot(() => buildClipFrames(asset, start, end))
  cache.set(key, pending)
  pending.catch(() => {
    if (cache.get(key) === pending) cache.delete(key)
  })
  return pending
}

function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      window.clearTimeout(timer)
      video.removeEventListener('loadedmetadata', check)
      video.removeEventListener('loadeddata', check)
      video.removeEventListener('durationchange', check)
      video.removeEventListener('error', fail)
    }
    const check = () => {
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
    const fail = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('无法读取素材画面。'))
    }
    const timer = window.setTimeout(fail, METADATA_TIMEOUT_MS)
    video.addEventListener('loadedmetadata', check)
    video.addEventListener('loadeddata', check)
    video.addEventListener('durationchange', check)
    video.addEventListener('error', fail)
  })
}

function waitForFirstFrame(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2 && video.videoWidth > 0) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      video.removeEventListener('loadeddata', finish)
      resolve()
    }
    const timer = window.setTimeout(finish, 2000)
    video.addEventListener('loadeddata', finish)
  })
}

function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      video.removeEventListener('seeked', finish)
      resolve()
    }
    const timer = window.setTimeout(finish, SEEK_TIMEOUT_MS)
    video.addEventListener('seeked', finish)
    try {
      if (Math.abs(video.currentTime - time) < 0.005 && video.readyState >= 2) {
        finish()
        return
      }
      video.currentTime = time
    } catch {
      finish()
    }
  })
}

function drawFrame(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  x: number,
): boolean {
  context.fillStyle = '#0b0b0a'
  context.fillRect(x, 0, TILE_WIDTH, TILE_HEIGHT)
  if (video.videoWidth === 0 || video.videoHeight === 0) return false
  const scale = Math.min(TILE_WIDTH / video.videoWidth, TILE_HEIGHT / video.videoHeight)
  const width = video.videoWidth * scale
  const height = video.videoHeight * scale
  try {
    context.drawImage(
      video,
      x + (TILE_WIDTH - width) / 2,
      (TILE_HEIGHT - height) / 2,
      width,
      height,
    )
    return true
  } catch {
    return false
  }
}

async function buildClipFrames(
  asset: SourceInfo,
  requestedStart: number,
  requestedEnd: number,
): Promise<ClipFrames> {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.style.cssText =
    'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.001;pointer-events:none;'
  document.body.appendChild(video)

  try {
    const ready = waitForMetadata(video)
    video.src = asset.url
    try {
      video.load()
    } catch {
      // Setting src already started loading in most browsers.
    }
    await ready
    await waitForFirstFrame(video)

    const duration =
      Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : Math.max(0.1, asset.duration)
    const start = Math.min(Math.max(0, requestedStart), Math.max(0, duration - 0.03))
    const end = Math.min(
      Math.max(start + 0.02, requestedEnd),
      Math.max(start + 0.02, duration - 0.01),
    )
    const range = Math.max(0.02, end - start)
    const count = Math.max(
      MIN_FRAMES,
      Math.min(MAX_FRAMES, Math.ceil(range * 2)),
    )
    const sprite = document.createElement('canvas')
    sprite.width = count * TILE_WIDTH
    sprite.height = TILE_HEIGHT
    const context = sprite.getContext('2d')
    if (!context) throw new Error('无法创建缩略图画布。')
    context.fillStyle = '#0b0b0a'
    context.fillRect(0, 0, sprite.width, sprite.height)

    let painted = 0
    for (let index = 0; index < count; index += 1) {
      const ratio = count <= 1 ? 0 : index / (count - 1)
      const time = start + range * ratio
      await seekTo(video, time)
      if (drawFrame(context, video, index * TILE_WIDTH)) painted += 1
    }
    if (painted === 0) throw new Error('无法读取素材画面。')

    return {
      sprite,
      count,
      tileWidth: TILE_WIDTH,
      tileHeight: TILE_HEIGHT,
      start,
      end,
    }
  } finally {
    video.pause()
    video.removeAttribute('src')
    try {
      video.load()
    } catch {
      // Detached media teardown is best-effort.
    }
    video.remove()
  }
}