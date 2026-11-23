let counter = 0

/**
 * 生成稳定 id。
 *
 * 历史实现只取 `crypto.randomUUID()` 的**前 8 位**（32 位熵），并且不做去重——
 * 同一前缀下几十个 id 就有可观的碰撞概率（生日界：32 位熵在 ~7700 个 id 时
 * 碰撞概率约 1%）。这里改成：
 *
 * - 有 `crypto.randomUUID` 就用完整 UUID（122 位熵）；
 * - 否则用 `crypto.getRandomValues` 取 16 字节（128 位熵）转 hex；
 * - 再没有（非常老的环境）才退回「时间戳 + 自增计数 + Math.random」。
 *
 * **向后兼容**：id 只是不透明字符串，旧数据里的 8 位短 id（如 `clip_1a2b3c4d`）
 * 仍然合法——读旧草稿/旧工程不会受影响，只有新生成的 id 变长。
 */
export function createId(prefix: string): string {
  counter += 1
  return `${prefix}_${randomToken()}`
}

/** 每次调用返回新的随机片段（长度不保证，但对本次运行唯一性足够）。 */
function randomToken(): string {
  const cryptoLike = typeof crypto !== 'undefined' ? crypto : undefined
  if (cryptoLike && typeof cryptoLike.randomUUID === 'function') {
    return cryptoLike.randomUUID()
  }
  if (cryptoLike && typeof cryptoLike.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)
    cryptoLike.getRandomValues(bytes)
    let hex = ''
    for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
    return hex
  }
  // 极老环境：时间戳 + 计数 + 随机（仍有计数保证同一毫秒内不重复）。
  return `${Date.now().toString(36)}_${counter.toString(36)}_${Math.random().toString(36).slice(2)}`
}

/** 旧版 8 位短 id 的形态（用于测试与兼容性检查，不参与生成）。 */
export function isLegacyShortId(id: string): boolean {
  return /^[a-z]+_[0-9a-f]{8}$/i.test(id)
}