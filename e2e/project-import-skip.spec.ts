import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import {
  expectClipCount,
  importFixture,
  openEditor,
  splitIntoTwo,
  waitForDraftRecord,
  waitForDraftSaved,
} from './helpers'

/**
 * 「取消/跳过选择素材」不能把导入流程卡死，而且工程必须能打开。
 *
 * 回归背景：旧实现为每个缺失素材逐个 `input.click()`，用户点取消时浏览器不触发
 * change，Promise 永远 pending → 导入卡死。新实现改为对话框 + 取消事件 + 焦点兜底，
 * 并且「全部跳过」后工程照常打开：缺失片段以「素材已移除」占位保留。
 */
test('全部跳过缺失素材，工程仍能打开且片段以占位显示', async ({ page, browser }, testInfo) => {
  test.setTimeout(240_000)
  await openEditor(page)
  await importFixture(page)
  await splitIntoTwo(page)
  await expectClipCount(page, 2)
  await waitForDraftSaved(page)

  // 导出工程文件
  await page.locator('.project-menu-button').click()
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
  await page.getByRole('menuitem', { name: '导出工程（.framecut.json）' }).click()
  const download = await downloadPromise
  const projectPath = join(testInfo.outputDir, 'skip-project.framecut.json')
  await download.saveAs(projectPath)

  // 另一台机器：全新 context（没有素材 Blob）
  const baseURL = new URL(page.url()).origin
  const otherContext = await browser.newContext({ baseURL })
  const other = await otherContext.newPage()
  try {
    await openEditor(other)
    await other.locator('input[data-project-file-input]').setInputFiles(projectPath)

    const dialog = other.locator('[role="dialog"][aria-label="缺失素材"]')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('.project-missing-row')).toHaveCount(1)
    await expect(dialog.locator('.project-missing-name')).toHaveText('clip.mp4')

    // 全部跳过 → 打开工程：不提供任何文件也不能卡住
    await dialog.getByRole('button', { name: '全部跳过并打开' }).click()
    await expect(dialog).toHaveCount(0)

    // 片段数量不变，且两段都是占位（「素材已移除」）
    await expectClipCount(other, 2)
    await expect(other.locator('.clip-bar.is-missing')).toHaveCount(2)
    await expect(other.locator('.clip-missing-label').first()).toHaveText('素材已移除')

    // 占位工程也要能保存（没有素材 blob，只有草稿记录）
    await waitForDraftRecord(other)

    // 刷新后从最近项目打开：占位片段仍在
    await other.reload()
    await other.waitForSelector('.framecut-root')
    await other.locator('button[aria-label="打开「clip」"]').click()
    await expectClipCount(other, 2)
    await expect(other.locator('.clip-bar.is-missing')).toHaveCount(2)
    await expect(other.locator('.media-card-wrap')).toHaveCount(0)
  } finally {
    await otherContext.close()
  }
})