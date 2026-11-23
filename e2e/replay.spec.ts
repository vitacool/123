import { expect, test } from '@playwright/test'
import { importFixture, openEditor } from './helpers'

/**
 * 重播（回归）：点「重播」必须从 0 重新播放。
 *
 * 曾经的问题：播放中点重播时 `isPlaying` 已经是 true，播放 effect 不会重跑，
 * 运行中的 rAF 仍按旧锚点往前推，把刚归零的 playhead 覆盖回去 —— 看起来「点重播没反应」。
 * 修复方式：预览循环检测到 store 里的 playhead 被外部改过（与自己的上次发布值差 >0.25s）
 * 就重新锚定时钟。
 */

const playheadLeft = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const playhead = document.querySelector('.playhead') as HTMLElement | null
    return Number((/([\d.]+)px/.exec(playhead?.style.left ?? '') ?? [])[1] ?? 0)
  })

test('播放结束后点重播：从头开始', async ({ page }) => {
  test.setTimeout(120_000)
  await openEditor(page)
  await importFixture(page)

  await page.locator('button[aria-label="播放"]').first().click()
  // 素材 3 秒：等它自然播完（播放结束按钮会变回「播放」）
  await expect(page.locator('button[aria-label="播放"]')).toBeVisible({ timeout: 20_000 })
  const ended = await playheadLeft(page)
  expect(ended, '应当播到接近末尾').toBeGreaterThan(200)

  await page.locator('button[aria-label="重播"]').first().click()
  await page.waitForTimeout(400)
  const afterReplay = await playheadLeft(page)
  expect(afterReplay, '重播后应当回到起点附近').toBeLessThan(ended - 100)
  await expect(page.locator('button[aria-label="暂停"]'), '重播后在播放中').toBeVisible()
})

test('播放中点重播：立即回到开头并继续播放', async ({ page }) => {
  test.setTimeout(120_000)
  await openEditor(page)
  await importFixture(page)

  await page.locator('button[aria-label="播放"]').first().click()
  await page.waitForTimeout(900)
  const before = await playheadLeft(page)
  expect(before, '此时应当已经播了一段').toBeGreaterThan(12 + 40)

  await page.locator('button[aria-label="重播"]').first().click()
  await page.waitForTimeout(400)
  const after = await playheadLeft(page)
  expect(after, '重播必须回到起点附近（而不是接着往前跑）').toBeLessThan(before - 40)
  expect(after, '重播后仍在推进（不是停住）').toBeGreaterThan(12)

  // 再等一会，确认确实在继续播放
  await page.waitForTimeout(600)
  const later = await playheadLeft(page)
  expect(later, '重播后应当继续向前推进').toBeGreaterThan(after + 10)
})