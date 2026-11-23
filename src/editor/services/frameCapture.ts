import { clipFrameSourceAt } from '../core/clipTime'
import { composeFrame, frameCompositionAt, type FrameImage, type FrameLayer } from '../core/frameCompose'
import type { Clip, Project, SourceInfo } from '../core/types'
import { openSource, type FrameSourceHandle } from './animationRenderer'
import { remoteName } from './assetReader'
import { webglKeyer } from './webglKeyer'

/**
 * 「导出当前帧」的副作用部分：把该时刻需要画面的每个片段 seek 到正确的源时间，
 * 再把画面交给 core/frameCompose.composeFrame 合成到离屏画布并编码成 PNG。
 *
 * 合成规则（背景 / 主轨 / 转场 / 叠加轨 / 文字）全部在 core 里，这里只负责
 * 「解码 / seek / 出图」这些必须碰 DOM 的活。
 */

export interface CaptureFrameInput {
  project: Project
  /** 工程素材库；用于按 `clip.sourceUrl` 找到可解码的画面。 */
  assets: SourceInfo[]
  /** 时间轴时刻（秒）。 */
  time: number
  /** 目标像素尺寸（一般来自 core/frameCompose.frameCaptureSize）。 */
  width: number
  height: number
}

export interface CaptureFrameResult {
  /** PNG 数据；画布创建 / 编码失败时为 null。 */
  blob: Blob | null
  /** 素材缺失或解码失败的人类可读说明（调用方负责 toast 提示）。 */
  failures: string[]
  width: number
  height: number
}

const assetNameOf = (asset: SourceInfo | undefined, clip: Clip): string =>
  asset?.name || clip.sourceUrl

/** 把 failures 压成一句可展示的 warning 文案（没有失败时返回 null）。 */
export function frameCaptureWarning(failures: readonly string[]): string | null {
  if (failures.length === 0) return null
  return failures.length > 1 ? `${failures[0]}（共 ${failures.length} 处画面缺失）` : failures[0]
}

/**
 * 合成某一时刻的画面并编码成 PNG。
 *
 * 永不抛出：素材缺失、解码 / seek 失败都只记进 `failures`，用剩余可用的画面出图；
 * 这样宿主或 UI 拿到的是「一张可能不完整的图 + 警告」，而不是未处理的异常。
 */
export async function captureFrameBlob(input: CaptureFrameInput): Promise<CaptureFrameResult> {
  const { project, assets, time, width, height } = input
  const failures = new Set<string>()
  const frames = new Map<string, FrameImage>()
  const handles: FrameSourceHandle[] = []
  const assetByUrl = new Map(assets.map((asset) => [asset.url, asset]))

  try {
    const composition = frameCompositionAt(project, time)
    // 去重：转场两侧、叠加轨都可能引用同一个片段 id（同一个片段只解码一次）。
    const layerByClipId = new Map<string, FrameLayer>()
    for (const layer of [...composition.main, ...composition.overlays]) {
      if (!layerByClipId.has(layer.clip.id)) layerByClipId.set(layer.clip.id, layer)
    }

    for (const layer of layerByClipId.values()) {
      const clip = layer.clip
      const asset = assetByUrl.get(clip.sourceUrl)
      if (!asset) {
        // 素材库里已经查不到这个 url：不要显示 blob:/http 地址，尽量给个可读的名字。
        failures.add(`素材「${remoteName(clip.sourceUrl) || '未知素材'}」已不在素材库`)
        continue
      }
      try {
        const handle = await openSource(asset)
        handles.push(handle)
        if (handle.seek) {
          const local = Math.max(0, Math.min(layer.duration, time - layer.start))
          // 与预览的 safeMediaTime 一致：不 seek 到素材末尾之外；
          // 素材时长未知（0）时不夹取，交给 video 元素自行处理。
          const limit =
            asset.duration > 0 ? Math.max(0, asset.duration - 0.001) : Number.POSITIVE_INFINITY
          const target = Math.min(Math.max(0, clipFrameSourceAt(clip, local)), limit)
          await handle.seek(target)
        }
        if (handle.width <= 0 || handle.height <= 0) {
          failures.add(`素材「${assetNameOf(asset, clip)}」画面尺寸无效`)
          continue
        }
        frames.set(clip.id, {
          source: handle.draw,
          width: handle.width,
          height: handle.height,
        })
      } catch {
        failures.add(`素材「${assetNameOf(asset, clip)}」无法解码画面`)
      }
    }

    const canvas = document.createElement('canvas')
    canvas.width = Math.max(2, Math.round(width))
    canvas.height = Math.max(2, Math.round(height))
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      failures.add('当前浏览器无法创建截图画布')
      return { blob: null, failures: [...failures], width: canvas.width, height: canvas.height }
    }
    composeFrame({
      ctx,
      width: canvas.width,
      height: canvas.height,
      project,
      time,
      frames,
      keyFrame: webglKeyer,
      createCanvas: (w, h) => {
        const off = document.createElement('canvas')
        off.width = Math.max(1, Math.round(w))
        off.height = Math.max(1, Math.round(h))
        const inner = off.getContext('2d')
        return inner ? { canvas: off, ctx: inner } : null
      },
    })
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((result) => resolve(result), 'image/png'),
    )
    if (!blob) failures.add('当前帧 PNG 编码失败')
    return { blob, failures: [...failures], width: canvas.width, height: canvas.height }
  } catch {
    failures.add('当前帧渲染失败')
    return { blob: null, failures: [...failures], width, height }
  } finally {
    for (const handle of handles) {
      try {
        handle.dispose()
      } catch {
        // 释放失败不影响已经合成好的画面。
      }
    }
  }
}