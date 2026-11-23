/**
 * 快捷键的作用域判断。
 *
 * 问题：组件把监听挂在 `window` 上、又不判断焦点，嵌入宿主页面后会抢宿主的按键
 * （例如宿主搜索框里输入 `/` 被编辑器拦截）。
 *
 * 规则（编辑器内的所有「裸键」快捷键都该遵守）：
 * 1. 事件目标必须在编辑器根节点 `.framecut-root` **内部**（或就是根节点）；
 * 2. 目标是输入控件（input/textarea/select/contentEditable）时不生效；
 * 3. 带 ctrl/meta/alt 的组合键默认不当作编辑器快捷键 —— 留给宿主/浏览器。
 *
 * 实现故意不依赖 `instanceof Element`：这样在 node（无 DOM）里也能用鸭子类型
 * 的对象做单测，不会因为缺少全局构造器而抛错。
 */

const EDITOR_ROOT_SELECTOR = '.framecut-root'

interface ElementLike {
  tagName?: string
  isContentEditable?: boolean
  getAttribute?: (name: string) => string | null
  closest?: (selector: string) => ElementLike | null
  contains?: (node: unknown) => boolean
}

const asElement = (value: unknown): ElementLike | null =>
  typeof value === 'object' && value !== null ? (value as ElementLike) : null

/** 目标是否是输入控件（含 contentEditable）。 */
export function isEditableTarget(target: unknown): boolean {
  const element = asElement(target)
  if (!element) return false
  const tag = element.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (element.isContentEditable === true) return true
  const role = element.getAttribute?.('role') ?? null
  return role === 'textbox' || role === 'combobox'
}

/** 事件目标是否落在编辑器根节点内（含根节点自身）。 */
export function isInsideEditor(event: { target?: unknown }): boolean {
  const element = asElement(event.target)
  if (element) {
    if (element.closest?.(EDITOR_ROOT_SELECTOR)) return true
    // 没有 closest（或根节点自身）：用根节点的 contains 兜底。
    const root =
      typeof document !== 'undefined'
        ? asElement(document.querySelector(EDITOR_ROOT_SELECTOR))
        : null
    if (root?.contains?.(element)) return true
    if (!root) return false
    return false
  }
  // 目标不是元素（脚本派发 / window）：再看当前焦点是否在编辑器内。
  if (typeof document === 'undefined') return false
  const active = asElement(document.activeElement)
  return Boolean(active?.closest?.(EDITOR_ROOT_SELECTOR))
}

/**
 * 该按键是否应当被编辑器处理（裸键快捷键的通用守卫）。
 * @param options.allowModifiers 允许带 ctrl/meta/alt（默认不允许）
 */
export function isEditorShortcut(
  event: {
    target?: unknown
    ctrlKey?: boolean
    metaKey?: boolean
    altKey?: boolean
  },
  options: { allowModifiers?: boolean } = {},
): boolean {
  if (!isInsideEditor(event)) return false
  if (isEditableTarget(event.target)) return false
  if (!options.allowModifiers && (event.ctrlKey || event.metaKey || event.altKey)) return false
  return true
}