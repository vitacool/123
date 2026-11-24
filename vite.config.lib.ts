import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import dts from 'vite-plugin-dts'
import framecutScope from './tools/postcss-framecut-scope.mjs'

// Embeddable ES module build. React stays external; the host serves the
// `public/ffmpeg` assets or passes `ffmpegBaseUrl` to <VideoEditor />.
export default defineConfig({
  /**
   * 关键：库构建必须用**相对** base。
   *
   * ASR 的 whisperWorker / vadWorker 在源码里是
   * `new Worker(new URL('../../workers/whisperWorker.ts', import.meta.url))`，
   * Vite 会把它改写成「base + assets/xxx.js」。base 若保持默认 `'/'`，产物里就是
   * `new URL("/assets/whisperWorker-xxx.js", import.meta.url)` —— 前导 `/` 会让
   * `import.meta.url` 失效，URL 固定解析到**站点根** `/assets/`。宿主按 README
   * 「复制完整 dist-lib」把库放到 `/studio/` 时就 404，而 worker 加载失败不会抛错
   * （只在异步 error 事件里），表现为识别永久卡住。
   * `base: './'` 产出相对路径，跟随 framecut-editor.js 所在目录（assets/ 兄弟目录）。
   */
  base: './',
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