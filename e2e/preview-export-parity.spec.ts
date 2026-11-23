import { expect, test } from '@playwright/test'
import { createInitialProject } from '../src/editor/core/operations'
import { createProjectFile } from '../src/editor/projectFile'
import type { CanvasBackground, SourceInfo } from '../src/editor/core/types'
import { FIXTURE } from './helpers'
import { importProjectFileAndExport } from './projectExportFlow'
import {
  PARITY_TOLERANCE,
  averageClipRenderColor,
  averageVideoFrameColor,
  compareAverageColors,
  readSourceBase64,
  type ClipRenderProbe,
} from './previewExportParity'

/**
 * 预览与导出对比：主轨片段的「不透明度 + 混合模式」必须在导出里也生效。
 *
 * 同一工程、同一时间点（1s）：
 * - 预览：真实 clipRender 画到 canvas 的平均色；
 * - 导出：真实 ffmpeg 导出的 mp4 在该时刻的平均色。
 * 两者色差应在 {@link PARITY_TOLERANCE} 内；同时断言这个效果本身足够明显
 * （与「不透明 + 正常模式」的画面有显著差异），避免两个错误答案互相抵消。
 */
const SOURCE_WIDTH = 320
const SOURCE_HEIGHT = 180
const DURATION = 3
const LOCAL_TIME = 1
const BACKGROUND: CanvasBackground = { type: 'color', color: '#1b3b6f' }
const SOURCE_URL = 'blob:parity-source'
const SOURCE_INFO: SourceInfo = {
  url: SOURCE_URL,
  name: 'clip.mp4',
  size: 0,
  duration: DURATION,
  width: SOURCE_WIDTH,
  height: SOURCE_HEIGHT,
}

test('主轨不透明度 + 混合模式：预览与导出平均色一致', async ({ page }, testInfo) => {
  test.setTimeout(300_000)
  const base = createInitialProject({ url: SOURCE_URL, duration: DURATION }, 'clip-1')
  const clip = {
    ...base.clips[0],
    opacity: 0.6,
    blendMode: 'multiply' as const,
  }
  const project = {
    ...base,
    canvasBackground: BACKGROUND,
    clips: [clip],
    exportQuality: { ...base.exportQuality, resolution: '480p' as const },
  }
  const projectFile = createProjectFile({
    project,
    assets: [
      {
        id: 'asset-1',
        url: SOURCE_URL,
        name: 'clip.mp4',
        size: 0,
        duration: DURATION,
        width: SOURCE_WIDTH,
        height: SOURCE_HEIGHT,
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
    fileName: 'parity',
  })

  // ---- 预览：真实 clipRender ----
  const probeOf = (overrides: Partial<ClipRenderProbe['clip']>): ClipRenderProbe => ({
    clip: { ...clip, ...overrides },
    background: BACKGROUND,
    canvasWidth: width,
    canvasHeight: height,
    localTime: LOCAL_TIME,
    sourceBase64: readSourceBase64(FIXTURE),
    sourceName: 'clip.mp4',
  })
  const preview = await averageClipRenderColor(page, probeOf({}))
  // 对照组：不透明 + 正常模式（旧导出行为）——与真实效果差异必须远大于容差。
  const opaque = await averageClipRenderColor(
    page,
    probeOf({ opacity: 1, blendMode: 'normal' }),
  )

  // ---- 导出：真实 ffmpeg 解码同一时刻 ----
  const exported = averageVideoFrameColor(videoPath, LOCAL_TIME, width, height)
  const cmp = compareAverageColors(preview, exported)
  const control = compareAverageColors(preview, opaque)
  console.log('预览平均色', preview, '导出平均色', exported, '差值', cmp, '对照差值', control)

  expect(
    control.maxDelta,
    '不透明度+正片叠底的效果必须足够明显，否则对比失去意义',
  ).toBeGreaterThan(PARITY_TOLERANCE)
  expect(
    cmp.maxDelta,
    `预览与导出的平均色差 ${cmp.maxDelta} 超出容差 ${PARITY_TOLERANCE}（delta=${JSON.stringify(cmp.delta)}）`,
  ).toBeLessThanOrEqual(PARITY_TOLERANCE)
})