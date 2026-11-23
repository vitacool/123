/**
 * 界面主题（纯逻辑，可在 node 环境测试）。
 *
 * 主题只影响编辑器界面外观，不影响作品内容；它是**界面偏好**，
 * 不写进 Project / 草稿 / 工程文件，也不进撤销历史。
 */

/** 用户可选的主题偏好。 */
export type FrameCutTheme = 'light' | 'dark' | 'system'

/** 真正作用到 CSS 上的主题（system 会先被解析成其中之一）。 */
export type ResolvedTheme = 'light' | 'dark'

/** localStorage 键名。 */
export const FRAMECUT_THEME_STORAGE_KEY = 'framecut:theme'

/** 默认偏好：跟随系统。 */
export const DEFAULT_FRAMECUT_THEME: FrameCutTheme = 'system'

/** 只依赖 getItem/setItem 的最小存储接口（便于测试与降级）。 */
export interface ThemeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function isFrameCutTheme(value: unknown): value is FrameCutTheme {
  return value === 'light' || value === 'dark' || value === 'system'
}

/** system + 系统偏好 → 实际主题。 */
export function resolveTheme(theme: FrameCutTheme, systemPrefersDark: boolean): ResolvedTheme {
  if (theme === 'system') return systemPrefersDark ? 'dark' : 'light'
  return theme
}

/** 解析存进 localStorage 的原始字符串；非法/缺失一律回退默认值。 */
export function parseStoredTheme(raw: string | null | undefined): FrameCutTheme {
  return isFrameCutTheme(raw) ? raw : DEFAULT_FRAMECUT_THEME
}

/**
 * 读取已保存的主题偏好。
 * 存储不可用（隐私模式 / iframe 沙箱 / 被禁用）时静默回退默认值，绝不抛错。
 */
export function readStoredTheme(storage: ThemeStorage | null | undefined): FrameCutTheme {
  if (!storage) return DEFAULT_FRAMECUT_THEME
  try {
    return parseStoredTheme(storage.getItem(FRAMECUT_THEME_STORAGE_KEY))
  } catch {
    return DEFAULT_FRAMECUT_THEME
  }
}

/** 写入主题偏好；存储不可用时静默忽略。 */
export function writeStoredTheme(
  storage: ThemeStorage | null | undefined,
  theme: FrameCutTheme,
): void {
  if (!storage) return
  try {
    storage.setItem(FRAMECUT_THEME_STORAGE_KEY, theme)
  } catch {
    // 隐私模式 / 配额 / 沙箱：静默降级。
  }
}

/**
 * 受控与非受控的优先级：宿主传入的 prop 永远优先；没传才用本地偏好。
 */
export function effectiveTheme(
  propTheme: FrameCutTheme | null | undefined,
  storedTheme: FrameCutTheme,
): FrameCutTheme {
  return propTheme ?? storedTheme
}

/** 点击切换按钮时在 light / dark 之间横跳（system 会先按当前解析结果决定去向）。 */
export function toggleTheme(resolved: ResolvedTheme): ResolvedTheme {
  return resolved === 'dark' ? 'light' : 'dark'
}