import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 库产物门禁：`dist-lib` 里的 worker 引用必须是**相对路径**，且引用的资源确实产出。
 *
 * 为什么需要：Vite 的 `new URL('...', import.meta.url)` 在 `base` 为默认 `'/'` 时会被
 * 改写成 `new URL("/assets/worker-xxx.js", import.meta.url)`。前导 `/` 让 URL 解析
 * 直接指向**站点根**，`import.meta.url` 的目录部分被忽略 —— 宿主把 `dist-lib` 整体
 * 复制到 `/studio/` 后，浏览器去请求 `/assets/worker-xxx.js`，404；而 worker 加载
 * 失败只在异步 `error` 事件里，表现为智能字幕永久卡住（不是抛错）。
 *
 * 这个脚本把「构建产物」当输入，检查两件事：
 * 1. 没有以 `/` 开头的 `new URL(...)` 引用；
 * 2. 每个相对引用（`assets/...`）在产物目录里都存在。
 *
 * 用法：`node scripts/check-lib-assets.mjs [distDir]`（默认 `dist-lib`）。
 */

const here = dirname(fileURLToPath(import.meta.url))
const distDir = resolve(process.argv[2] ?? join(here, '..', 'dist-lib'))
const bundle = join(distDir, 'framecut-editor.js')

if (!existsSync(bundle)) {
  console.error(
    `[check-lib-assets] 找不到 ${bundle}\n` +
      `  先跑 \`pnpm build:lib\`。这个检查是构建后置门禁，不负责创建产物。`,
  )
  process.exit(1)
}

const code = readFileSync(bundle, 'utf8')

/** 抽出所有 `new URL("...", import.meta.url)` 里的目标（含 @vite-ignore 注释形式）。 */
function collectUrlRefs(source) {
  const refs = new Set()
  const patterns = [
    /new URL\(\s*\/\* @vite-ignore \*\/\s*"([^"]+)"/g,
    /new URL\(\s*\/\* @vite-ignore \*\/\s*'([^']+)'/g,
    /new URL\(\s*"([^"]+)"\s*,\s*import\.meta\.url\s*\)/g,
    /new URL\(\s*'([^']+)'\s*,\s*import\.meta\.url\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) refs.add(match[1])
  }
  return [...refs]
}

const refs = collectUrlRefs(code)
const absolute = refs.filter((ref) => ref.startsWith('/'))
const relativeAssets = refs.filter(
  (ref) => !ref.startsWith('/') && !/^(?:[a-z]+:|\/\/)/i.test(ref) && ref.includes('assets/'),
)

if (absolute.length > 0) {
  console.error('[check-lib-assets] 产物里存在以站点根开头的 import.meta.url 引用（子路径部署会 404）：')
  for (const ref of absolute) console.error(`  - ${ref}`)
  console.error('  修复：vite.config.lib.ts 的 base 必须是相对值（如 "./"）。')
  process.exit(1)
}

const missing = relativeAssets.filter((ref) => {
  const file = join(distDir, ref.split(/[?#]/)[0])
  if (!existsSync(file)) return true
  // worker 资产必须是文件，空目录/占位不算产出。
  return !statSync(file).isFile()
})

if (missing.length > 0) {
  console.error('[check-lib-assets] 产物引用了没有产出的资源：')
  for (const ref of missing) console.error(`  - ${ref}`)
  console.error('  修复：确认对应 worker 入口仍被源码引用，且没有被 publicDir/rollup 配置排除。')
  process.exit(1)
}

if (relativeAssets.length === 0) {
  console.error(
    '[check-lib-assets] 产物里没有找到任何 worker 资产引用。\n' +
      '  这通常意味着 worker 被内联或入口已删除 —— 与 README 的「assets/ 必须一起部署」约定不符。',
  )
  process.exit(1)
}

// FFmpeg 的 esm 包装同样是独立 chunk，一起确认它没被漏掉。
if (!existsSync(join(distDir, 'framecut-editor.css'))) {
  console.warn('[check-lib-assets] 警告：没找到 framecut-editor.css（宿主需要它来渲染样式）。')
}

console.log(
  `[check-lib-assets] OK：${relativeAssets.length} 个 worker 资源均已产出，且引用为相对路径。`,
)