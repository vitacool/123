import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import ffmpegPath from 'ffmpeg-static'
import type { CanvasBackground, Clip, Project } from '../src/editor/core/types'

/**
 * 「预览与导出对比」测试工具。
 *
 * 思路：同一工程、同一时间点，分别取
 * - 预览：把视频帧交给 **真实** clipRender.drawClipFrame 画到 canvas（与 Preview 同一份
 *   core 代码），读整帧平均 RGB；
 * - 导出：用 **真实** ffmpeg 解码导出视频的那一帧，读整帧平均 RGB。
 *
 * 两边都覆盖画布背景 + 片段合成（不透明度 / 混合模式）。色差主要来自
 * 「sRGB canvas ↔ yuv420p limited range」往返：core/exportPlan 里记录过的既有基线是
 * 单通道最大约 18，因此默认容差取 {@link PARITY_TOLERANCE}。
 *
 * 后续涉及预览/导出对齐的改动（混合、调色、蒙版等）都可以复用这里的
 * {@link averageClipRenderColor} / {@link averageVideoFrameColor} / {@link compareAverageColors}。
 */

export interface RgbColor {
  r: number
  g: number
  b: number
}

/** canvas sRGB 与导出 yuv420p limited range 往返的既有色差基线（含余量）。 */
export const PARITY_TOLERANCE = 36

export interface ClipRenderProbe {
  /** 片段参数（与工程里的一致；opacity/blendMode/geometry 都会参与渲染）。 */
  clip: Clip
  /** 该片段的画布背景（工程级或片段级覆盖）。 */
  background: CanvasBackground
  canvasWidth: number
  canvasHeight: number
  /** 片段本地时间（秒）：用于 seek 素材并传给 drawClipFrame。 */
  localTime: number
  /** 素材文件（base64，不含 data: 前缀）。 */
  sourceBase64: string
  sourceName: string
  sourceMimeType?: string
}

/** 取样区域（像素，画布坐标）；省略表示整帧。 */
export interface SampleRegion {
  x: number
  y: number
  width: number
  height: number
}

function clampRegion(
  region: SampleRegion | undefined,
  width: number,
  height: number,
): SampleRegion {
  if (!region) return { x: 0, y: 0, width, height }
  const x = Math.max(0, Math.min(width - 1, Math.round(region.x)))
  const y = Math.max(0, Math.min(height - 1, Math.round(region.y)))
  return {
    x,
    y,
    width: Math.max(1, Math.min(width - x, Math.round(region.width))),
    height: Math.max(1, Math.min(height - y, Math.round(region.height))),
  }
}

/**
 * 在页面里用真实 clipRender 渲染一帧并返回平均 RGB（可只取某个区域，例如四角）。
 *
 * 通过 Vite dev server 动态 import core 模块：拿到的是**与预览完全相同**的渲染代码，
 * 而不是在测试里复刻一套绘制逻辑。
 */
