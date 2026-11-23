import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { clipFrameSourceAt } from '../src/editor/core/clipTime'
import { createClip, createInitialProject } from '../src/editor/core/operations'
import { createProjectFile } from '../src/editor/projectFile'
import type { CanvasBackground, Clip, SourceInfo } from '../src/editor/core/types'
import { importProjectFileAndExport } from './projectExportFlow'
import {
  PARITY_TOLERANCE,
  averageComposeFrameColor,
  averageVideoFrameColor,
  compareAverageColors,
  readSourceBase64,
  type ComposeFrameProbe,
  type SampleRegion,
} from './previewExportParity'

/**
 * 叠加轨混合模式：只在画中画的「区域 + 时间」内生效。
 *
 * 回归背景：旧实现把叠加流 tpad 成整条时间线再 `blend=all_mode`。ffmpeg 的 blend
 * 逐平面计算、不按 alpha 合成，透明黑也参与正片叠底 → 画中画以外、片段以外整片黑；
 * colorchannelmixer 的 alpha 被忽略 → 不透明度失效。
 *
 * 这里用一段纯中灰素材（比彩条更确定）：正片叠底对中灰有 ~64 的明显变化，
 * 便于同时验证混合、不透明度、区域与时间范围。
 */
const WIDTH = 320
const HEIGHT = 180
const DURATION = 3
const BACKGROUND: CanvasBackground = { type: 'color', color: '#1b3b6f' }
const SOURCE_URL = 'blob:overlay-gray'
const OVERLAY_START = 0.5
const OVERLAY_DURATION = 1.5
const OVERLAY_OPACITY = 0.3

const SOURCE_INFO: SourceInfo = {
  url: SOURCE_URL,
  name: 'gray.mp4',
  size: 0,
  duration: DURATION,
  width: WIDTH,
  height: HEIGHT,
}

