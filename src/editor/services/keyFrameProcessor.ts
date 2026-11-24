import type { KeyFrameProcessor } from './webglKeyer'
import { webglKeyer } from './webglKeyer'
import { cpuKeyFrame } from './cpuChromaKey'

/**
 * 抠像处理器：优先 WebGL；上下文不可用时退回 CPU，避免动画烘焙 / 帧捕获
 * 在无 WebGL 环境里静默输出「没抠」的画面（导出链路与预览共用同一接口）。
 */
export const keyFrameProcessor: KeyFrameProcessor = {
  keyFrame(...args) {
    return webglKeyer.keyFrame(...args) ?? cpuKeyFrame(...args)
  },
}