export async function averageClipRenderColor(
  page: Page,
  probe: ClipRenderProbe,
  region?: SampleRegion,
): Promise<RgbColor> {
  return page.evaluate(async (input) => {
    // 动态 import：dev server 会即时编译 TS；非字面量路径避免 tsc 去解析浏览器路径。
    const clipRenderPath = '/src/editor/core/clipRender.ts'
    const clipRender = (await import(/* @vite-ignore */ clipRenderPath)) as {
      drawClipFrame: (value: Record<string, unknown>) => void
    }

    const bytes = Uint8Array.from(atob(input.sourceBase64), (char) => char.charCodeAt(0))
    const blob = new Blob([bytes], { type: input.sourceMimeType ?? 'video/mp4' })
    const url = URL.createObjectURL(blob)
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.src = url
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve()
      video.onerror = () => reject(new Error('对比工具：素材加载失败'))
    })
    const seekTo = Math.max(0, Math.min(video.duration - 0.05, input.localTime))
    video.currentTime = seekTo
    await new Promise<void>((resolve, reject) => {
      video.onseeked = () => resolve()
      video.onerror = () => reject(new Error('对比工具：seek 失败'))
    })

    const canvas = document.createElement('canvas')
    canvas.width = input.canvasWidth
    canvas.height = input.canvasHeight
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('对比工具：无法创建 2D 画布')

    // 与 Preview.paintBackground 一致：黑场用画布底色，纯色用配置色。
    const background = input.background
    ctx.fillStyle =
      background.type === 'color' ? (background.color ?? '#000000') : '#070808'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    clipRender.drawClipFrame({
      ctx,
      clip: input.clip,
      localTime: input.localTime,
      asset: {
        url: 'blob:parity-source',
        name: input.sourceName,
        size: bytes.length,
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
      },
      canvasW: canvas.width,
      canvasH: canvas.height,
      source: video,
      sourceWidth: video.videoWidth,
      sourceHeight: video.videoHeight,
    })

    const sampleX = input.region
      ? Math.max(0, Math.min(canvas.width - 1, Math.round(input.region.x)))
      : 0
    const sampleY = input.region
      ? Math.max(0, Math.min(canvas.height - 1, Math.round(input.region.y)))
      : 0
    const sampleW = input.region
      ? Math.max(1, Math.min(canvas.width - sampleX, Math.round(input.region.width)))
      : canvas.width
    const sampleH = input.region
      ? Math.max(1, Math.min(canvas.height - sampleY, Math.round(input.region.height)))
      : canvas.height
    const data = ctx.getImageData(sampleX, sampleY, sampleW, sampleH).data
    let r = 0
    let g = 0
    let b = 0
    const pixels = data.length / 4
    for (let index = 0; index < data.length; index += 4) {
      r += data[index]
      g += data[index + 1]
      b += data[index + 2]
    }
    URL.revokeObjectURL(url)
    video.removeAttribute('src')
    return {
      r: Math.round(r / pixels),
      g: Math.round(g / pixels),
      b: Math.round(b / pixels),
    }
  }, { ...probe, region: region ? clampRegion(region, probe.canvasWidth, probe.canvasHeight) : undefined })
}

/** 读取素材文件为 base64（Node 侧）。 */
export function readSourceBase64(path: string): string {
  return readFileSync(path).toString('base64')
}

export interface ComposeFrameProbe {
  /** 完整工程（主轨 + 叠加轨），会交给真实的 composeFrame。 */
  project: Project
  /** 时间轴时刻（秒）。 */
  time: number
  canvasWidth: number
  canvasHeight: number
  sourceBase64: string
  sourceName: string
  sourceMimeType?: string
  /** 每个参与合成的片段：id + 该时刻对应的源时间（秒，用于 seek 素材）。 */
  frames: { clipId: string; seekTime: number }[]
}

/**
 * 多轨预览：把工程交给真实 `composeFrame`（与 Preview 同一份合成代码）画一帧，
 * 返回平均 RGB。用于叠加轨 / 混合模式这类「整帧合成」的对比。
 */
