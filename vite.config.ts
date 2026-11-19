import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Cross-origin isolation enables the multithreaded FFmpeg core. Hosts that
// cannot send these headers still work: the editor detects the missing
// SharedArrayBuffer support and falls back to the single-threaded core.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
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
        '**/public/ffmpeg/**',
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