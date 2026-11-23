import { speedAudioGraph } from './speed'
import type { Clip } from './types'

/**
 * 动画片段烘焙成中间视频时的**音轨参数**（纯函数，便于单测）。
 *
 * 为什么要单独抽出来：中间视频的画面是按 `clipTimelineDuration(clip)` 逐帧渲染的，
 * 所以音轨也必须正好是「时间轴时长」。这里做两件事：
 * 1. 按**源区间** `[sourceStart, sourceEnd]` 截取（不是按时间轴时长截），
 * 2. 用 `core/speed.ts` 的 atempo / asetrate 链把截出来的音频变速成时间轴时长，
 *    分段 / 曲线再逐段处理（见 speedAudioGraph）。
 *
 * 定格 / 图片是静帧：必须走静音源，不能把素材原声带进成片。
 */
export interface AnimatedClipAudioPlan {
  /** 喂给 ffmpeg 的输入参数（`-ss/-t/-i` 或 `anullsrc`）。 */
  inputArgs: string[]
  /** `filter_complex` 片段；null 表示 1x 无需滤镜，直接 map 输入。 */
  filter: string | null
  /** 映射 / 编码参数。 */
  mapArgs: string[]
  /** 是否使用了静音源（定格 / 图片 / 无可用原声）。 */
  silent: boolean
}

export const ANIMATED_AUDIO_LABEL = '[anim_a]'
const SILENT_INPUT_ARGS = ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']

/**
 * @param clip 原始（未烘焙）片段
 * @param audioFileName 已写入 ffmpeg 虚拟文件系统的素材文件名；null 表示拿不到原声
 * @param sourceHasAudio 素材是否带音轨（`SourceInfo.hasAudio`）；false 时即便有文件也走静音，
 *   否则 `-map 1:a` 会因为输入没有音频流而直接失败
 */
export function planAnimatedClipAudio(
  clip: Clip,
  audioFileName: string | null,
  sourceHasAudio?: boolean,
): AnimatedClipAudioPlan {
  const still = clip.type === 'freeze' || clip.type === 'image'
  // 定格 / 图片静音；没有原声文件、或素材本来就没有音轨，也退回静音轨
  // （中间视频必须有一条音轨，否则滤镜图引用会失败）。
  const silent = still || !audioFileName || sourceHasAudio === false
  if (silent) {
    return {
      inputArgs: SILENT_INPUT_ARGS,
      filter: null,
      mapArgs: ['-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '128k', '-shortest'],
      silent: true,
    }
  }
  const sourceStart = Math.max(0, clip.sourceStart)
  const sourceSpan = Math.max(0, clip.sourceEnd - clip.sourceStart)
  const filter = speedAudioGraph(clip, '[1:a]', ANIMATED_AUDIO_LABEL)
  return {
    inputArgs: ['-ss', String(sourceStart), '-t', String(sourceSpan), '-i', audioFileName],
    filter,
    mapArgs: [
      '-map',
      '0:v',
      ...(filter ? ['-filter_complex', filter, '-map', ANIMATED_AUDIO_LABEL] : ['-map', '1:a']),
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-shortest',
    ],
    silent: false,
  }
}