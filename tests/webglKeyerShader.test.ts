import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * WebGL 抠像着色器的回归守卫。
 *
 * 真实事故：片元着色器使用了 `v_uv`，但只在**顶点**着色器里声明了
 * `varying vec2 v_uv;`。GLSL 里 fragment 必须自己再声明一次，否则编译失败，
 * `isKeyerAvailable()` 会永久缓存「不可用」，抠像在所有浏览器上静默退回原画面
 * （预览看不见效果，导出却用 FFmpeg chromakey —— 预览/导出不一致）。
 *
 * 单测环境没有 WebGL，无法真的编译；这里用源码扫描锁住声明与命名一致，
 * 真正的编译验证由 E2E（animation-mask-parity）覆盖。
 */
const SOURCE = readFileSync(
  join(process.cwd(), 'src/editor/services/webglKeyer.ts'),
  'utf8',
)

function shader(name: 'VERTEX_SHADER' | 'FRAGMENT_SHADER'): string {
  const match = new RegExp(`const ${name} = \`([\\s\\S]*?)\``).exec(SOURCE)
  if (!match) throw new Error(`没有找到 ${name}`)
  return match[1]
}

describe('webglKeyer 着色器源码', () => {
  it('片元着色器声明了与顶点着色器同名的 varying v_uv', () => {
    const vertex = shader('VERTEX_SHADER')
    const fragment = shader('FRAGMENT_SHADER')
    expect(vertex).toMatch(/varying\s+vec2\s+v_uv\s*;/)
    // 关键：fragment 也必须声明，否则 shader 编译失败。
    expect(fragment).toMatch(/varying\s+vec2\s+v_uv\s*;/)
    expect(fragment).toContain('v_uv')
  })
})