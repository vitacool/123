import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import framecutScope from './tools/postcss-framecut-scope.mjs'

// Cross-origin isolation enables the multithreaded FFmpeg core. Hosts that
// cannot send these headers still work: the editor detects the missing
// SharedArrayBuffer support and falls back to the single-threaded core.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  // 样式隔离：所有选择器加 .framecut-root 前缀、@keyframes 加 fc- 前缀（构建时处理）。
  css: {
    postcss: {
      plugins: [framecutScope()],
    },
  },
  plugins: [react()],
  resolve: {
    // Use the external-wasm build of onnxruntime-web so the WASM binaries are
    // fetched from public/onnxruntime (served locally) instead of being
    // inlined/embedded or fetched from a CDN.
    conditions: ['onnxruntime-web-use-extern-wasm'],
  },
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg'],
  },
  server: {
    headers: isolationHeaders,
    watch: {
      ignored: [
        '**/.verify/**',
        '**/.*.tmpdir/**',
        '**/.*.tmpdir',
        '**/*.tmp',
        // 临时目录（headless 浏览器的 user-data-dir、esbuild 的 TEMP 等）。
        // 必须忽略：Chrome 的缓存 DB 会被锁住，Vite 监听它会抛 EBUSY 直接崩进程。
        '**/.tmp-*/**',
        '**/.tmp-*',
        '**/public/ffmpeg/**',
        // 运行时二进制资源：浏览器加载时会把文件锁住，chokidar 监听会 EBUSY 直接崩进程。
        // （ffmpeg 早就有这条，onnxruntime / vad 是 ASR 之后才引入的，曾漏加导致 dev server 崩溃）
        '**/public/onnxruntime/**',
        '**/public/vad/**',
        '**/dist/**',
        '**/dist-lib/**',
      ],
    },
  },
  preview: {
    headers: isolationHeaders,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})