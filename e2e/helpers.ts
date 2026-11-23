import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import type { Page } from '@playwright/test'
import ffmpegPath from 'ffmpeg-static'

/** 测试素材（3 秒彩条 + 440Hz 正弦音），由 scripts/make-test-fixture.mjs 生成。 */
export const FIXTURE = 'tests/e2e/fixtures/clip.mp4'

/** 打开编辑器并等待根节点就绪。 */
export async function openEditor(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForSelector('.framecut-root')
  await page.waitForSelector('.framecut-root.is-theme-ready', { timeout: 20_000 }).catch(() => undefined)
}

/** 通过隐藏的 file input 导入素材，并等待片段出现在时间轴上。 */
export async function importFixture(page: Page, count = 1): Promise<void> {
  await page.locator('input.hidden-file-input').first().setInputFiles(FIXTURE)
  await expectClipCount(page, count)
}

/** 等待时间轴出现 N 个片段条。 */
export async function expectClipCount(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    (expected) => document.querySelectorAll('.clip-bar[data-clip-id]').length === expected,
    count,
    { timeout: 60_000 },
  )
}

/**
 * 通过**真实指针拖拽**把播放头移到「片段宽度的 ratio 位置」。
 *
 * 不用内部 store：既避免给应用加测试钩子，又顺带覆盖 pointer 事件
 * （Firefox 的 pointerId 为 0 时曾导致拖动完全失效）。
 */
export async function dragPlayheadTo(page: Page, ratio: number): Promise<void> {
  const bar = page.locator('.clip-bar[data-clip-id]').first()
  const box = await bar.boundingBox()
  if (!box) throw new Error('找不到片段条，无法定位播放头')
  const handle = page.locator('.playhead-handle')
  const handleBox = await handle.boundingBox()
  if (!handleBox) throw new Error('找不到播放头手柄')
  const startX = handleBox.x + handleBox.width / 2
  const startY = handleBox.y + handleBox.height / 2
  const targetX = box.x + box.width * ratio
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(targetX, startY, { steps: 8 })
  await page.mouse.up()
}

/** 点击 aria-label 含某个短语的按钮（按钮文案是完整句子，如「在播放头处分割片段（Ctrl/⌘ B）」）。 */
export async function clickByAriaContains(page: Page, text: string): Promise<void> {
  await page.locator(`button[aria-label*="${text}"]`).first().click()
}

export interface ProbeResult {
  durationSeconds: number
  hasAudio: boolean
  audioCodec: string | null
  videoCodec: string | null
  sizeBytes: number
}

/**
 * 用真实 ffmpeg 探测导出文件：时长 + 是否含音轨。
 * Node 侧用 ffmpeg-static 比在测试进程里再起 FFmpeg.wasm 更直接可靠。
 */
export function probeMedia(path: string): ProbeResult {
  if (!ffmpegPath) throw new Error('ffmpeg-static 二进制不可用')
  // 用 spawnSync 才能拿到 stderr（ffmpeg 把媒体信息都写在那里）；
  // 只解析 "Stream mapping" **之前**的输入信息，避免把我自己加的 -f null 输出流算进去。
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-i', path, '-f', 'null', '-'], {
    encoding: 'utf8',
  })
  const stderr = String(result.stderr ?? '')
  const inputSection = stderr.split('Stream mapping:')[0] ?? stderr
  const duration = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(inputSection)
  const durationSeconds = duration
    ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
    : Number.NaN
  const videoLine = /Stream #\d+:\d+[^:]*: Video: ([a-z0-9]+)/i.exec(inputSection)
  const audioLine = /Stream #\d+:\d+[^:]*: Audio: ([a-z0-9]+)/i.exec(inputSection)
  return {
    durationSeconds,
    hasAudio: Boolean(audioLine),
    audioCodec: audioLine?.[1] ?? null,
    videoCodec: videoLine?.[1] ?? null,
    sizeBytes: statSync(path).size,
  }
}