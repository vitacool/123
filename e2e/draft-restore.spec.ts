import { expect, test } from '@playwright/test'
import {
  expectClipCount,
  importFixture,
  openEditor,
  splitIntoTwo,
  waitForDraftSaved,
} from './helpers'

/**
 * 草稿恢复：编辑 → 自动保存 → 刷新 → 从「最近项目」打开 → 内容回来。
 *
 * 注意 demo 应用启用了项目库：刷新后不会自动恢复，而是打开「最近项目」列表
 * （见 VideoEditor 的 libraryEnabled 分支），所以用例里要点一下项目卡片。
 */
test('刷新后从最近项目打开，草稿内容恢复', async ({ page }) => {
  test.setTimeout(180_000)
  await openEditor(page)
  await importFixture(page)

  // 制造可辨认的编辑：分割成 2 段 + 改名
  await splitIntoTwo(page)
  const renamed = `E2E-${Date.now().toString(36)}`
  await renameProject(page, renamed)

  // 等自动保存真正落盘：draft 记录 + 素材 blob 都在
  await waitForDraftSaved(page)

  await page.reload()
  await openEditor(page)

  // 刷新后列表会自动打开；点同名项目卡片
  await page.locator(`button[aria-label="打开「${renamed}」"]`).click()
  await expectClipCount(page, 2)
  await expect(page.locator('.project-name').first()).toHaveText(renamed)
})

/** 顶栏改名：点击文本 → 内联输入框 → 输入 → 回车。 */
async function renameProject(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.locator('.project-name').first().click()
  const input = page.locator('.project-name-input').first()
  await input.waitFor({ state: 'visible' })
  await input.click()
  await input.press('Control+a')
  await input.fill(name)
  await input.press('Enter')
}
