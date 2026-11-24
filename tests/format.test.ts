import { describe, expect, it } from 'vitest'
import { formatSavedAt } from '../src/editor/core/format'

describe('formatSavedAt（顶栏保存时间）', () => {
  it('按本地时区输出 HH:MM，个位补零', () => {
    const at = new Date(2026, 10, 24, 9, 5, 0).getTime()
    expect(formatSavedAt(at)).toBe('09:05')
    const afternoon = new Date(2026, 10, 24, 18, 42, 0).getTime()
    expect(formatSavedAt(afternoon)).toBe('18:42')
  })

  it('非法 / 空值返回空串（不显示假时间）', () => {
    expect(formatSavedAt(Number.NaN)).toBe('')
    expect(formatSavedAt(0)).toBe('')
    expect(formatSavedAt(-100)).toBe('')
  })
})