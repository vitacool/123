/**
 * 从 `.framecut-root` 上读取主题变量，供 Canvas 绘制的界面元素使用
 * （AudioWaveform / ClipFilmstrip）。作品内容的绘制一律不读这里。
 */

/** 一次读取多个变量；结果按「主题 + 变量名」缓存，切换主题时清空。 */
const cache = new Map<string, string>()

/** 清空缓存（主题切换时调用）。 */
export function clearThemeTokenCache(): void {
  cache.clear()
}

/**
 * 读取一个 CSS 变量（例如 `--fc-waveform`）的当前计算值。
 * 依赖调用方在主题切换后清缓存（组件通过 resolvedTheme 重绘）。
 */
export function readThemeToken(name: string, fallback = '#000000'): string {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return fallback
  const cached = cache.get(name)
  if (cached !== undefined) return cached
  const root = document.querySelector('.framecut-root')
  if (!root) return fallback
  const value = getComputedStyle(root).getPropertyValue(name).trim()
  const resolved = value.length > 0 ? value : fallback
  cache.set(name, resolved)
  return resolved
}