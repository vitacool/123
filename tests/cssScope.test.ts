import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import postcss from 'postcss'
import framecutScope from '../tools/postcss-framecut-scope.mjs'
import { setBodyStyles } from '../src/editor/components/bodyStyles'

/**
 * CSS 隔离：
 * 1. 所有选择器都在 `.framecut-root` 下（除了天然在 root 之外的 `.framecut-host`）；
 * 2. 所有 `@keyframes` 与 `animation` 引用都带 `fc-` 前缀；
 * 3. `:root` / `html` / `body` 映射到根节点自身，不外泄到页面；
 * 4. body 行内样式「先保存、后恢复」，不抹掉宿主自己的设置。
 */

const CSS_PATH = join(process.cwd(), 'src/editor/styles/editor.css')
const SOURCE = readFileSync(CSS_PATH, 'utf8')

const runPlugin = async (css: string): Promise<postcss.Root> => {
  const result = await postcss([framecutScope()]).process(css, { from: CSS_PATH })
  return result.root
}

const selectorsOf = (root: postcss.Root): string[] => {
  const all: string[] = []
  root.walkRules((rule) => {
    const parent = rule.parent
    // @keyframes 里的 `0%` / `from` 不是选择器
    if (parent && parent.type === 'atrule' && /keyframes/i.test(parent.name)) return
    all.push(...rule.selectors.map((selector) => selector.trim()))
  })
  return all
}

describe('editor.css：选择器全部挂在 .framecut-root 下', () => {
  it('没有游离的顶层选择器（.button / .badge / .toast / .icon-button / .brand / .context-menu）', async () => {
    const root = await runPlugin(SOURCE)
    const selectors = selectorsOf(root)
    expect(selectors.length).toBeGreaterThan(100)

    const offenders = selectors.filter(
      (selector) =>
        !selector.startsWith('.framecut-root') &&
        // 祖先包裹容器：天然在 root 之外，且自带 framecut- 命名空间
        !selector.startsWith('.framecut-host'),
    )
    expect(offenders).toEqual([])
  })

  it('原来会污染宿主的类现在都被限定在编辑器内', async () => {
    const root = await runPlugin(SOURCE)
    const selectors = new Set(selectorsOf(root))
    expect(selectors.has('.framecut-root .button')).toBe(true)
    expect(selectors.has('.framecut-root .badge')).toBe(true)
    expect(selectors.has('.framecut-root .toast')).toBe(true)
    expect(selectors.has('.framecut-root .icon-button')).toBe(true)
    expect(selectors.has('.framecut-root .context-menu')).toBe(true)
    // 裸选择器不应再出现
    for (const bare of ['.button', '.badge', '.toast', '.icon-button', '.brand', '.context-menu']) {
      expect(selectors.has(bare)).toBe(false)
    }
  })

  it('已经带 .framecut-root 的选择器不会被二次前缀', async () => {
    const root = await runPlugin(SOURCE)
    for (const selector of selectorsOf(root)) {
      expect(selector).not.toContain('.framecut-root .framecut-root')
    }
  })

  it('插件幂等：重复处理不会叠加前缀', async () => {
    const once = (await runPlugin(SOURCE)).toString()
    const twice = (await runPlugin(once)).toString()
    expect(twice).toBe(once)
  })
})

describe('editor.css：@keyframes 全部带 fc- 前缀', () => {
  it('10 组动画都改名，且没有残留的裸名', async () => {
    const root = await runPlugin(SOURCE)
    const names: string[] = []
    root.walkAtRules((atRule) => {
      if (/keyframes/i.test(atRule.name)) names.push(atRule.params.trim())
    })
    expect(names.length).toBeGreaterThanOrEqual(10)
    for (const name of names) expect(name.startsWith('fc-')).toBe(true)
    // 宿主也很可能用 spin / pop-in 这类名字，确认这些裸名都不在动画表里
    for (const bare of ['spin', 'pop-in', 'orbit', 'frame-in', 'toast-in', 'panel-in']) {
      expect(names.includes(bare)).toBe(false)
    }
  })

  it('animation / animation-name 的引用同步改名', async () => {
    const root = await runPlugin(SOURCE)
    const renamed = new Set<string>()
    root.walkAtRules((atRule) => {
      if (/keyframes/i.test(atRule.name)) renamed.add(atRule.params.trim())
    })
    const bareNames = [...renamed].map((name) => name.replace(/^fc-/, ''))

    const decls: string[] = []
    root.walkDecls((decl) => {
      if (/^(-webkit-)?animation(-name)?$/i.test(decl.prop)) decls.push(decl.value)
    })
    expect(decls.length).toBeGreaterThan(5)
    for (const value of decls) {
      if (value === 'none') continue
      // 引用必须带前缀
      expect(value).toMatch(/\bfc-[a-z-]+/)
      // 且不能再引用裸名（spin 不会误命中 fc-spin：用词边界排除）
      for (const bare of bareNames) {
        expect(value).not.toMatch(new RegExp(`(^|[\\s,])${bare}(?=[\\s,]|$)`))
      }
    }
  })
})

