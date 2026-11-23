/**
 * 指针（pointer）拖拽判定的统一入口。
 *
 * 为什么必须用它、不能写 `if (!drag?.pointerId) return`：
 * **Firefox 的鼠标 pointerId 可能是 0**，truthy 判断会把「正在拖拽」误判成
 * 「没有拖拽」而直接 return —— 表现为时间轴拖片段 / 裁边缘 / 拖音频与字幕片段 /
 * 拖播放头在 Firefox 下整段失效（Chrome 的鼠标 pointerId 是 1，所以一直没暴露）。
 *
 * 约定：
 * - 判断「是否正在拖」用 {@link isDragging}；
 * - 判断「这个事件是否属于当前这次拖」用 {@link matchesPointer}；
 * - `useEffect` 的依赖里放 {@link isDragging}(state) 这个**布尔值**，不要放
 *   `state` 对象本身（移动过程中会被替换成新对象，那样每个 pointermove 都会重建监听器），
 *   也不要放 `state?.pointerId`（虽然依赖比较是 Object.is、0 不会出错，但会让人误以为
 *   这里可以 truthy 判断）。
 */

/** 拖拽状态是否有效：只要存在就算正在拖，与 pointerId 的数值无关（0 也合法）。 */
export function isDragging<T>(drag: T | null | undefined): drag is T {
  return drag != null
}

/** 该指针事件是否属于当前这次拖拽（pointerId 显式比较，0 与 0 相等）。 */
export function matchesPointer<T extends { pointerId: number }>(
  drag: T | null | undefined,
  event: { pointerId: number },
): drag is T {
  return drag != null && drag.pointerId === event.pointerId
}