import type { ExportResolution } from './types'

/**
 * 导出前的内存风险分级（纯函数，便于单测）。
 *
 * 为什么需要：FFmpeg.wasm 的堆在浏览器里是硬上限，超了就是
 * `Cannot enlarge memory arrays` —— 而且通常发生在**进度 80–90%**，
 * 用户已经等了十几分钟才失败，体验极差。
 *
 * 现有提示只看「素材总量 > 1.5GB」和「动画帧数」，**没有考虑输出分辨率**：
 * 同样是 1.4GB 素材，4K 的滤镜链与帧缓冲要吃掉约 4 倍于 1080p 的内存。
 * 这里补上这个维度，并且只在真的接近上限时给结论（不做假精确的百分比）。
 */

export type MemoryRiskLevel = 'ok' | 'warn' | 'risk'

export interface MemoryRiskInput {
  /** 参与导出的素材总量（字节）。 */
  assetBytes: number
  /** 导出分辨率（来自 exportQuality.resolution）。 */
  resolution: ExportResolution
  /** 工程时长（秒）：决定要压多少帧，也影响滤镜链驻留时间。 */
  durationSeconds: number
  /** 需要逐帧烘焙的动画总帧数（没有动画就是 0）。 */
  animationFrames?: number
}

export interface MemoryRiskAssessment {
  level: MemoryRiskLevel
  /** 给用户的一句话结论（ok 时为 null）。 */
  message: string | null
  /** 最有效的降风险建议（按收益排序，ok 时为空）。 */
  suggestions: string[]
}

/** 各输出分辨率的内存权重（以 480p 为 1）。像素数比例近似取整。 */
const RESOLUTION_WEIGHT: Record<ExportResolution, number> = {
  '480p': 1,
  '720p': 2.25,
  '1080p': 5,
  '4K': 20,
}

/** 加权后的「内存压力」经验阈值：超过 warn 提示，超过 risk 明确劝退。 */
export const MEMORY_PRESSURE_WARN = 2.5 * 1024 * 1024 * 1024
export const MEMORY_PRESSURE_RISK = 5 * 1024 * 1024 * 1024

/** 单个动画帧按「一帧 RGBA 画布 + 中间产物」的粗略占用估算（字节）。 */
const ANIMATION_FRAME_BYTES = 2 * 1024 * 1024

export function assessMemoryRisk(input: MemoryRiskInput): MemoryRiskAssessment {
  const weight = RESOLUTION_WEIGHT[input.resolution] ?? 1
  const assetBytes = Math.max(0, input.assetBytes)
  const animationFrames = Math.max(0, input.animationFrames ?? 0)
  const durationSeconds = Math.max(0, input.durationSeconds)

  /**
   * 压力值 = 素材体积 × 分辨率权重 + 动画帧的额外驻留。
   *
   * 这是**经验模型**，只用来分级，不在界面上展示成"预计占用 X GB"——
   * 那个数字不可能准，反而会误导用户。
   */
  const pressure = assetBytes * weight + animationFrames * ANIMATION_FRAME_BYTES

  if (pressure >= MEMORY_PRESSURE_RISK) {
    const suggestions: string[] = []
    // 降分辨率对 4K/1080p 收益最大，排第一。
    if (input.resolution === '4K') suggestions.push('把画质降到 1080P：内存占用约降到 1/4')
    else if (input.resolution === '1080p') suggestions.push('把画质降到 720P：内存占用约降到 1/2')
    if (animationFrames > 0) suggestions.push('减少带关键帧动画的片段（每个动画片段都要逐帧烘焙）')
    if (durationSeconds > 180) suggestions.push('用导出区间的 I/O 打点，分段导出后再拼接')
    suggestions.push('关闭其它占用内存的标签页/页面后重试')
    return {
      level: 'risk',
      message: `按当前的素材量与 ${input.resolution.toUpperCase()} 输出，浏览器很可能在编码后半程内存不足而失败。`,
      suggestions,
    }
  }

  if (pressure >= MEMORY_PRESSURE_WARN) {
    const suggestions: string[] = []
    if (input.resolution === '4K' || input.resolution === '1080p') {
      suggestions.push('如果导出失败，优先尝试把画质降低一档')
    }
    if (durationSeconds > 180) suggestions.push('长片可用导出区间的 I/O 打点分两段导出')
    return {
      level: 'warn',
      message: `素材量与 ${input.resolution.toUpperCase()} 输出的组合偏重，导出可能较慢或占用大量内存。`,
      suggestions,
    }
  }

  return { level: 'ok', message: null, suggestions: [] }
}