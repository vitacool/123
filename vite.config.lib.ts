import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Embeddable ES module build. React stays external; the host serves the
// `public/ffmpeg` assets or passes `ffmpegBaseUrl` to <VideoEditor />.
export default defineConfig({
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