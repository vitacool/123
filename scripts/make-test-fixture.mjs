/**
 * 生成 E2E 用的测试素材：3 秒彩条（testsrc）+ 440Hz 正弦音。
 *
 * 为什么按需生成、不进版本库：
 * 二进制素材会让仓库变大且难以审查；这里用 ffmpeg-static（devDependency）现场生成，
 * 产物放在 tests/e2e/fixtures/（已被 .gitignore 忽略）。
 *
 * 用法：node scripts/make-test-fixture.mjs [--force]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ffmpegPath from 'ffmpeg-static'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const fixturesDir = join(root, 'tests', 'e2e', 'fixtures')
const target = join(fixturesDir, 'clip.mp4')
const force = process.argv.includes('--force')

if (!ffmpegPath) {
  console.error('ffmpeg-static 没有可用的二进制（pnpm approve-builds 是否被跳过？）')
  process.exit(1)
}

if (existsSync(target) && !force) {
  console.log(`测试素材已存在：${target}`)
  process.exit(0)
}

mkdirSync(fixturesDir, { recursive: true })
console.log(`生成测试素材：${target}`)
execFileSync(
  ffmpegPath,
  [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    // 彩条画面
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=320x180:rate=30:duration=3',
    // 正弦音轨
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=3',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-shortest',
    '-movflags',
    '+faststart',
    target,
  ],
  { stdio: 'inherit' },
)
console.log('完成')