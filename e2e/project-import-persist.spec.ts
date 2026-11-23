import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import {
  FIXTURE,
  expectClipCount,
  importFixture,
  openEditor,
  splitIntoTwo,
  waitForDraftSaved,
} from './helpers'

/**
 * 工程文件导入后刷新，素材与片段不能丢。
 *
 * 回归背景：`.framecut.json` 只带素材元信息，导入时重新选择出来的 Blob 必须立刻写进
 * IndexedDB。漏写时刷新后 restoreDraft 在 media store 里查不到 Blob，会跳过素材并
 * 剔除引用它的片段 —— 用户看到「素材都不可用，片段全没了」。
 *
 * 「另一台机器」用全新浏览器 context 模拟：IndexedDB 是空的，只有工程文件可用。
 */
test('导入工程文件 → 刷新 → 片段数量不变', async ({ page, browser }, testInfo) => {
  test.setTimeout(240_000)
  await openEditor(page)
  await importFixture(page)
  await splitIntoTwo(page)
  await expectClipCount(page, 2)

  // 等自动保存完成，确保导出的工程文件里就是这两段
  await waitForDraftSaved(page)

  // 导出工程文件（用户拿到 .framecut.json 带到另一台机器）
  await page.locator('.project-menu-button').click()
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
  await page.getByRole('menuitem', { name: '导出工程（.framecut.json）' }).click()
  const download = await downloadPromise
  const projectPath = join(testInfo.outputDir, 'project.framecut.json')
  await download.saveAs(projectPath)

  // 另一台机器：全新 context → 空的 IndexedDB / localStorage
  const baseURL = new URL(page.url()).origin
  const otherContext = await browser.newContext({ baseURL })
  const other = await otherContext.newPage()
  try {
    await openEditor(other)

    // 导入工程文件 → 弹出「缺失素材」对话框（不再逐个弹系统选择框）
    await other.locator('input[data-project-file-input]').setInputFiles(projectPath)
    const dialog = other.locator('[role="dialog"][aria-label="缺失素材"]')
    await expect(dialog).toBeVisible()

    // 用户点某一行的「选择文件」→ 选择框由这个手势触发（用 filechooser API 接管）
    const chooserPromise = other.waitForEvent('filechooser')
    await dialog.locator('button[data-action="pick"]').first().click()
    const chooser = await chooserPromise
    await chooser.setFiles(FIXTURE)
    // 选择后对话框显示「已选择：clip.mp4」
    await expect(dialog.locator('.project-missing-status').first()).toContainText('已选择')

    await dialog.getByRole('button', { name: /打开工程/ }).click()
    await expectClipCount(other, 2)

    // 关键一步：素材 Blob 必须已经落盘，否则刷新后素材和片段都会消失
    await waitForDraftSaved(other)

    await other.reload()
    await other.waitForSelector('.framecut-root')
    // 刷新后「最近项目」自动打开；这个 context 里只有刚导入的项目
    await other.locator('button[aria-label="打开「clip」"]').click()
    await expectClipCount(other, 2)
    await expect(other.locator('.media-card-wrap')).toHaveCount(1)
  } finally {
    await otherContext.close()
  }
})