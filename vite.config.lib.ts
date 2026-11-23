import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import framecutScope from './tools/postcss-framecut-scope.mjs'

// Embeddable ES module build. React stays external; the host serves the
// `public/ffmpeg` assets or passes `ffmpegBaseUrl` to <VideoEditor />.
export default defineConfig({
  // 样式隔离：所有选择器加 .framecut-root 前缀、@keyframes 加 fc- 前缀（构建时处理）。
  css: {
    postcss: {
      plugins: [framecutScope()],
    },
  },
  plugins: [react()],
  publicDir: false,
  resolve: {
    conditions: ['onnxruntime-web-use-extern-wasm'],
  },
  build: {
    outDir: 'dist-lib',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    cssCodeSplit: false,
    lib: {
      entry: 'src/editor/index.ts',
      formats: ['es'],
      fileName: 'framecut-editor',
      cssFileName: 'framecut-editor',
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    },
  },
})