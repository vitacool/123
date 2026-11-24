import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright E2E：覆盖 Chromium 与 Firefox。
 *
 * 为什么要两个浏览器：编辑器里 pointer 事件（拖动片段 / 拖拽裁剪边缘）曾经在
 * Firefox 上因为 pointerId 为 0 被真值判断拒绝而完全失效 —— 只有跨浏览器跑才测得到。
 *
 * 素材：tests/e2e/fixtures/clip.mp4 由 scripts/make-test-fixture.mjs 生成
 * （3 秒彩条 + 440Hz 正弦音），不进版本库。
 */
const PORT = 5199
const BASE_URL = process.env.FRAMECUT_E2E_URL ?? `http://127.0.0.1:${PORT}/`

/**
 * 统一用 dev server 跑 e2e（本地 Edge 已验证 22 条全过）。
 *
 * CI 冷启动要把 @huggingface/transformers / onnxruntime-web 做依赖预打包，
 * 2 核 runner 上可能超过 120s，所以 CI 的超时放宽到 300s；ASR 资源不参与 e2e，
 * CI 下跳过 copy-asr 以减少启动前的网络等待。
 */
const webServerCommand = [
  'node scripts/copy-ffmpeg-core.mjs',
  ...(process.env.CI ? [] : ['node scripts/copy-asr-assets.mjs']),
  `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${PORT} --strictPort`,
].join(' && ')

export default defineConfig({
  testDir: './e2e',
  // 导出要跑 FFmpeg.wasm，单个用例可能超过默认 30s
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
    // 编辑器需要真实的媒体解码：关闭静音，允许自动播放
    launchOptions: {
      args: ['--autoplay-policy=no-user-gesture-required'],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      /**
       * 用**系统已安装的 Edge**跑（channel 走系统浏览器，不需要 `playwright install`）。
       *
       * 用途：在没有下载 Playwright 浏览器的机器（比如 CI 之外的本地验证）也能跑回归。
       * 跑法：`pnpm exec playwright test --project=edge`
       * 注：`--project=edge` 只影响跑哪些用例；完整回归仍以 chromium + firefox 为准。
       */
      name: 'edge',
      use: { ...devices['Desktop Edge'], channel: 'msedge' },
    },
    {
      /**
       * 用**系统 Chrome** 跑同一套用例（`channel: 'chrome'` 同样不需要下载）。
       *
       * 为什么值得多这一个：Edge 与 Chrome 共用 Chromium 内核但版本/策略可能不同，
       * 至少能证明用例不是"只在某一台机器的某个浏览器版本上碰巧通过"。
       * 跑法：`pnpm exec playwright test --project=chrome`
       */
      name: 'chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],
  webServer: process.env.FRAMECUT_E2E_URL
    ? undefined
    : {
        // public/ffmpeg 是生成物（.gitignore），全新 clone 必须先复制，否则导出 404。
        //
        // 为什么用「build + preview」而不是 dev server：
        // dev 首启会把 @huggingface/transformers / onnxruntime-web 做依赖预打包，
        // 2 核 CI 上冷启动经常超过 120s，Playwright 会报 webServer 超时；preview
        // 直接跑生产产物，既快又顺带验证了应用构建。ASR 资源（public/onnxruntime、
        // public/vad）不参与 e2e，不需要在启动前复制。
        command: webServerCommand,
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: process.env.CI ? 300_000 : 120_000,
      },
})