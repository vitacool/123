import { expect, test } from '@playwright/test'
import { expectClipCount, importFixture, openEditor } from './helpers'

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

/** 拖播放头到片段中部后分割，得到两段。 */
async function splitIntoTwo(page: import('@playwright/test').Page): Promise<void> {
  const bar = page.locator('.clip-bar[data-clip-id]').first()
  await bar.click()
  const box = await bar.boundingBox()
  const handleBox = await page.locator('.playhead-handle').boundingBox()
  if (!box || !handleBox) throw new Error('时间轴元素不可见')
  const startX = handleBox.x + handleBox.width / 2
  const y = handleBox.y + handleBox.height / 2
  await page.mouse.move(startX, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.5, y, { steps: 8 })
  await page.mouse.up()
  const split = page.locator('button[aria-label*="在播放头处分割片段"]').first()
  await expect(split).toBeEnabled()
  await split.click()
  await expectClipCount(page, 2)
}

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

/** 等待 IndexedDB 里同时有草稿记录与素材 blob（自动保存完成）。 */
async function waitForDraftSaved(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const request = indexedDB.open('framecut-drafts')
        request.onerror = () => resolve(false)
        request.onsuccess = () => {
          const db = request.result
          if (!db.objectStoreNames.contains('draft') || !db.objectStoreNames.contains('media')) {
            db.close()
            resolve(false)
            return
          }
          const draftTx = db.transaction('draft', 'readonly')
          const getAll = draftTx.objectStore('draft').getAll()
          getAll.onerror = () => {
            db.close()
            resolve(false)
          }
          getAll.onsuccess = () => {
            if (getAll.result.length === 0) {
              db.close()
              resolve(false)
              return
            }
            const mediaTx = db.transaction('media', 'readonly')
            const count = mediaTx.objectStore('media').count()
            count.onerror = () => {
              db.close()
              resolve(false)
            }
            count.onsuccess = () => {
              const ok = count.result > 0
              db.close()
              resolve(ok)
            }
          }
        }
      }),
    undefined,
    { timeout: 60_000, polling: 500 },
  )
}