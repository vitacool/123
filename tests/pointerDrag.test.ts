import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isDragging, matchesPointer } from '../src/editor/components/pointerDrag'

/**
 * Firefox 的鼠标 pointerId 可能为 0。
 * 这里既验证 helper 的语义，也用「源码扫描」保证不会有人再写回 truthy 判断。
 */
describe('pointerDrag：pointerId 可以是 0', () => {
  it('isDragging：只看是否存在，pointerId=0 也算正在拖', () => {
    expect(isDragging({ pointerId: 0 })).toBe(true)
    expect(isDragging({ pointerId: 1 })).toBe(true)
    expect(isDragging(null)).toBe(false)
    expect(isDragging(undefined)).toBe(false)
  })

  it('matchesPointer：pointerId=0 与 0 相等，0 与 1 不等', () => {
    expect(matchesPointer({ pointerId: 0 }, { pointerId: 0 })).toBe(true)
    expect(matchesPointer({ pointerId: 1 }, { pointerId: 1 })).toBe(true)
    expect(matchesPointer({ pointerId: 0 }, { pointerId: 1 })).toBe(false)
    expect(matchesPointer({ pointerId: 1 }, { pointerId: 0 })).toBe(false)
    expect(matchesPointer(null, { pointerId: 0 })).toBe(false)
    expect(matchesPointer(undefined, { pointerId: 0 })).toBe(false)
  })

  it('helpers 可以当类型守卫（narrow 掉 null）', () => {
    const state: { pointerId: number } | null = { pointerId: 0 }
    if (!isDragging(state)) throw new Error('unreachable')
    // 编译期：state 已经被 narrow 成非空
    expect(state.pointerId).toBe(0)
  })
})

/**
 * 源码级回归守卫：组件里不许再出现
 * - `!x.pointerId` / `!x?.pointerId`（truthy 判断，0 会被当成“没拖拽”）
 * - `x.pointerId === event.pointerId` 之类的手写比较（应走 matchesPointer）
 * - `.pointerId` 参与 `&&` / `||` 的真假判断
 *
 * `setPointerCapture(event.pointerId)` 这类**调用**是允许的（不是判定）。
 */
describe('pointerDrag：组件里不再有 pointerId 的 truthy 判断', () => {
  const dir = join(process.cwd(), 'src', 'editor', 'components')
  const files = readdirSync(dir).filter(
    (name) => name.endsWith('.tsx') && name !== 'pointerDrag.tsx',
  )

  /** 明确禁止的写法。 */
  const forbidden: Array<{ pattern: RegExp; why: string }> = [
    { pattern: /!\s*[\w$]+(?:\?|)\.pointerId\b/, why: 'truthy 判断（pointerId=0 会误判为没拖拽）' },
    { pattern: /\.pointerId\s*===?\s*/, why: '手写比较，应改用 matchesPointer' },
    { pattern: /\.pointerId\s*!==?/, why: '手写比较，应改用 matchesPointer' },
    { pattern: /\.pointerId\s*(?:&&|\|\|)/, why: '把 pointerId 当真假值用' },
  ]

  it('扫描 src/editor/components/*.tsx', () => {
    expect(files.length).toBeGreaterThan(10)
    const problems: string[] = []
    for (const name of files) {
      const text = readFileSync(join(dir, name), 'utf8')
      const lines = text.split('\n')
      lines.forEach((line, index) => {
        for (const rule of forbidden) {
          if (rule.pattern.test(line)) {
            problems.push(`${name}:${index + 1}  ${rule.why}  →  ${line.trim()}`)
          }
        }
      })
    }
    expect(problems).toEqual([])
  })

  it('会用到 pointerId 的拖拽组件都走 pointerDrag 的两个 helper', () => {
    const expectHelper = ['Timeline.tsx', 'AudioTracks.tsx', 'TextTracks.tsx']
    for (const name of expectHelper) {
      const text = readFileSync(join(dir, name), 'utf8')
      expect(text).toContain("from './pointerDrag'")
      expect(text).toMatch(/\bisDragging\(/)
      expect(text).toMatch(/\bmatchesPointer\(/)
      // 依赖数组里用布尔值，避免移动过程中重建监听器
      expect(text).not.toMatch(/\?\s*\.pointerId[,)\s]/)
    }
  })
})