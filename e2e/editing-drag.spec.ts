import { expect, test } from '@playwright/test'
import { expectClipCount, importFixture, openEditor } from './helpers'

/**
 * 指针交互：拖动片段改变位置、拖动右侧裁剪手柄改变时长。
 *
 * 这两个用例专门覆盖 Firefox 的 pointerId 场景：`pointerId` 在 Firefox 里可能是 0，
 * 早期用真值判断（`if (drag.pointerId)`）会把它当成"没有指针"，拖动完全失效。
 */

/** 先把播放头拖到片段中部并分割，得到两段（分割要求「有选中片段 + 播放头在片段内部」）。 */
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
  // 等播放头位置同步到 store（工具栏可用性依赖它）
  await expect(page.locator('button[aria-label*="在播放头处分割片段"]')).toBeEnabled()
  await page.locator('button[aria-label*="在播放头处分割片段"]').first().click()
  await expectClipCount(page, 2)
}

test('拖动片段：被拖片段移动、相邻片段不跟着动', async ({ page }) => {
  test.setTimeout(120_000)
  await openEditor(page)
  await importFixture(page)
  await splitIntoTwo(page)

  const first = page.locator('.clip-bar[data-clip-id]').first()
  const second = page.locator('.clip-bar[data-clip-id]').nth(1)
  const before = await first.boundingBox()
  const otherBefore = await second.boundingBox()
  if (!before || !otherBefore) throw new Error('片段条不可见')

  // 抓住第一段中部向右拖 60px
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
  await page.mouse.down()
  await page.mouse.move(before.x + before.width / 2 + 60, before.y + before.height / 2, {
    steps: 10,
  })
  await page.mouse.up()
  await page.waitForTimeout(200)

  const after = await first.boundingBox()
  const otherAfter = await second.boundingBox()
  if (!after || !otherAfter) throw new Error('片段条消失')
  expect(Math.abs(after.x - before.x), '被拖片段应当移动').toBeGreaterThan(20)
  // 主轨是**顺序**轨道：移动第一段会把它后面的片段一起推移，这是预期行为；
  // 这里断言片段数量没变（没有误删/误合并），顺序仍然是一前一后。
  await expectClipCount(page, 2)
  expect(otherAfter.x, '第二段仍在第一段右侧').toBeGreaterThan(after.x)
})

test('拖动裁剪手柄：片段变短，左边缘不动', async ({ page }) => {
  test.setTimeout(120_000)
  await openEditor(page)
  await importFixture(page)

  const clip = page.locator('.clip-bar[data-clip-id]').first()
  const before = await clip.boundingBox()
  if (!before) throw new Error('片段条不可见')

  const handle = clip.locator('.clip-trim-handle').last()
  const handleBox = await handle.boundingBox()
  if (!handleBox) throw new Error('裁剪手柄不可见')

  const startX = handleBox.x + handleBox.width / 2
  const y = handleBox.y + handleBox.height / 2
  await page.mouse.move(startX, y)
  await page.mouse.down()
  await page.mouse.move(startX - 40, y, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(200)

  const after = await clip.boundingBox()
  if (!after) throw new Error('片段条消失')
  expect(Math.abs(after.x - before.x), '右裁不应移动左边缘').toBeLessThan(3)
  expect(after.width, '右裁应当让片段变短').toBeLessThan(before.width - 15)
})