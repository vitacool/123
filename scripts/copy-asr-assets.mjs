import { cp, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const onnxDist = join(root, 'node_modules', 'onnxruntime-web', 'dist')
const target = join(root, 'public', 'onnxruntime')

// Same set transformers.js needs to run the ONNX WASM backend locally (threaded
// WASM for the wasm backend + JSEP for the WebGPU backend), served from public/.
const files = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
]

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