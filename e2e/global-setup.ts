import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Playwright 全局准备：确保测试素材存在（用 ffmpeg-static 现场生成，不进版本库）。 */
export default function globalSetup(): void {
  const script = 'scripts/make-test-fixture.mjs'
  if (!existsSync('tests/e2e/fixtures/clip.mp4')) {
    execFileSync(process.execPath, [script], { stdio: 'inherit' })
  }
}