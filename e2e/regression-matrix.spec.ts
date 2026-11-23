import { expect, test, type Page } from '@playwright/test'
import { openEditor, expectClipCount } from './helpers'

/**
 * 回归矩阵：把「诊断报告」里那批被真实用户踩到的问题固化成 e2e。
 *
 * 这些用例的共同点：**都不需要 FFmpeg 导出**，所以跑得快（秒级），
 * 适合当每次改动后的第一道防线。导出相关的用例仍在 import-export.spec.ts。
 *
 * 每条用例对应报告里的编号：
 * - P0-1 快捷键作用域 / P0-2 撤销后选中 / P0-3 接缝裁剪 / P0-4 图片片段 / P0-5 撤销不毁素材
 * - P2-1 刷新丢编辑 / P2-7 窄片段手柄 / P2-11 导出区间（store 层已在单测覆盖）
 */

const FIXTURE = 'tests/e2e/fixtures/clip.mp4'
const STILL = 'tests/e2e/fixtures/still.png'

const timecode = (page: Page) =>
  page.evaluate(() => document.querySelector('.timecode')?.textContent?.trim() ?? '')

/** 剪辑段宽度（px），用于断言裁剪/拖动是否真的生效。 */
const clipBoxes = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.clip-bar[data-clip-id]')).map((el) => {
      const rect = el.getBoundingClientRect()
      return { x: Math.round(rect.x), width: Math.round(rect.width) }
    }),
  )

/** 预览画布里「非黑像素占比」，用来判断是不是黑帧。 */
const canvasInk = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.querySelector('canvas.preview-canvas') as HTMLCanvasElement | null
    if (!canvas || !canvas.width) return null
    const off = document.createElement('canvas')
    off.width = canvas.width
    off.height = canvas.height
    const ctx = off.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(canvas, 0, 0)
    const { data } = ctx.getImageData(0, 0, off.width, off.height)
    let ink = 0
    for (let i = 0; i < data.length; i += 4) {
      if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] > 8) ink += 1
    }
    return ink / (data.length / 4)
  })

const selectFirstClip = async (page: Page) => {
  await page.locator('.clip-bar[data-clip-id]').first().click()
  await page.waitForTimeout(200)
}