describe('页面级选择器的处理', () => {
  const run = async (css: string): Promise<string[]> => selectorsOf(await runPlugin(css))

  it(':root 映射到根节点自身', async () => {
    expect(await run(':root { color: red }')).toEqual(['.framecut-root'])
  })

  it('body / html 及其后代映射到根节点下', async () => {
    expect(await run('body { margin: 0 }')).toEqual(['.framecut-root'])
    expect(await run('body .panel { color: red }')).toEqual(['.framecut-root .panel'])
    expect(await run('html.dark body .panel { color: red }')).toEqual([
      '.framecut-root .panel',
    ])
  })

  it('* 通配也限定在编辑器内（否则会选中宿主所有元素）', async () => {
    expect(await run('* { box-sizing: border-box }')).toEqual(['.framecut-root *'])
  })

  it('普通选择器加前缀、伪类与伪元素保持不变', async () => {
    expect(await run('.btn:hover { color: red }')).toEqual(['.framecut-root .btn:hover'])
    expect(await run('.scroll::-webkit-scrollbar { width: 8px }')).toEqual([
      '.framecut-root .scroll::-webkit-scrollbar',
    ])
    expect(await run('.a, .b .c { color: red }')).toEqual([
      '.framecut-root .a',
      '.framecut-root .b .c',
    ])
  })

  it('.framecut-host 保持原样（它是 root 的祖先容器）', async () => {
    expect(await run('.framecut-host { height: 100% }')).toEqual(['.framecut-host'])
  })

  it('宿主样式表不被处理（只处理 editor.css）', async () => {
    const hostCss = '.button { color: hotpink }\n@keyframes spin { to { transform: rotate(1turn) } }'
    const result = await postcss([framecutScope()]).process(hostCss, {
      from: join(process.cwd(), 'src/styles/demo.css'),
    })
    // 宿主文件原样输出：选择器不加前缀、keyframes 不改名
    expect(result.root.toString()).toContain('.button')
    expect(result.root.toString()).toContain('@keyframes spin')
    expect(result.root.toString()).not.toContain('.framecut-root')
  })
})

// ---------------------------------------------------------------- body 样式

/** 最小可用的 CSSStyleDeclaration 替身（只需要本工具用到的四个方法）。 */
function fakeElement(): {
  style: {
    getPropertyValue: (name: string) => string
    getPropertyPriority: (name: string) => string
    setProperty: (name: string, value: string, priority?: string) => void
    removeProperty: (name: string) => string
  }
  values: Map<string, { value: string; priority: string }>
} {
  const values = new Map<string, { value: string; priority: string }>()
  return {
    values,
    style: {
      getPropertyValue: (name) => values.get(name)?.value ?? '',
      getPropertyPriority: (name) => values.get(name)?.priority ?? '',
      setProperty: (name, value, priority = '') => {
        values.set(name, { value, priority })
      },
      removeProperty: (name) => {
        const previous = values.get(name)?.value ?? ''
        values.delete(name)
        return previous
      },
    },
  }
}

describe('setBodyStyles：保存宿主原值并精确恢复', () => {
  it('宿主原本有值 → 恢复成原值（不是清空）', () => {
    const element = fakeElement()
    element.values.set('cursor', { value: 'pointer', priority: '' })
    element.values.set('user-select', { value: 'text', priority: '' })

    const handle = setBodyStyles({ cursor: 'ns-resize', userSelect: 'none' }, element as never)
    expect(element.style.getPropertyValue('cursor')).toBe('ns-resize')
    expect(element.style.getPropertyValue('user-select')).toBe('none')

    handle.restore()
    expect(element.style.getPropertyValue('cursor')).toBe('pointer')
    expect(element.style.getPropertyValue('user-select')).toBe('text')
  })

  it('宿主原本没设 → 恢复后仍然没有该属性（而不是留空值）', () => {
    const element = fakeElement()
    const handle = setBodyStyles({ cursor: 'ns-resize' }, element as never)
    expect(element.values.has('cursor')).toBe(true)
    handle.restore()
    expect(element.values.has('cursor')).toBe(false)
  })

  it('恢复是幂等的，不会把中间被宿主改过的值再覆盖回去', () => {
    const element = fakeElement()
    element.values.set('cursor', { value: 'auto', priority: '' })
    const handle = setBodyStyles({ cursor: 'ns-resize' }, element as never)
    handle.restore()
    element.style.setProperty('cursor', 'crosshair')
    handle.restore()
    expect(element.style.getPropertyValue('cursor')).toBe('crosshair')
  })

  it('没有 DOM 时不抛错', () => {
    expect(() => setBodyStyles({ cursor: 'ns-resize' }, null).restore()).not.toThrow()
  })
})