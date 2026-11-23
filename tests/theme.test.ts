import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_FRAMECUT_THEME,
  FRAMECUT_THEME_STORAGE_KEY,
  effectiveTheme,
  isFrameCutTheme,
  parseStoredTheme,
  readStoredTheme,
  resolveTheme,
  toggleTheme,
  writeStoredTheme,
  type ThemeStorage,
} from '../src/editor/core/theme'

const memoryStorage = (initial: Record<string, string> = {}): ThemeStorage & {
  data: Record<string, string>
} => {
  const data = { ...initial }
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value
    },
  }
}

describe('主题解析（system → light/dark）', () => {
  it('system 跟随系统偏好', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('显式选择不受系统影响', () => {
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('light', true)).toBe('light')
  })

  it('toggleTheme 在 light / dark 之间横跳', () => {
    expect(toggleTheme('light')).toBe('dark')
    expect(toggleTheme('dark')).toBe('light')
  })

  it('isFrameCutTheme 只接受三个合法值', () => {
    expect(isFrameCutTheme('light')).toBe(true)
    expect(isFrameCutTheme('dark')).toBe(true)
    expect(isFrameCutTheme('system')).toBe(true)
    expect(isFrameCutTheme('blue')).toBe(false)
    expect(isFrameCutTheme(undefined)).toBe(false)
    expect(isFrameCutTheme(null)).toBe(false)
  })
})

describe('主题偏好的持久化与降级', () => {
  it('默认值是 system；非法/缺失一律回退默认值', () => {
    expect(DEFAULT_FRAMECUT_THEME).toBe('system')
    expect(parseStoredTheme(null)).toBe('system')
    expect(parseStoredTheme(undefined)).toBe('system')
    expect(parseStoredTheme('')).toBe('system')
    expect(parseStoredTheme('nonsense')).toBe('system')
    expect(parseStoredTheme('dark')).toBe('dark')
    expect(parseStoredTheme('light')).toBe('light')
  })

  it('可用的存储能读回写入的值', () => {
    const storage = memoryStorage()
    expect(readStoredTheme(storage)).toBe('system')
    writeStoredTheme(storage, 'dark')
    expect(storage.data[FRAMECUT_THEME_STORAGE_KEY]).toBe('dark')
    expect(readStoredTheme(storage)).toBe('dark')
  })

  it('存储不可用（隐私模式 / iframe 沙箱）时静默降级，不抛错', () => {
    const throwing: ThemeStorage = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(readStoredTheme(throwing)).toBe('system')
    expect(() => writeStoredTheme(throwing, 'dark')).not.toThrow()
    // 完全没有存储对象（SSR / 无 window）也一样。
    expect(readStoredTheme(null)).toBe('system')
    expect(readStoredTheme(undefined)).toBe('system')
    expect(() => writeStoredTheme(null, 'light')).not.toThrow()
    const setItem = vi.fn()
    writeStoredTheme({ getItem: () => null, setItem }, 'light')
    expect(setItem).toHaveBeenCalledWith(FRAMECUT_THEME_STORAGE_KEY, 'light')
  })
})

describe('受控与非受控的优先级', () => {
  it('宿主传入的 prop 永远优先于本地偏好（包括 system）', () => {
    expect(effectiveTheme('light', 'dark')).toBe('light')
    expect(effectiveTheme('dark', 'light')).toBe('dark')
    expect(effectiveTheme('system', 'dark')).toBe('system')
  })

  it('没有 prop（undefined / null）时用本地偏好', () => {
    expect(effectiveTheme(undefined, 'dark')).toBe('dark')
    expect(effectiveTheme(null, 'system')).toBe('system')
  })
})