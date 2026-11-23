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
 * 带关键帧的片段在导出前会被逐帧烘焙成中间视频（蒙版 / 抠像已经画进画面）。
 * 如果烘焙后还留着 mask / chromaKey，exportPlan 会**再做一遍**：
 * - 蒙版按画布坐标二次裁切，画面被切掉一部分甚至整块消失；
 * - 抠像对合成后的帧再执行一次。
 *
 * 这两个用例用「预览 vs 导出」对比覆盖：
 * 1. 位置关键帧 + 矩形蒙版（主轨，位移让两次蒙版的区域明显不同）；
 * 2. 缩放关键帧 + 色度抠像（绿幕素材，红块保留）。
 */
const WIDTH = 320
const HEIGHT = 180
const DURATION = 3
const TIME = 1
const BLUE_SOURCE = 'blob:mask-source'
const GREEN_SOURCE = 'blob:chroma-source'

function runFfmpeg(args: string[]): void {
  if (!ffmpegPath) throw new Error('ffmpeg-static 二进制不可用')
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`生成测试素材失败：${String(result.stderr)}`)
}

/** 纯色（可选叠加一个色块）的 3 秒测试视频。 */
function makeSource(path: string, color: string, box?: { color: string; x: number; y: number; w: number; h: number }): void {
  const videoFilter = box
    ? `drawbox=x=${box.x}:y=${box.y}:w=${box.w}:h=${box.h}:color=${box.color}:t=fill,format=yuv420p`
    : 'format=yuv420p'
  runFfmpeg([
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=${WIDTH}x${HEIGHT}:r=30:d=${DURATION}`,
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=stereo',
    '-vf',
    videoFilter,
    '-t',
    String(DURATION),
    '-shortest',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    path,
  ])
}

function projectFileFor(options: {
  clip: Clip
  background: CanvasBackground
  sourceUrl: string
  sourceName: string
  sourcePath: string
}): ReturnType<typeof createProjectFile> {
  const base = createInitialProject({ url: options.sourceUrl, duration: DURATION }, options.clip.id)
  const project = {
    ...base,
    canvasBackground: options.background,
    clips: [{ ...options.clip, sourceUrl: options.sourceUrl, sourceStart: 0, sourceEnd: DURATION }],
    exportQuality: { ...base.exportQuality, resolution: '480p' as const },
  }
  // 素材大小用真实文件大小，便于 readAssetFile 正常探测（不影响像素）。
  return createProjectFile({
    project,
    assets: [
      {
        id: 'asset-1',
        url: options.sourceUrl,
        name: options.sourceName,
        size: 0,
        duration: DURATION,
        width: WIDTH,
        height: HEIGHT,
        kind: 'video',
        local: true,
      },
    ],
    sourceUrl: options.sourceUrl,
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
}

function probeFor(options: {
  clip: Clip
  project: ReturnType<typeof projectFileFor>['project']
  sourceBase64: string
  sourceName: string
  width: number
  height: number
}): ComposeFrameProbe {
  return {
    project: options.project,
    time: TIME,
    canvasWidth: options.width,
    canvasHeight: options.height,
    sourceBase64: options.sourceBase64,
    sourceName: options.sourceName,
    frames: [{ clipId: options.clip.id, seekTime: clipFrameSourceAt(options.clip, TIME) }],
  }
}

test('位置关键帧 + 矩形蒙版：导出不应二次套蒙版', async ({ page }, testInfo) => {
  test.setTimeout(300_000)
  mkdirSync(testInfo.outputDir, { recursive: true })
  const sourcePath = join(testInfo.outputDir, 'mask-source.mp4')
  makeSource(sourcePath, '0x3366cc')

  const clip: Clip = createClip(
    BLUE_SOURCE,
    0,
    DURATION,
    {
      // 位置关键帧 → 触发逐帧烘焙；位移让「源空间蒙版」和「画布空间蒙版」明显不同。
      anim: {
        'position.x': [
          { t: 0, value: 0.15, ease: 'linear' },
          { t: 1, value: 0.25, ease: 'linear' },
        ],
      },
      scale: 0.6,
      mask: {
        shape: 'rect',
        // ClipMask 的 x/y 是**中心**归一化坐标（rect 从 cx±w/2 画）。
        // 中心 0.25、宽 0.5 → 覆盖画面左半边 0..0.5。
        x: 0.25,
        y: 0.5,
        width: 0.5,
        height: 1,
        rotation: 0,
        feather: 0,
        invert: false,
      },
    },
    'mask-clip',
  )
  const background: CanvasBackground = { type: 'color', color: '#c81e1e' }
  const projectFile = projectFileFor({
    clip,
    background,
    sourceUrl: BLUE_SOURCE,
    sourceName: 'mask-source.mp4',
    sourcePath,
  })

  const { videoPath, width, height } = await importProjectFileAndExport(page, testInfo, {
    projectFile,
    source: {
      url: BLUE_SOURCE,
      name: 'mask-source.mp4',
      size: 0,
      duration: DURATION,
      width: WIDTH,
      height: HEIGHT,
    } satisfies SourceInfo,
    fileName: 'mask-parity',
    filePath: sourcePath,
  })

  const sourceBase64 = readSourceBase64(sourcePath)
  const probe = probeFor({
    clip,
    project: projectFile.project,
    sourceBase64,
    sourceName: 'mask-source.mp4',
    width,
    height,
  })

  // t=1 时片段位置约 0.183（0.15→0.25 的 1/3），画面占 x≈0.383–0.983；
  // 源空间蒙版保留左半边（x≈0.383–0.683）。取 x≈0.55–0.62：
  // 预览是画面（蓝），若导出二次套「画布左半边」蒙版则会被裁成背景（红）。
  const kept: SampleRegion = {
    x: Math.round(width * 0.55),
    y: Math.round(height * 0.45),
    width: Math.max(8, Math.round(width * 0.07)),
    height: Math.round(height * 0.1),
  }
  const backgroundRegion: SampleRegion = {
    x: Math.round(width * 0.04),
    y: Math.round(height * 0.45),
    width: Math.round(width * 0.07),
    height: Math.round(height * 0.1),
  }

  const previewKept = await averageComposeFrameColor(page, probe, kept)
  const exportKept = await averageVideoFrameColor(videoPath, TIME, width, height, kept)
  const previewBackground = await averageComposeFrameColor(page, probe, backgroundRegion)
  const exportBackground = await averageVideoFrameColor(
    videoPath,
    TIME,
    width,
    height,
    backgroundRegion,
  )
  console.log(
    '蒙版保留区 预览', previewKept, '导出', exportKept,
    '背景区 预览', previewBackground, '导出', exportBackground,
  )

  // 预览语义自检：保留区是画面（蓝），背景区是纯色背景（红）。
  expect(previewKept.b, '预览保留区应为蓝色画面').toBeGreaterThan(150)
  expect(previewBackground.r, '预览背景区应为红色背景').toBeGreaterThan(150)

  // 导出不得二次套蒙版：保留区必须仍是画面，而不是被裁成背景。
  expect(
    compareAverageColors(previewKept, exportKept).maxDelta,
    '蒙版保留区导出与预览不一致（二次蒙版会把它裁掉）',
  ).toBeLessThanOrEqual(PARITY_TOLERANCE)
  expect(exportKept.b, '导出保留区不应变成背景色').toBeGreaterThan(150)
  expect(
    compareAverageColors(previewBackground, exportBackground).maxDelta,
    '蒙版外背景区导出与预览不一致',
  ).toBeLessThanOrEqual(PARITY_TOLERANCE)
})

test('缩放关键帧 + 色度抠像：导出不应再抠一次', async ({ page }, testInfo) => {
  test.setTimeout(300_000)
  mkdirSync(testInfo.outputDir, { recursive: true })
  const sourcePath = join(testInfo.outputDir, 'chroma-source.mp4')
  makeSource(sourcePath, '0x00ff00', { color: '0xcc2222', x: 80, y: 45, w: 160, h: 90 })

  const clip: Clip = createClip(
    GREEN_SOURCE,
    0,
    DURATION,
    {
      // 缩放关键帧 → 触发烘焙。
      anim: {
        scale: [
          { t: 0, value: 0.8, ease: 'linear' },
          { t: 1, value: 0.9, ease: 'linear' },
        ],
      },
      chromaKey: { color: '#00ff00', similarity: 0.1, blend: 0.05, spill: 0.1 },
    },
    'chroma-clip',
  )
  const background: CanvasBackground = { type: 'color', color: '#1b3b6f' }
  const projectFile = projectFileFor({
    clip,
    background,
    sourceUrl: GREEN_SOURCE,
    sourceName: 'chroma-source.mp4',
    sourcePath,
  })

  const { videoPath, width, height } = await importProjectFileAndExport(page, testInfo, {
    projectFile,
    source: {
      url: GREEN_SOURCE,
      name: 'chroma-source.mp4',
      size: 0,
      duration: DURATION,
      width: WIDTH,
      height: HEIGHT,
    } satisfies SourceInfo,
    fileName: 'chroma-parity',
    filePath: sourcePath,
  })

  const sourceBase64 = readSourceBase64(sourcePath)
  const probe = probeFor({
    clip,
    project: projectFile.project,
    sourceBase64,
    sourceName: 'chroma-source.mp4',
    width,
    height,
  })

  // t=1 时缩放约 0.833：画面占中央 ~266×150（x≈27–293，y≈15–165）。
  const keyedRegion: SampleRegion = {
    x: Math.round(width * 0.08),
    y: Math.round(height * 0.45),
    width: Math.round(width * 0.1),
    height: Math.round(height * 0.1),
  }
  const boxRegion: SampleRegion = {
    x: Math.round(width * 0.45),
    y: Math.round(height * 0.45),
    width: Math.round(width * 0.1),
    height: Math.round(height * 0.1),
  }

  const previewKeyed = await averageComposeFrameColor(page, probe, keyedRegion)
  const exportKeyed = await averageVideoFrameColor(videoPath, TIME, width, height, keyedRegion)
  const previewBox = await averageComposeFrameColor(page, probe, boxRegion)
  const exportBox = await averageVideoFrameColor(videoPath, TIME, width, height, boxRegion)
  console.log(
    '抠像区 预览', previewKeyed, '导出', exportKeyed,
    '保留块 预览', previewBox, '导出', exportBox,
  )

  // 预览语义自检：绿幕区域被抠掉、露出蓝色背景；红块保留。
  expect(previewKeyed.b, '预览抠像区应露出蓝色背景').toBeGreaterThan(80)
  expect(previewKeyed.g, '预览抠像区不应还是绿色').toBeLessThan(120)
  expect(previewBox.r, '预览保留块应偏红').toBeGreaterThan(150)

  expect(
    compareAverageColors(previewKeyed, exportKeyed).maxDelta,
    '抠像区导出与预览不一致（二次抠像会误伤合成帧）',
  ).toBeLessThanOrEqual(PARITY_TOLERANCE)
  expect(
    compareAverageColors(previewBox, exportBox).maxDelta,
    '保留块导出与预览不一致',
  ).toBeLessThanOrEqual(PARITY_TOLERANCE)
})