export async function averageComposeFrameColor(
  page: Page,
  probe: ComposeFrameProbe,
  region?: SampleRegion,
): Promise<RgbColor> {
  return page.evaluate(async (input) => {
    const frameComposePath = '/src/editor/core/frameCompose.ts'
    const frameCompose = (await import(/* @vite-ignore */ frameComposePath)) as {
      composeFrame: (value: Record<string, unknown>) => void
    }

    const bytes = Uint8Array.from(atob(input.sourceBase64), (char) => char.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: input.sourceMimeType ?? 'video/mp4' }))
    const videos: HTMLVideoElement[] = []
    const frames = new Map<string, { source: CanvasImageSource; width: number; height: number }>()
    for (const item of input.frames) {
      const video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.src = url
      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve()
        video.onerror = () => reject(new Error('对比工具：素材加载失败'))
      })
      const seekTo = Math.max(0, Math.min(video.duration - 0.05, item.seekTime))
      video.currentTime = seekTo
      await new Promise<void>((resolve, reject) => {
        video.onseeked = () => resolve()
        video.onerror = () => reject(new Error('对比工具：seek 失败'))
      })
      frames.set(item.clipId, {
        source: video,
        width: video.videoWidth,
        height: video.videoHeight,
      })
      videos.push(video)
    }

    const canvas = document.createElement('canvas')
    canvas.width = input.canvasWidth
    canvas.height = input.canvasHeight
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('对比工具：无法创建 2D 画布')

    frameCompose.composeFrame({
      ctx,
      width: canvas.width,
      height: canvas.height,
      project: input.project,
      time: input.time,
      frames,
    })

    const sampleX = input.region
      ? Math.max(0, Math.min(canvas.width - 1, Math.round(input.region.x)))
      : 0
    const sampleY = input.region
      ? Math.max(0, Math.min(canvas.height - 1, Math.round(input.region.y)))
      : 0
    const sampleW = input.region
      ? Math.max(1, Math.min(canvas.width - sampleX, Math.round(input.region.width)))
      : canvas.width
    const sampleH = input.region
      ? Math.max(1, Math.min(canvas.height - sampleY, Math.round(input.region.height)))
      : canvas.height
    const data = ctx.getImageData(sampleX, sampleY, sampleW, sampleH).data
    let r = 0
    let g = 0
    let b = 0
    const pixels = data.length / 4
    for (let index = 0; index < data.length; index += 4) {
      r += data[index]
      g += data[index + 1]
      b += data[index + 2]
    }
    for (const video of videos) video.removeAttribute('src')
    URL.revokeObjectURL(url)
    return {
      r: Math.round(r / pixels),
      g: Math.round(g / pixels),
      b: Math.round(b / pixels),
    }
  }, { ...probe, region: region ? clampRegion(region, probe.canvasWidth, probe.canvasHeight) : undefined })
}

/** 用 ffmpeg 解码导出视频的某一帧并返回平均 RGB（可只取某个区域）。 */
export function averageVideoFrameColor(
  videoPath: string,
  time: number,
  width: number,
  height: number,
  region?: SampleRegion,
): RgbColor {
  if (!ffmpegPath) throw new Error('ffmpeg-static 二进制不可用')
  // 只取一帧、输出裸 RGB：不做缩放，尺寸必须与导出画布一致。
  const result = spawnSync(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(time),
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  )
  if (result.status !== 0) {
    throw new Error(`对比工具：ffmpeg 解码导出帧失败：${String(result.stderr ?? '')}`)
  }
  const buffer = result.stdout as Buffer
  const expected = width * height * 3
  if (buffer.length < expected) {
    throw new Error(
      `对比工具：导出帧尺寸不符（得到 ${buffer.length} 字节，期望 ${expected}，${width}x${height}）`,
    )
  }
  const sample = clampRegion(region, width, height)
  let r = 0
  let g = 0
  let b = 0
  for (let row = 0; row < sample.height; row += 1) {
    const rowStart = ((sample.y + row) * width + sample.x) * 3
    for (let column = 0; column < sample.width; column += 1) {
      const offset = rowStart + column * 3
      r += buffer[offset]
      g += buffer[offset + 1]
      b += buffer[offset + 2]
    }
  }
  const pixels = sample.width * sample.height
  return { r: Math.round(r / pixels), g: Math.round(g / pixels), b: Math.round(b / pixels) }
}

/** 比较两组平均色：返回各通道差值与最大/平均差（0–255）。 */
export function compareAverageColors(
  preview: RgbColor,
  exported: RgbColor,
): { delta: RgbColor; maxDelta: number; meanDelta: number } {
  const delta = {
    r: Math.abs(preview.r - exported.r),
    g: Math.abs(preview.g - exported.g),
    b: Math.abs(preview.b - exported.b),
  }
  const maxDelta = Math.max(delta.r, delta.g, delta.b)
  const meanDelta = (delta.r + delta.g + delta.b) / 3
  return { delta, maxDelta, meanDelta }
}