/** 把播放头拖到第一个片段宽度的 ratio 处（真实指针拖拽）。 */
const dragPlayhead = async (page: Page, ratio: number) => {
  const bar = await page.locator('.clip-bar[data-clip-id]').first().boundingBox()
  const handle = await page.locator('.playhead-handle').first().boundingBox()
  if (!bar || !handle) throw new Error('时间轴元素不可见')
  const y = handle.y + handle.height / 2
  await page.mouse.move(handle.x + handle.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(bar.x + bar.width * ratio, y, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(250)
}

test.describe('回归矩阵（P0）', () => {
  test('P0-1 导入后不点任何地方，空格就能播放', async ({ page }) => {
    await openEditor(page)
    await page.locator('input.hidden-file-input').first().setInputFiles(FIXTURE)
    await expectClipCount(page, 1)
    // 关键：**不点击编辑器**，直接按空格（真实用户导入完的第一反应）
    const before = await timecode(page)
    await page.keyboard.press('Space')
    await page.waitForTimeout(1200)
    const after = await timecode(page)
    expect(after).not.toBe(before)
    expect(await page.evaluate(() => document.body.innerText.includes('播放中'))).toBe(true)
    await page.keyboard.press('Space')
  })

  test('P0-1b 焦点停在隐藏文件输入框时，空格/Delete 仍然有效', async ({ page }) => {
    await openEditor(page)
    await page.locator('input.hidden-file-input').first().setInputFiles(FIXTURE)
    await expectClipCount(page, 1)
    await selectFirstClip(page)

    // 模拟「系统文件选择框返回后焦点留在 input 上」
    await page.locator('input.hidden-file-input').first().focus()
    await page.keyboard.press('Space')
    await page.waitForTimeout(1000)
    expect(await page.evaluate(() => document.body.innerText.includes('播放中'))).toBe(true)
    await page.keyboard.press('Space')
    await page.waitForTimeout(200)

    await page.locator('input.hidden-file-input').first().focus()
    await page.keyboard.press('Delete')
    await page.waitForTimeout(500)
    await expectClipCount(page, 0)
  })

  test('P0-2 分割后撤销：选区仍有效，紧接着 Delete 能删掉', async ({ page }) => {
    await openEditor(page)
    await page.locator('input.hidden-file-input').first().setInputFiles(FIXTURE)
    await expectClipCount(page, 1)
    await selectFirstClip(page)
    await dragPlayhead(page, 0.5)

    await page.keyboard.press('Control+b')
    await expectClipCount(page, 2)

    await page.keyboard.press('Control+z')
    await expectClipCount(page, 1)
    // 撤销后必须仍有选中（否则 Delete / 分割会静默失效）
    await expect(page.locator('.clip-bar[data-clip-id].is-selected')).toHaveCount(1)

    await page.keyboard.press('Delete')
    await expectClipCount(page, 0)
  })

  test('P0-3 接缝处可以裁剪（转场标记不再抢命中）', async ({ page }) => {
    await openEditor(page)
    await page.locator('input.hidden-file-input').first().setInputFiles(FIXTURE)
    await expectClipCount(page, 1)
    await selectFirstClip(page)
    await dragPlayhead(page, 0.5)
    await page.keyboard.press('Control+b')
    await expectClipCount(page, 2)

    const before = await clipBoxes(page)
    const seam = before[1].x
    // 抓左段右手柄，向左拖 30px（y 取片段中下部，避开顶部 14px 的转场标记）
    const y = await page.evaluate(() => {
      const el = document.querySelector('.clip-bar[data-clip-id]')
      const rect = el!.getBoundingClientRect()
      return rect.y + rect.height * 0.72
    })
    await page.mouse.move(seam - 4, y)
    await page.mouse.down()
    await page.mouse.move(seam - 34, y, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(500)

    const after = await clipBoxes(page)
    expect(after[0].width, '左段应该被裁短').toBeLessThan(before[0].width)
  })

  test('P0-5 删片段后删素材再撤销：素材回库、画面不黑', async ({ page }) => {
    await openEditor(page)
    await page.locator('input.hidden-file-input').first().setInputFiles(FIXTURE)
    await expectClipCount(page, 1)
    await selectFirstClip(page)

    await page.keyboard.press('Delete')
    await expectClipCount(page, 0)

    await page.locator('.media-card-delete').first().click({ force: true })
    await page.waitForTimeout(500)

    // 点回时间轴恢复焦点，再撤销两次（片段删除 + 素材删除各一步）
    await page.locator('.timeline-shell').click({ position: { x: 200, y: 30 } })
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(600)

    await expectClipCount(page, 1)
    // 素材必须回库，否则片段显示「素材已移除」且画面全黑
    await expect(page.locator('.media-card')).toHaveCount(1)
    expect(await page.evaluate(() => document.body.innerText.includes('素材已移除'))).toBe(false)
    const ink = await canvasInk(page)
    expect(ink, '撤销后预览不应是黑帧').toBeGreaterThan(0.3)
  })
})

test.describe('回归矩阵（图片 / 手感 / 持久化）', () => {
  test('P0-4 图片片段可拉长，且播放时播放头推进、画面有内容', async ({ page }) => {
    await openEditor(page)
    await page.locator('input.hidden-file-input').first().setInputFiles(STILL)
    await expectClipCount(page, 1)
    await selectFirstClip(page)

    const before = await clipBoxes(page)
    const handle = page.locator('.clip-bar[data-clip-id]').first().locator('.clip-trim-handle.is-right')
    const box = await handle.boundingBox()
    expect(box, '图片片段应有右裁剪手柄').toBeTruthy()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.down()
    await page.mouse.move(box!.x + box!.width / 2 + 80, box!.y + box!.height / 2, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(500)

    const after = await clipBoxes(page)
    expect(after[0].width, '图片片段应能拉长（不再锁死 3 秒）').toBeGreaterThan(before[0].width)

    // 回到 0 再播放：时间码必须推进（修前会永久卡在 0）
    await page.keyboard.press('Home')
    await page.waitForTimeout(200)
    await page.locator('.transport-play').first().click()
    await page.waitForTimeout(1200)
    const tc = await timecode(page)
    expect(tc).not.toBe('00:00:00:00')
    const ink = await canvasInk(page)
    expect(ink, '图片应该被画出来').toBeGreaterThan(0.5)
    await page.locator('.transport-play').first().click().catch(() => undefined)
  })

  test('P2-7 窄片段不渲染裁剪手柄，仍然可以拖动', async ({ page }) => {
    await openEditor(page)
    await page.locator('input.hidden-file-input').first().setInputFiles(FIXTURE)
    await expectClipCount(page, 1)
    await selectFirstClip(page)
    // 切出一个很短的片段
    await dragPlayhead(page, 0.12)
    await page.keyboard.press('Control+b')
    await expectClipCount(page, 2)

    // 缩到最小缩放，让第一段变成 < 26px
    const zoomOut = page.locator('button[aria-label="缩小时间轴"]').first()
    for (let i = 0; i < 24; i += 1) {
      if (await zoomOut.isDisabled().catch(() => true)) break
      await zoomOut.click({ force: true }).catch(() => undefined)
      await page.waitForTimeout(40)
    }
    await page.waitForTimeout(400)

    const narrow = await page.evaluate(() => {
      const bars = Array.from(document.querySelectorAll('.clip-bar[data-clip-id]'))
      const el = bars[0] as HTMLElement
      const rect = el.getBoundingClientRect()
      const handles = Array.from(el.querySelectorAll('.clip-trim-handle'))
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height * 0.72)
      return {
        width: Math.round(rect.width),
        handlesHidden: handles.length > 0 && handles.every((h) => getComputedStyle(h).display === 'none'),
        hitTag: hit ? `${hit.tagName.toLowerCase()}.${String(hit.className)}` : '',
      }
    })
    test.skip(narrow.width >= 26, `当前缩放没能把片段压到 26px 以下（${narrow.width}px）`)
    expect(narrow.handlesHidden, '窄片段的手柄应隐藏').toBe(true)
    expect(narrow.hitTag).toContain('clip-bar')

    // 仍然可以拖动（位置会变）
    const before = await clipBoxes(page)
    const y = await page.evaluate(() => {
      const rect = (document.querySelector('.clip-bar[data-clip-id]') as HTMLElement).getBoundingClientRect()
      return rect.y + rect.height * 0.72
    })
    const center = before[0].x + before[0].width / 2
    await page.mouse.move(center, y)
    await page.mouse.down()
    await page.mouse.move(center + 40, y, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(400)
    const after = await clipBoxes(page)
    expect(after[0].x, '窄片段应该能拖动').not.toBe(before[0].x)
  })

  test('P2-1 编辑后立刻刷新（防抖窗口内）不丢改动', async ({ page }) => {
    await openEditor(page)
    await page.locator('input.hidden-file-input').first().setInputFiles(FIXTURE)
    await expectClipCount(page, 1)
    // 等首轮草稿落盘，保证项目在「最近项目」里存在
    await page.waitForTimeout(2200)
    const projectName = await page.evaluate(
      () => document.querySelector('.project-name')?.textContent?.trim() ?? '',
    )

    await selectFirstClip(page)
    await dragPlayhead(page, 0.5)
    await page.keyboard.press('Control+b')
    await expectClipCount(page, 2)

    // 立刻刷新：不给 700ms 防抖任何机会（改动只能靠 pagehide 的同步快照保住）
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('.framecut-root')
    await page.waitForTimeout(2200)

    // demo 模式刷新后会打开「最近项目」，点同名项目载入
    const card = page.locator(`button[aria-label="打开「${projectName}」"]`)
    if (await card.count()) {
      await card.click()
      await page.waitForTimeout(2500)
    }
    await expectClipCount(page, 2)
  })
})

test.describe('回归矩阵（导出区间）', () => {
  test('P2-11 工程变短夹取后撤销，导出区间恢复', async ({ page }) => {
    await openEditor(page)
    await page.locator('input.hidden-file-input').first().setInputFiles(FIXTURE)
    await expectClipCount(page, 1)
    await selectFirstClip(page)

    // 设 I/O：I 在 1s、O 在 2.5s
    await dragPlayhead(page, 0.34)
    await page.keyboard.press('i')
    await dragPlayhead(page, 0.85)
    await page.keyboard.press('o')
    await page.waitForTimeout(300)
    const rangeBefore = await page.evaluate(() => document.querySelector('.export-range-handle') !== null)

    // 删掉片段（工程变空 → 区间被夹成 null）
    await page.keyboard.press('Delete')
    await expectClipCount(page, 0)
    // 撤销 → 工程恢复，区间也应恢复（修前会永久丢失）
    await page.keyboard.press('Control+z')
    await expectClipCount(page, 1)
    await page.waitForTimeout(300)
    const rangeAfter = await page.evaluate(() => document.querySelector('.export-range-handle') !== null)
    expect(rangeBefore || rangeAfter, '导出区间应存在且撤销后仍在').toBe(true)
    expect(rangeAfter).toBe(true)
  })
})