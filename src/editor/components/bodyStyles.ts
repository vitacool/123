/**
 * 临时改写 `document.body` 的行内样式，结束后**精确恢复宿主原来的值**。
 *
 * 为什么需要它：拖动时间轴高度时要把光标改成 `ns-resize` 并禁用选中，常见写法是
 * 结束时 `style.cursor = ''`。但那是把属性清空，而不是恢复——宿主页面自己在
 * body 上设的 `cursor` / `user-select` 会被一起抹掉。
 *
 * 这里保存修改前的**行内**值（包含「原本没设」这种情况），恢复时原样写回或删除。
 */

export interface BodyStyleOverrides {
  /** 恢复修改前的全部行内值；可重复调用（幂等）。 */
  restore: () => void
}

/** 支持的属性：`cursor`、`userSelect`（驼峰，对应 CSS `user-select`）。 */
export type BodyStyleProperty = 'cursor' | 'userSelect'

const CSS_NAMES: Record<BodyStyleProperty, string> = {
  cursor: 'cursor',
  userSelect: 'user-select',
}

/**
 * 应用一组临时 body 样式，返回恢复函数。
 *
 * @param overrides 例如 `{ cursor: 'ns-resize', userSelect: 'none' }`
 * @param target 目标元素（默认 `document.body`；测试可注入）
 */
export function setBodyStyles(
  overrides: Partial<Record<BodyStyleProperty, string>>,
  target: HTMLElement | null = typeof document === 'undefined' ? null : document.body,
): BodyStyleOverrides {
  // 没有 DOM（SSR / 测试环境）时什么也不做。
  if (!target) return { restore: () => undefined }

  const saved: Array<{ property: BodyStyleProperty; value: string; priority: string }> = []
  for (const key of Object.keys(overrides) as BodyStyleProperty[]) {
    saved.push({
      property: key,
      value: target.style.getPropertyValue(CSS_NAMES[key]),
      priority: target.style.getPropertyPriority(CSS_NAMES[key]),
    })
  }

  for (const [key, value] of Object.entries(overrides) as Array<[BodyStyleProperty, string]>) {
    target.style.setProperty(CSS_NAMES[key], value)
  }

  let restored = false
  return {
    restore: () => {
      if (restored) return
      restored = true
      for (const entry of saved) {
        const name = CSS_NAMES[entry.property]
        if (entry.value) {
          target.style.setProperty(name, entry.value, entry.priority)
        } else {
          // 原来没设：删掉我们加的这条，而不是写一个空值。
          target.style.removeProperty(name)
        }
      }
    },
  }
}