function makeGrayVideo(path: string): void {
  if (!ffmpegPath) throw new Error('ffmpeg-static 二进制不可用')
  const result = spawnSync(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=0x808080:s=${WIDTH}x${HEIGHT}:r=30:d=${DURATION}`,
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=48000:cl=stereo',
      '-t',
      String(DURATION),
      '-shortest',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      path,
    ],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) throw new Error(`生成对比素材失败：${String(result.stderr)}`)
}

function projectWithOverlay(opacity: number = OVERLAY_OPACITY) {
  const base = createInitialProject({ url: SOURCE_URL, duration: DURATION }, 'main-clip')
  const overlayClip: Clip = createClip(
    SOURCE_URL,
    0,
    OVERLAY_DURATION,
    {
      gapBefore: OVERLAY_START,
      scale: 0.5,
      blendMode: 'multiply',
      opacity,
    },
    'overlay-clip',
  )
  return {
    ...base,
    canvasBackground: BACKGROUND,
    clips: [base.clips[0]],
    overlayTracks: [
      { id: 'overlay-track', name: '叠加 1', muted: false, hidden: false, clips: [overlayClip] },
    ],
    exportQuality: { ...base.exportQuality, resolution: '480p' as const },
  }
}

test('叠加轨混合模式：画中画内混合、外部与时间外保持原画面', async ({ page }, testInfo) => {
  test.setTimeout(300_000)
  const sourcePath = join(testInfo.outputDir, 'overlay-gray.mp4')
  mkdirSync(testInfo.outputDir, { recursive: true })
  makeGrayVideo(sourcePath)

  const project = projectWithOverlay()
  const mainClip = project.clips[0]
  const overlayClip = project.overlayTracks[0].clips[0]
  const projectFile = createProjectFile({
    project,
    assets: [
      {
        id: 'asset-1',
        url: SOURCE_URL,
        name: 'gray.mp4',
        size: 0,
        duration: DURATION,
        width: WIDTH,
        height: HEIGHT,
        kind: 'video',
        local: true,
      },
    ],
    sourceUrl: SOURCE_URL,
    timelineZoom: 92,
    timelineSettings: {
      mainTrackMagnet: true,
      autoSnap: true,
      linkage: true,
      previewAxis: true,
      captionFollow: true,
    },
    playhead: 0,
  })

  const { videoPath, width, height } = await importProjectFileAndExport(page, testInfo, {
    projectFile,
    source: SOURCE_INFO,
    fileName: 'overlay-blend',
    // 主轨 1 段 + 叠加轨 1 段 = 2 个片段条
    clipCount: 2,
    filePath: sourcePath,
  })

  const sourceBase64 = readSourceBase64(sourcePath)
  const probeAt = (time: number, atOpacity = OVERLAY_OPACITY): ComposeFrameProbe => {
    const frames = [{ clipId: mainClip.id, seekTime: clipFrameSourceAt(mainClip, time) }]
    const overlayLocal = time - OVERLAY_START
    if (overlayLocal >= 0 && overlayLocal < OVERLAY_DURATION) {
      frames.push({
        clipId: overlayClip.id,
        seekTime: clipFrameSourceAt(overlayClip, overlayLocal),
      })
    }
    return {
      project: atOpacity === OVERLAY_OPACITY ? project : projectWithOverlay(atOpacity),
      time,
      canvasWidth: width,
      canvasHeight: height,
      sourceBase64,
      sourceName: 'gray.mp4',
      frames,
    }
  }

  const inside: SampleRegion = {
    x: Math.round(width / 2 - 20),
    y: Math.round(height / 2 - 20),
    width: 40,
    height: 40,
  }
  const outside: SampleRegion = { x: 0, y: 0, width: 40, height: 40 }
  const black = { r: 0, g: 0, b: 0 }

  // ---- 1) 画中画内部（t=1）：混合与不透明度都要和预览一致 ----
  const previewInside = await averageComposeFrameColor(page, probeAt(1), inside)
  const exportInside = await averageVideoFrameColor(videoPath, 1, width, height, inside)
  const insideCompare = compareAverageColors(previewInside, exportInside)
  console.log('画中画内部 预览', previewInside, '导出', exportInside, '差值', insideCompare)
  expect(
    insideCompare.maxDelta,
    `画中画内部导出与预览差 ${insideCompare.maxDelta}（delta=${JSON.stringify(insideCompare.delta)}）`,
  ).toBeLessThanOrEqual(PARITY_TOLERANCE)

  // 预览侧先证明：混合 + opacity 的效果足够明显（否则「一致」没有意义）。
  const previewOpaque = await averageComposeFrameColor(page, probeAt(1, 1), inside)
  const effect = compareAverageColors(previewInside, previewOpaque)
  console.log('不透明度对照 预览30%', previewInside, '预览100%', previewOpaque, '差值', effect)
  expect(
    effect.maxDelta,
    '不透明度 30% 与 100%（同为叠加混合）的画面必须有明显差异',
  ).toBeGreaterThan(PARITY_TOLERANCE)
  // 画中画内部也应与外部明显不同（混合真的作用于 PIP 区域）。
  // 30% 不透明度下中灰正片叠底的差值约 19（128 → 108.9），所以阈值取 10。
  const previewOutside = await averageComposeFrameColor(page, probeAt(1), outside)
  expect(
    compareAverageColors(previewInside, previewOutside).maxDelta,
    '画中画内部与外部应有明显差异（混合生效）',
  ).toBeGreaterThan(10)

  // ---- 2) 画中画外部（同一时刻，PIP 之外）：保持主轨原画面 ----
  const exportOutside = await averageVideoFrameColor(videoPath, 1, width, height, outside)
  const outsideCompare = compareAverageColors(previewOutside, exportOutside)
  console.log('画中画外部 预览', previewOutside, '导出', exportOutside, '差值', outsideCompare)
  expect(
    outsideCompare.maxDelta,
    `画中画外部导出与预览差 ${outsideCompare.maxDelta}（delta=${JSON.stringify(outsideCompare.delta)}）`,
  ).toBeLessThanOrEqual(PARITY_TOLERANCE)
  expect(
    compareAverageColors(exportOutside, black).maxDelta,
    '画中画外部不能是黑色（旧实现会整片变黑）',
  ).toBeGreaterThan(100)

  // ---- 3) 片段时间范围之外（t=2.6）：保持主轨原画面 ----
  const outsideTime = 2.6
  const previewAfter = await averageComposeFrameColor(page, probeAt(outsideTime), inside)
  const exportAfter = await averageVideoFrameColor(videoPath, outsideTime, width, height, inside)
  const afterCompare = compareAverageColors(previewAfter, exportAfter)
  console.log('时间外(t=2.6) 预览', previewAfter, '导出', exportAfter, '差值', afterCompare)
  expect(
    afterCompare.maxDelta,
    `时间外导出与预览差 ${afterCompare.maxDelta}（delta=${JSON.stringify(afterCompare.delta)}）`,
  ).toBeLessThanOrEqual(PARITY_TOLERANCE)
  expect(
    compareAverageColors(exportAfter, black).maxDelta,
    '叠加片段时间范围之外不能是黑色',
  ).toBeGreaterThan(100)
})