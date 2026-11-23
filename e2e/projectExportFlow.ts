import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, type TestInfo } from '@playwright/test'
import { getOutputDimensions } from '../src/editor/core/aspect'
import { serializeProjectFile, type ProjectFile } from '../src/editor/projectFile'
import type { SourceInfo } from '../src/editor/core/types'
import { FIXTURE, expectClipCount, openEditor } from './helpers'

/**
 * 「把工程文件导入编辑器并真实导出 mp4」的共用流程。
 *
 * 供预览/导出对比类用例使用：导入 .framecut.json（重新选择 fixture 素材）→ 打开工程
 * → 走导出对话框 → 保存 mp4，返回视频路径与导出画布尺寸。
 */
export interface ProjectExportResult {
  videoPath: string
  /** 导出画布尺寸（预览对比时的 canvas 尺寸必须与它一致）。 */
  width: number
  height: number
}

export async function importProjectFileAndExport(
  page: Page,
  testInfo: TestInfo,
  options: {
    projectFile: ProjectFile
    /** 素材元信息（用于推导导出尺寸）。 */
    source: SourceInfo
    /** 输出文件名前缀（默认 project）。 */
    fileName?: string
    /** 导入后时间轴应出现的片段数（默认 1）。 */
    clipCount?: number
  },
): Promise<ProjectExportResult> {
  const dir = testInfo.outputDir
  mkdirSync(dir, { recursive: true })
  const baseName = options.fileName ?? 'project'
  const projectPath = join(dir, `${baseName}.framecut.json`)
  writeFileSync(projectPath, serializeProjectFile(options.projectFile))

  await openEditor(page)
  await page.locator('input[data-project-file-input]').setInputFiles(projectPath)
  const dialog = page.locator('[role="dialog"][aria-label="缺失素材"]')
  await expect(dialog).toBeVisible()
  // 对话框里的「选择文件」由用户手势触发（不能逐个 input.click）。
  const chooserPromise = page.waitForEvent('filechooser')
  await dialog.locator('button[data-action="pick"]').first().click()
  const chooser = await chooserPromise
  await chooser.setFiles(FIXTURE)
  await expect(dialog.locator('.project-missing-status').first()).toContainText('已选择')
  await dialog.getByRole('button', { name: /打开工程/ }).click()
  await expectClipCount(page, options.clipCount ?? 1)

  await page.locator('.export-button').click()
  await page.waitForSelector('.export-dialog', { state: 'visible' })
  await page.getByRole('button', { name: '开始导出' }).click()
  const downloadPromise = page.waitForEvent('download', { timeout: 240_000 })
  await page.waitForSelector('.export-done, .export-error', { timeout: 240_000 })
  if ((await page.locator('.export-error').count()) > 0) {
    throw new Error('导出失败：' + (await page.locator('.export-error').innerText()))
  }
  const download = await downloadPromise
  const videoPath = join(dir, `${baseName}.mp4`)
  await download.saveAs(videoPath)

  const { width, height } = getOutputDimensions(
    options.projectFile.project.aspectRatio,
    options.projectFile.project.exportQuality.resolution,
    options.source,
  )
  return { videoPath, width, height }
}