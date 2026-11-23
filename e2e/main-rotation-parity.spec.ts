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
 * 主轨片段旋转后，四角必须是**背景色**，不能是黑色。
 *
 * 预览：画布先铺背景（这里是纯红），再画旋转后的片段，画面外的角落露出红色。
 * 导出原来用 `rotate=...:c=black` 把四角写成不透明黑；修复后旋转输出透明角并叠到
 * 背景层。用例直接取左上/右上角落区域，比较预览与导出的平均色。
 */
const SOURCE_WIDTH = 320
const SOURCE_HEIGHT = 180
const DURATION = 3
const LOCAL_TIME = 1
const BACKGROUND_HEX = '#c81e1e'
const BACKGROUND: CanvasBackground = { type: 'color', color: BACKGROUND_HEX }
const SOURCE_URL = 'blob:rotation-source'
const SOURCE_INFO: SourceInfo = {
  url: SOURCE_URL,
  name: 'clip.mp4',
  size: 0,
  duration: DURATION,
  width: SOURCE_WIDTH,
  height: SOURCE_HEIGHT,
}

function colorOf(hex: string): { r: number; g: number; b: number } {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!match) throw new Error(`非法颜色：${hex}`)
  return {
    r: Number.parseInt(match[1].slice(0, 2), 16),
    g: Number.parseInt(match[1].slice(2, 4), 16),
    b: Number.parseInt(match[1].slice(4, 6), 16),
  }
}

test('主轨旋转后四角导出为背景色（不是黑色）', async ({ page }, testInfo) => {
  test.setTimeout(300_000)
  const base = createInitialProject({ url: SOURCE_URL, duration: DURATION }, 'clip-rotated')
  const clip = {
    ...base.clips[0],
    rotation: 30,
    scale: 0.6,
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
    fileName: 'rotation',
  })

  const probe: ClipRenderProbe = {
    clip,
    background: BACKGROUND,
    canvasWidth: width,
    canvasHeight: height,
    localTime: LOCAL_TIME,
    sourceBase64: readSourceBase64(FIXTURE),
    sourceName: 'clip.mp4',
  }
  const red = colorOf(BACKGROUND_HEX)
  const black = { r: 0, g: 0, b: 0 }
  const cornerSize = 40
  const corners = [
    { name: '左上角', x: 0, y: 0, width: cornerSize, height: cornerSize },
    { name: '右上角', x: width - cornerSize, y: 0, width: cornerSize, height: cornerSize },
    { name: '左下角', x: 0, y: height - cornerSize, width: cornerSize, height: cornerSize },
    { name: '右下角', x: width - cornerSize, y: height - cornerSize, width: cornerSize, height: cornerSize },
  ]

  for (const corner of corners) {
    const preview = await averageClipRenderColor(page, probe, corner)
    const exported = await averageVideoFrameColor(videoPath, LOCAL_TIME, width, height, corner)
    const cmp = compareAverageColors(preview, exported)
    console.log(corner.name, '预览角', preview, '导出角', exported, '差值', cmp)

    // 预览语义：角落就是背景色（canvas 填充是精确值）。
    expect(
      compareAverageColors(preview, red).maxDelta,
      `${corner.name}预览应为背景色 ${BACKGROUND_HEX}`,
    ).toBeLessThanOrEqual(10)
    // 导出：与预览一致（错误实现这里会是黑色，差 ~200）。
    expect(
      cmp.maxDelta,
      `${corner.name}导出与预览差 ${cmp.maxDelta}（delta=${JSON.stringify(cmp.delta)}）`,
    ).toBeLessThanOrEqual(PARITY_TOLERANCE)
    // 直接回归守卫：不能是黑色。
    expect(
      compareAverageColors(exported, black).maxDelta,
      `${corner.name}导出不应是黑色`,
    ).toBeGreaterThan(100)
  }
})