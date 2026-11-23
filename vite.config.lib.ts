import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import dts from 'vite-plugin-dts'
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
  plugins: [
    react(),
    // 产出 .d.ts（dist-lib/ 下的声明文件即 package.json 的 types 入口）。
    dts({
      // 用应用的 tsconfig（含 src 全量），声明产物留在 dist-lib/。
      tsconfigPath: './tsconfig.app.json',
      entryRoot: 'src/editor',
      outDirs: ['dist-lib'],
      insertTypesEntry: true,
      exclude: ['src/editor/styles/**'],
    }),
  ],
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