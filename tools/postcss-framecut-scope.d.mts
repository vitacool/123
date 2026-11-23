import type { AcceptedPlugin } from 'postcss'

export interface FramecutScopeOptions {
  /** @keyframes 前缀，默认 `fc-`。 */
  keyframePrefix?: string
  /** 只处理匹配此正则的文件（默认仅 styles/editor.css）；Vite 的 postcss 对所有 CSS 生效。 */
  include?: RegExp
}

/** 构建时给编辑器 CSS 加 `.framecut-root` / `fc-` 前缀的 PostCSS 插件。 */
declare function framecutScope(options?: FramecutScopeOptions): AcceptedPlugin

export default framecutScope