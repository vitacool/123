import { cp, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const onnxDist = join(root, 'node_modules', 'onnxruntime-web', 'dist')
const target = join(root, 'public', 'onnxruntime')
const vadDir = join(root, 'public', 'vad')
const vadModel = join(vadDir, 'silero_vad.onnx')

// Same set transformers.js needs to run the ONNX WASM backend locally (threaded
// WASM for the wasm backend + JSEP for the WebGPU backend), served from public/.
const files = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
]

/** VAD 模型的固定来源（与 vadWorker 期望的文件名一致）。 */
const VAD_MODEL_URL =
  process.env.SILERO_VAD_URL ??
  'https://hf-mirror.com/onnx-community/silero-vad/resolve/main/silero_vad.onnx'

/**
 * 确保 public/vad/silero_vad.onnx 存在。
 *
 * 为什么需要：`public/vad/` 在 .gitignore 里（当作生成物），但此前**没有任何脚本
 * 生成它** —— 全新 clone / CI / 打包发布里根本没有这个模型，于是每次识别在 VAD
 * 阶段拿 404（表现为「识别失败/卡住」）。这里补上：本地已有就跳过；否则先尝试
 * `SILERO_VAD_SOURCE`（本地文件路径），再按固定 URL 下载；都失败也只警告，
 * 运行时已经能降级成「固定 28s 切块识别」。
 */
async function ensureVadModel() {
  if (existsSync(vadModel)) {
    console.log('[asr] vad model already present')
    return true
  }
  await mkdir(vadDir, { recursive: true })
  const local = process.env.SILERO_VAD_SOURCE
  if (local && existsSync(local)) {
    await cp(local, vadModel)
    console.log(`[asr] copied vad model from ${local}`)
    return true
  }
  if (process.env.SILERO_VAD_SKIP_DOWNLOAD === '1') {
    console.warn('[asr] SILERO_VAD_SKIP_DOWNLOAD=1，跳过 VAD 模型下载')
    return false
  }
  try {
    // 必须带超时：fetch 默认没有总超时，离线/被墙时可能一直挂在 predev / prebuild 里，
    // 让 `pnpm install` 之后的准备步骤看起来像卡死。60s 足够下完 2.3MB。
    const response = await fetch(VAD_MODEL_URL, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    // 模型约 2.3MB；明显过小说明拿到的是错误页/重定向 HTML。
    if (bytes.byteLength < 1024 * 1024) {
      throw new Error(`下载内容过小（${bytes.byteLength} bytes），可能不是模型文件`)
    }
    await writeFile(vadModel, bytes)
    console.log(`[asr] downloaded vad model -> ${vadModel}`)
    return true
  } catch (error) {
    console.warn(
      `[asr] 未能获取 VAD 模型（${error instanceof Error ? error.message : String(error)}）。\n` +
        `       智能字幕会降级为「固定 28s 切块识别」；如需人声切块，请手动把 silero_vad.onnx\n` +
        `       放到 ${vadModel}，或用 SILERO_VAD_SOURCE=<本地路径> / SILERO_VAD_URL=<URL> 指定。`,
    )
    return false
  }
}

let copied = 0
for (const file of files) {
  const source = join(onnxDist, file)
  if (!existsSync(source)) {
    console.warn(`[asr] missing onnxruntime asset: ${file}`)
    continue
  }
  await mkdir(target, { recursive: true })
  await cp(source, join(target, file))
  copied += 1
  console.log(`[asr] copied ${file}`)
}

if (copied === 0) throw new Error('onnxruntime-web dist files not found; run the package install first.')
console.log(`[asr] wrote ${copied} files -> ${target}`)

const vadReady = await ensureVadModel()
if (!vadReady) {
  console.warn('[asr] public/vad/silero_vad.onnx 缺失：ASR 可用但人声切块精度下降。')
}