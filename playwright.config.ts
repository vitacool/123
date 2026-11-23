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
  ],
  webServer: process.env.FRAMECUT_E2E_URL
    ? undefined
    : {
        command: `node node_modules/vite/bin/vite.js --port ${PORT} --strictPort`,
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
})