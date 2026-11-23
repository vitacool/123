/**
 * FrameCut 样式隔离用的 PostCSS 插件（构建时执行）。
 *
 * 目标：编辑器 CSS 只作用于自己的根节点，**不污染宿主页面**。
 *
 * 三件事：
 * 1. 所有选择器加 `.framecut-root` 前缀（`.button` → `.framecut-root .button`）；
 *    `:root` / `html` / `body` 这类页面级选择器改写成 `.framecut-root` 自身，
 *    既不外泄、也仍然能作用到编辑器根节点。
 * 2. 所有 `@keyframes` 及其 `animation` / `animation-name` 引用加 `fc-` 前缀，
 *    避免和宿主的 `@keyframes spin` 之类同名冲突。
 * 3. 豁免「天然在 root 之外」的选择器：`.framecut-host` 是 root 的**祖先**
 *    包裹容器（由 <VideoEditor /> 渲染），加前缀会导致规则永不匹配；
 *    它已经带 `framecut-` 命名空间，不会污染宿主。
 *
 * 为什么不用 `postcss-prefix-selector`：本项目离线可用性优先，而它只做第 1 件事，
 * keyframes 前缀仍要另写插件；这里用一个插件把两件事一起做，并且能用真实的
 * editor.css 做单测（见 tests/cssScope.test.ts）。
 */

/** 天然位于 `.framecut-root` 之外、且已经自带命名空间的选择器前缀。 */
const OUTSIDE_ROOT = ['.framecut-host']

/**
 * 页面级选择器（`html` / `body` / `:root`，可能带类名、属性、伪类修饰）：
 * 这些必须换成编辑器根节点自身，绝不能外泄到宿主页面。
 */
const PAGE_LEVEL_COMPOUND = /^(?::root|html|body)(?:[.#[:][^\s>+~]*)?$/i

/**
 * 给一个复杂选择器加前缀。
 * 返回 null 表示该选择器不需要（也不应该）被改写。
 */
function scopeSelector(selector) {
  const trimmed = selector.trim()
  if (!trimmed) return null
  // 已经是编辑器根节点（含其伪元素 / 状态类）：原样保留，避免出现
  // `.framecut-root .framecut-root` 这种双重前缀。
  if (trimmed.startsWith('.framecut-root')) return null
  // 祖先容器：不前缀。
  if (OUTSIDE_ROOT.some((prefix) => trimmed.startsWith(prefix))) return null

  // `:root` / `html` / `body` → 根节点自身：
  //   :root            → .framecut-root
  //   body .foo        → .framecut-root .foo
  //   html.dark body   → .framecut-root（连续的页面级复合选择器全部剔除）
  const parts = trimmed.split(/(\s*[>+~]\s*|\s+)/) // 保留分隔符
  const compounds = parts.filter((part, index) => index % 2 === 0)
  const separators = parts.filter((part, index) => index % 2 === 1)
  let first = 0
  while (first < compounds.length && PAGE_LEVEL_COMPOUND.test(compounds[first].trim())) {
    first += 1
  }
  if (first > 0) {
    const rest = compounds.slice(first)
    if (rest.length === 0) return '.framecut-root'
    // 剔除后重建：丢掉紧跟在被剔除部分之后的那个分隔符。
    const restSeparators = separators.slice(first)
    let rebuilt = ''
    rest.forEach((compound, index) => {
      if (index === 0) rebuilt += compound.trim()
      else rebuilt += `${restSeparators[index - 1] ?? ' '}${compound.trim()}`
    })
    return `.framecut-root ${rebuilt}`
  }

  // `*` 也要挂在根节点下（否则 `.framecut-root, *` 会把宿主全选进来）。
  return `.framecut-root ${trimmed}`
}

export default function framecutScope(options = {}) {
  const keyframePrefix = options.keyframePrefix ?? 'fc-'
  /**
   * 只处理编辑器自己的样式表。
   *
   * Vite 的 postcss 配置对**所有** CSS 生效，包括宿主页面的 base.css / demo.css。
   * 那些文件里的 `.button` 是宿主的，绝不能加 `.framecut-root` 前缀
   * （加了它们就再也不匹配宿主自己的 DOM 了）。
   */
  const include = options.include ?? /(^|[\\/])styles[\\/]editor\.css$/

  return {
    postcssPlugin: 'framecut-scope',
    Once(root, { result }) {
      const from = result.opts.from ?? root.source?.input?.file ?? ''
      if (from && !include.test(from)) return
      // ---- 1. 收集并重命名 @keyframes ----
      /** @type {Set<string>} */
      const names = new Set()
      root.walkAtRules((atRule) => {
        const kind = atRule.name.toLowerCase()
        if (kind !== 'keyframes' && kind !== '-webkit-keyframes') return
        const name = atRule.params.trim()
        if (!name || name.startsWith(keyframePrefix)) return
        names.add(name)
        atRule.params = `${keyframePrefix}${name}`
      })

      // ---- 2. 改写 animation / animation-name 里的引用 ----
      if (names.size > 0) {
        root.walkDecls((decl) => {
          if (!/^(-webkit-)?animation(-name)?$/i.test(decl.prop)) return
          let value = decl.value
          for (const name of names) {
            // 只替换独立的标识符（`orbit` 不会误伤 `orbit-x`）。
            const pattern = new RegExp(`(^|[\\s,])${name}(?=[\\s,]|$)`, 'g')
            value = value.replace(pattern, (match, lead) => `${lead}${keyframePrefix}${name}`)
          }
          if (value !== decl.value) decl.value = value
        })
      }

      // ---- 3. 给选择器加前缀 ----
      root.walkRules((rule) => {
        // 嵌套在 @keyframes 里的 `0%` / `from` 不是选择器。
        const parent = rule.parent
        if (parent && parent.type === 'atrule') {
          const kind = parent.name.toLowerCase()
          if (kind === 'keyframes' || kind === '-webkit-keyframes') return
        }
        const selectors = rule.selectors
        if (!selectors || selectors.length === 0) return
        const scoped = []
        let changed = false
        for (const selector of selectors) {
          const next = scopeSelector(selector)
          if (next === null) {
            scoped.push(selector.trim())
            continue
          }
          changed = true
          scoped.push(next)
        }
        if (changed) rule.selectors = scoped
      })
    },
  }
}

framecutScope.postcss = true