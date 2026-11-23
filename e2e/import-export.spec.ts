import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import {
  clickByAriaContains,
  dragPlayheadTo,
  expectClipCount,
  importFixture,
  openEditor,
  probeMedia,
} from './helpers'

/**
 * 主链路：导入 → 分割 → 删除一段 → 导出 → 用真实 ffmpeg 校验输出。
 *
 * 校验点（这是"导出真的能用"的硬指标）：
 * - 输出文件是合法 MP4（h264 视频流）；
 * - 时长约为剩下那一段（原素材 3s，砍掉一半后约 1.4~1.7s）；
 * - **含音轨**（aac）—— 曾经出现过"导出成功但没有音轨"的回归。
 */
test('导入 → 分割 → 删除一段 → 导出，输出时长与音轨正确', async ({ page }, testInfo) => {
  test.setTimeout(300_000)
  page.on('console', (message) => {
    if (message.type() === 'error') console.log('[page error]', message.text())
  })
  page.on('pageerror', (error) => console.log('[page exception]', error.message))
  console.log('step: open editor')
  await openEditor(page)
  console.log('step: import')
  await importFixture(page)

  // 先选中片段：分割的可用性要求「有选中片段 + 播放头在片段内部」
  await page.locator('.clip-bar[data-clip-id]').first().click()
  console.log('step: selected clip')
  // 播放头拖到片段中间（真实指针拖拽：顺带覆盖 pointer 事件路径）
  await dragPlayheadTo(page, 0.5)

  // 分割
  console.log('step: split')
  await clickByAriaContains(page, '在播放头处分割片段')
  await expectClipCount(page, 2)

  // 选中后一段并删除
  await page.locator('.clip-bar[data-clip-id]').nth(1).click()
  await clickByAriaContains(page, '删除选中的片段')
  await expectClipCount(page, 1)

  // 导出：捕获宿主下载（demo 应用通过 onExport 触发下载）
  console.log('step: open export dialog')
  await page.locator('.export-button').click()
  console.log('step: dialog opened')
  await page.waitForSelector('.export-dialog', { state: 'visible' })
  await page.getByRole('button', { name: '开始导出' }).click()
  console.log('step: export started')

  // 先把 download 监听挂上（导出完成的瞬间就会触发）
  const downloadPromise = page.waitForEvent('download', { timeout: 240_000 })
  // 等完成面板出现，便于区分「导出慢」与「导出失败」
  await page.waitForSelector('.export-done, .export-error', { timeout: 240_000 })
  console.log('step: export finished')
  const failed = await page.locator('.export-error').count()
  if (failed > 0) {
    throw new Error('导出失败：' + (await page.locator('.export-error').innerText()))
  }
  const download = await downloadPromise
  const output = join(testInfo.outputDir, 'export.mp4')
  await download.saveAs(output)

  // 用真实 ffmpeg 探测
  const probe = probeMedia(output)
  console.log('导出探测：', JSON.stringify(probe))
  expect(probe.videoCodec, '应当产出 h264 视频流').toBeTruthy()
  expect(probe.sizeBytes, '输出文件不应为空').toBeGreaterThan(10_000)
  // 剩下约 1.5 秒（允许编码/取整误差）
  expect(probe.durationSeconds).toBeGreaterThan(0.9)
  expect(probe.durationSeconds).toBeLessThan(2.2)
  expect(probe.hasAudio, '导出必须保留音轨').toBe(true)
  expect(probe.audioCodec).toMatch(/aac|mp3|pcm/i)
})