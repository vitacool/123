import type {
  AnimatableProperty,
  AnimationMap,
  Clip,
  Easing,
  Keyframe,
  MediaAsset,
  Project,
  ReverseAssetOrigin,
} from './types'

/**
 * 「倒放」= 生成一个新素材，而不是实时反向播放。
 *
 * 原因：浏览器 <video> 不支持反向播放；FFmpeg 的 `reverse` 滤镜会把整段帧缓存
 * 在内存里，wasm 里整段倒放极易 OOM。所以这里把源区间切成约 2 秒的小段，逐段
 * reverse / areverse（每段只在内存里驻留 2 秒的帧），再按逆序 concat 成一个
 * 普通 MP4 新素材。之后的预览与导出都只是在播放一个普通文件，天然一致。
 *
 * 本模块只放纯计算（分段、缩放、文件名、concat 列表、关键帧镜像、替换素材的
 * project 变换），FFmpeg 调用与文件读写见 services/reverseMedia.ts。
 */

/** 每个 reverse 分段的时长（秒）：越短越省内存，越长分段/拼接次数越少。 */
export const REVERSE_CHUNK_SECONDS = 2

/** 超过该时长先提示「耗时较长」，让用户确认。 */
export const REVERSE_CONFIRM_SECONDS = 60

/** 倒放素材长边上限：再大的源也降到 1080，限制每帧内存。 */
export const REVERSE_MAX_LONG_SIDE = 1080

/** 倒放素材的编码质量（比导出更保真，因为它是新素材源）。 */
export const REVERSE_CRF = 18

/** 倒放片段在时间轴上的最短长度（秒）。 */
const REVERSE_MIN_SPAN = 0.05

/** 与导出侧一致的数值格式：最多 4 位小数。 */
const num = (value: number): string => {
  if (!Number.isFinite(value)) return '0'
  return String(Math.round(value * 10000) / 10000)
}

const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2)

export interface ReverseChunk {
  /** 源素材时间（秒）。 */
  start: number
  end: number
  duration: number
}

/**
 * 把源区间 `[sourceStart, sourceEnd]` 按约 `chunkSeconds` 切成若干段（按播放顺序）。
 * 不足半段的尾巴并入前一段，避免出现只含 1~2 帧的分段。
 */
export function reverseChunks(
  sourceStart: number,
  sourceEnd: number,
  chunkSeconds = REVERSE_CHUNK_SECONDS,
): ReverseChunk[] {
  const start = Math.max(0, Number.isFinite(sourceStart) ? sourceStart : 0)
  const end = Number.isFinite(sourceEnd) ? sourceEnd : start
  const span = end - start
  const size = Number.isFinite(chunkSeconds) && chunkSeconds > 0 ? chunkSeconds : REVERSE_CHUNK_SECONDS
  if (span < REVERSE_MIN_SPAN) return []

  const chunks: ReverseChunk[] = []
  let cursor = start
  while (end - cursor > 1e-6) {
    const remaining = end - cursor
    // 尾巴太短就并进上一段（上一段因此略长，仍在内存可控范围内）。
    if (remaining <= REVERSE_MIN_SPAN && chunks.length > 0) {
      const last = chunks[chunks.length - 1]
      last.end = end
      last.duration = end - last.start
      break
    }
    const duration = Math.min(size, remaining)
    // 剩余不足半段时直接吃掉剩余部分，避免产生一个极小的尾段。
    const use = remaining - duration < size * 0.5 ? remaining : duration
    chunks.push({ start: cursor, end: cursor + use, duration: use })
    cursor += use
  }
  return chunks
}

/** 该源区间是否需要用户确认（耗时较长）。 */
export function needsReverseConfirm(span: number): boolean {
  return Number.isFinite(span) && span > REVERSE_CONFIRM_SECONDS
}

/** 未裁剪的源区间长度。 */
export function reverseSpanOf(clip: { sourceStart: number; sourceEnd: number }): number {
  return Math.max(0, clip.sourceEnd - clip.sourceStart)
}

/** 倒放素材的显示名（不含扩展名）。 */
export function reverseAssetName(assetName: string | null | undefined): string {
  const base = (assetName ?? '')
    .replace(/\.[^.]+$/, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .trim()
    .slice(0, 56) || 'framecut'
  return `${base}-倒放`
}

/** 倒放素材的文件名（带 .mp4）。 */
export function reverseAssetFileName(assetName: string | null | undefined): string {
  return `${reverseAssetName(assetName)}.mp4`
}

/**
 * 缩放计划：长边不超过源长边，也不超过 `maxLongSide`（默认 1080），等比、宽高取偶数。
 * 取舍：倒放要把一整段帧缓存在内存里，4K 帧（约 12MB/帧）在 wasm 里几乎必然 OOM；
 * 把长边压到 1080 后单帧约 3MB，2 秒 30fps 的峰值约 190MB，才有可用的余量。
 * 代价是倒放素材的分辨率上限为 1080p —— 但它只是「源素材」，导出分辨率仍由
 * 工程设置决定，1080p 及以下的工程不会有任何损失。
 */
export function reverseScalePlan(
  sourceWidth: number,
  sourceHeight: number,
  maxLongSide = REVERSE_MAX_LONG_SIDE,
): { width: number; height: number; filter: string } {
  const width = Math.max(2, Number.isFinite(sourceWidth) ? sourceWidth : 0)
  const height = Math.max(2, Number.isFinite(sourceHeight) ? sourceHeight : 0)
  const longSide = Math.max(width, height)
  const cap = Number.isFinite(maxLongSide) && maxLongSide >= 2 ? maxLongSide : REVERSE_MAX_LONG_SIDE
  const scale = longSide > cap ? cap / longSide : 1
  const targetWidth = even(width * scale)
  const targetHeight = even(height * scale)
  return {
    width: targetWidth,
    height: targetHeight,
    filter: `scale=${targetWidth}:${targetHeight}:flags=lanczos`,
  }
}

/** 单个分段的输出文件名。 */
export function reverseChunkFile(index: number): string {
  return `rev-chunk-${index}.mp4`
}

/** concat 列表文件名。 */
export const REVERSE_CONCAT_FILE = 'rev-concat.txt'

/** 拼接用的临时输出文件名。 */
export const REVERSE_OUTPUT_FILE = 'rev-output.mp4'

/**
 * 输出时的分段顺序：把「播放顺序的分段」倒过来，
 * 这样每段内部反向 + 段序反向 = 整段反向。
 */
export function reverseOrder(count: number): number[] {
  const total = Math.max(0, Math.floor(count))
  return Array.from({ length: total }, (_, index) => total - 1 - index)
}

/**
 * 一个分段的 FFmpeg 参数：输入定位（-ss/-t 放在 -i 前，只解码需要的区间）→
 * 缩放（先缩小再 reverse，缓存的是缩小后的帧，更省内存）→ reverse / areverse →
 * libx264 / AAC 编码。
 */
export function buildReverseChunkArgs(input: {
  inputFile: string
  outputFile: string
  start: number
  duration: number
  scaleFilter: string
  withAudio: boolean
}): string[] {
  const { inputFile, outputFile, start, duration, scaleFilter, withAudio } = input
  return [
    '-hide_banner',
    '-y',
    '-threads', '1',
    '-ss', num(Math.max(0, start)),
    '-t', num(Math.max(0, duration)),
    '-i', inputFile,
    '-threads', '1',
    '-filter_threads', '1',
    '-map', '0:v:0',
    ...(withAudio ? ['-map', '0:a:0?'] : []),
    '-vf', `${scaleFilter},reverse`,
    ...(withAudio ? ['-af', 'areverse'] : []),
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-x264-params', 'threads=1',
    '-crf', String(REVERSE_CRF),
    '-pix_fmt', 'yuv420p',
    ...(withAudio
      ? ['-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000']
      : ['-an']),
    outputFile,
  ]
}

/** concat 解复用器列表：按给定顺序（应是逆序分段）列出文件。 */
export function buildReverseConcatList(files: readonly string[]): string {
  const lines = ['ffconcat version 1.0']
  for (const file of files) lines.push(`file '${file}'`)
  return `${lines.join('\n')}\n`
}

/**
 * 最终的拼接参数：各段编码参数一致时直接 `-c copy`（不重编码，最快）。
 * `reencode` 为兜底：个别的分段容器参数不一致时 copy 会失败，改成重编码一次即可拼接。
 */
export function buildReverseConcatArgs(input: {
  listFile: string
  outputFile: string
  reencode?: boolean
}): string[] {
  return [
    '-hide_banner',
    '-y',
    '-threads', '1',
    '-f', 'concat',
    '-safe', '0',
    '-i', input.listFile,
    ...(input.reencode
      ? [
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-x264-params', 'threads=1',
          '-crf', String(REVERSE_CRF),
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-ac', '2',
          '-ar', '48000',
        ]
      : ['-c', 'copy']),
    '-movflags', '+faststart',
    input.outputFile,
  ]
}

/**
 * 反向缓动：ease-in 反向就是 ease-out，linear / ease-in-out 反向后语义不变。
 * （hold 不能用「反向缓动」表达，单独的 hold 处理见下面插入辅助帧的说明。）
 */
const MIRRORED_EASE: Record<Easing, Easing> = {
  linear: 'linear',
  easeIn: 'easeOut',
  easeOut: 'easeIn',
  easeInOut: 'easeInOut',
  hold: 'hold',
}

/** 与 core/keyframes.ts 的 TIME_EPSILON 一致：±1e-4 内视为同一时间点。 */
const KEY_TIME_EPSILON = 1e-4

/**
 * hold 镜像时插入的辅助帧间隔。
 * 必须 > KEY_TIME_EPSILON（否则会被当成同一时间点、触发关键帧唯一性约束），
 * 同时足够小，使「跳变时刻」与原片只差 2e-4（≈ 30fps 下 0.006 帧）。
 */
const HOLD_INSERT_GAP = 2e-4

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

/**
/**
 * 关键帧时间镜像：t → 1 - t，使镜像后的动画是原动画的**逆放**。
 *
 * 所有动画属性都镜像（包括音量）：倒放后声音内容也整体反向，
 * 只有把音频包络一起翻过来，声音的起伏才继续跟画面内容对齐。
 * 片段级的 fadeIn / fadeOut 另由 replaceClipSourceInProject 对调。
 *
 * 等价性定义（唯一验收标准）：对任意 t ∈ [0,1]，
 * `evalAnimation(mirror(keys), 1 - t) === evalAnimation(keys, t)`。
 *
 * 实现要点（与 core/animation.ts 的求值语义严格对齐）：
 * - 先按 t 排序再处理；输入列表不保证有序。
 * - `evalAnimation` 在区间 `[k_i, k_{i+1}]` 上用的是**后一帧** `k_{i+1}.ease`。
 *   镜像后这一段变成 `[1-k_{i+1}.t, 1-k_i.t]`，方向是从 `k_{i+1}.value` 到
 *   `k_i.value`，所以缓动要写在镜像段的「后一帧」（来自 `k_i` 的那一帧）上，
 *   取值是反向缓动（easeIn ↔ easeOut，linear / easeInOut 不变）。
 * - `hold` 无法用反向缓动表达：原区间是「保持 k_i.value，到 k_{i+1}.t 才跳到
 *   k_{i+1}.value」；镜像后应在段首「先呈现 k_{i+1}.value，随后立即跳到
 *   k_i.value 并保持」。现有缓动类型表达不了，所以在镜像段的起点之后 2e-4 处
 *   插入一个只用于表达的辅助帧（value = k_i.value, ease = 'hold'）；间隔大于
 *   关键帧唯一性阈值，跳变时刻与原片相差 2e-4，误差只落在该窗口内。
 * - 镜像结果的第一帧（没有前一段）的 ease 取 'linear'。
 *
 * 该函数与自身互逆：`mirror(mirror(keys))` 可能多出 hold 的辅助帧，但除
 * hold 跳变点 ±1e-3 之外与原关键帧求值一致。
 */
export function mirrorAnimationTimes(anim: AnimationMap | undefined): AnimationMap | undefined {
  if (!anim) return undefined
  const entries = Object.entries(anim) as [AnimatableProperty, Keyframe[] | undefined][]
  const next: AnimationMap = {}
  for (const [prop, keys] of entries) {
    if (!keys || keys.length === 0) continue

    const sorted = [...keys].sort((left, right) => left.t - right.t)
    const mirrored: Keyframe[] = []
    // 从末帧往首帧遍历：1 - t 递增，正好得到升序的镜像列表。
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      const current = sorted[index]
      const following = index + 1 < sorted.length ? sorted[index + 1] : null
      // 原区间 [k_index → k_index+1] 的缓动来自「后一帧」；镜像后这段反向，
      // 缓动记在来自 k_index 的这一帧上。
      const segmentEase = following ? MIRRORED_EASE[following.ease ?? 'linear'] : 'linear'
      const isHold = Boolean(following && (following.ease ?? 'linear') === 'hold')

      if (isHold && following) {
        // 镜像段的起点 = 1 - k_index+1.t（已在上一次迭代输出），在它之后插入辅助帧。
        const segmentStart = clamp01(1 - following.t)
        const segmentEnd = clamp01(1 - current.t)
        const insertAt = segmentStart + HOLD_INSERT_GAP
        const hasRoom =
          insertAt <= 1 &&
          segmentEnd - insertAt > KEY_TIME_EPSILON &&
          HOLD_INSERT_GAP > KEY_TIME_EPSILON
        if (hasRoom) {
          mirrored.push({ t: insertAt, value: current.value, ease: 'hold' })
        }
      }

      mirrored.push({
        t: clamp01(1 - current.t),
        value: current.value,
        // hold 段的收尾帧与辅助帧同值，用 linear 即可（值相同，插值无差别）。
        ease: isHold ? 'linear' : segmentEase,
      })
    }
    next[prop] = mirrored
  }
  return Object.keys(next).length > 0 ? next : undefined
}

/** 该素材是否是倒放素材（是则返回它的来源记录）。 */
export function reversedOriginOf(
  asset: { reversedFrom?: ReverseAssetOrigin } | null | undefined,
): ReverseAssetOrigin | null {
  return asset?.reversedFrom ?? null
}

/**
 * 恢复正放时要换回的原始素材：优先按 `assetId` 找（blob URL 刷新后会变，
 * 但 assetId 稳定），找不到再按 `sourceUrl` 兜底。
 */
export function findOriginalAsset(
  origin: ReverseAssetOrigin,
  assets: readonly MediaAsset[],
): MediaAsset | null {
  if (origin.assetId) {
    const byId = assets.find((asset) => asset.id === origin.assetId)
    if (byId) return byId
  }
  if (origin.sourceUrl) {
    const byUrl = assets.find((asset) => asset.url === origin.sourceUrl)
    if (byUrl) return byUrl
  }
  return null
}

/**
 * 倒放片段对应的**原素材区间**（纯函数）。
 *
 * 倒放素材是原区间 `[origin.start, origin.end]` 的逆序拷贝：倒放素材时间 u
 * 对应原素材时间 `origin.end - u`。片段的 `sourceStart/sourceEnd` 是倒放素材上的
 * 时间，所以原区间是 `[end - sourceEnd, end - sourceStart]`，再夹到原区间内。
 *
 * 这样片段被分割 / 裁剪 / 变速之后都自动正确（变速只改时间轴时长，不改源区间），
 * operations.ts 不需要任何改动。
 */
export function originalRangeOf(
  clip: { sourceStart: number; sourceEnd: number },
  origin: ReverseAssetOrigin,
): { start: number; end: number } {
  const low = Math.min(origin.start, origin.end)
  const high = Math.max(origin.start, origin.end)
  const start = Math.min(high, Math.max(low, origin.end - clip.sourceEnd))
  const end = Math.min(high, Math.max(low, origin.end - clip.sourceStart))
  return { start, end }
}

/** 工具栏按钮 / 右键菜单共用的「倒放」可用性判断结果。 */
export interface ReverseActionState {
  /** 片段当前是否处于倒放状态（所用素材带 reversedFrom）。 */
  reversed: boolean
  /** 是否可用。 */
  enabled: boolean
  /** 不可用原因（可直接作为 tooltip / 菜单的 reason）。 */
  reason: string
  /** 可用时的按钮文案：倒放 / 取消倒放。 */
  label: string
  /** 取消倒放时要换回的原素材；不可用或未倒放时为 null。 */
  originalAsset: MediaAsset | null
  /** 取消倒放时要换回的原素材区间。 */
  originalRange: { start: number; end: number } | null
}

/**
 * 「倒放」统一可用性判断（工具栏与右键菜单共用，保证两处禁用条件完全一致）。
 *
 * 常规条件：必须选中主轨/叠加轨的 video 片段、轨道未锁定、素材仍在素材库、
 * 不在裁剪中、没有正在跑的倒放任务。
 * 取消倒放额外要求：原素材还在素材库里（否则文案为「原素材已删除，无法恢复正放」）。
 */
export function reverseActionState(input: {
  clip: Clip | null
  assets: readonly MediaAsset[]
  locked?: boolean
  cropping?: boolean
  /** 是否有倒放任务正在生成（reverseJob !== null）。 */
  busy?: boolean
}): ReverseActionState {
  const { clip, assets, locked = false, cropping = false, busy = false } = input
  const disabled = (reversed: boolean, reason: string): ReverseActionState => ({
    reversed,
    enabled: false,
    reason,
    label: reversed ? '取消倒放' : '倒放',
    originalAsset: null,
    originalRange: null,
  })

  if (!clip) return disabled(false, '先在时间轴选一个视频片段')
  const asset = assets.find((item) => item.url === clip.sourceUrl) ?? null
  const origin = reversedOriginOf(asset)
  const reversed = Boolean(origin)
  if (clip.type !== 'video') return disabled(reversed, '定格 / 图片片段不支持倒放')
  if (cropping) return disabled(reversed, '正在裁剪画面')
  if (locked) return disabled(reversed, '轨道已锁定，请先解锁')
  if (!asset) return disabled(reversed, '素材已移除，无法倒放')
  if (busy) return disabled(reversed, '已有倒放任务在进行中')

  if (!origin) {
    return {
      reversed: false,
      enabled: true,
      reason: '',
      label: '倒放',
      originalAsset: null,
      originalRange: null,
    }
  }

  const originalAsset = findOriginalAsset(origin, assets)
  const originalRange = originalRangeOf(clip, origin)
  if (!originalAsset) {
    return disabled(true, '原素材已删除，无法恢复正放')
  }
  return {
    reversed: true,
    enabled: true,
    reason: '',
    label: '取消倒放',
    originalAsset,
    originalRange,
  }
}

/** 「取消倒放」要生成的命令参数（含一步撤销所需的全部信息）。 */
export interface ReverseRestorePlan {
  input: ReplaceClipSourceInput & { label: string }
  originalAsset: MediaAsset
  originalRange: { start: number; end: number }
}

/**
 * 计算「取消倒放」的命令参数；**返回 null 表示不应该产生任何改动**
 * （片段不在倒放状态，或原素材已经不在素材库里）。
 *
 * 这样「原素材缺失时恢复命令不改动工程」是纯函数的直接结果，UI 与测试共用同一判断。
 */
export function planReverseRestore(input: {
  clip: Clip
  assets: readonly MediaAsset[]
}): ReverseRestorePlan | null {
  const { clip, assets } = input
  const origin = reversedOriginOf(assets.find((asset) => asset.url === clip.sourceUrl))
  if (!origin) return null
  const originalAsset = findOriginalAsset(origin, assets)
  if (!originalAsset) return null
  const originalRange = originalRangeOf(clip, origin)
  return {
    originalAsset,
    originalRange,
    input: {
      clipId: clip.id,
      sourceUrl: originalAsset.url,
      sourceStart: originalRange.start,
      sourceEnd: originalRange.end,
      // 关键帧再镜像一次（与倒放时同一条函数），使动画方向恢复。
      anim: mirrorAnimationTimes(clip.anim),
      label: '取消倒放',
    },
  }
}

/** 生成倒放素材的来源记录（用于复用判断与草稿持久化）。 */
export function reverseAssetOrigin(
  asset: Pick<MediaAsset, 'id' | 'url'>,
  sourceStart: number,
  sourceEnd: number,
): ReverseAssetOrigin {
  return {
    assetId: asset.id,
    sourceUrl: asset.url,
    start: Math.max(0, sourceStart),
    end: Math.max(0, sourceEnd),
  }
}

/** 该素材是否是同一原素材、同一源区间的倒放结果（重复倒放时直接复用）。 */
export function matchesReverseOrigin(
  asset: { reversedFrom?: ReverseAssetOrigin },
  origin: ReverseAssetOrigin,
): boolean {
  const from = asset.reversedFrom
  if (!from) return false
  const sameSource = origin.assetId
    ? from.assetId === origin.assetId
    : from.sourceUrl === origin.sourceUrl
  return sameSource && Math.abs(from.start - origin.start) < 1e-4 && Math.abs(from.end - origin.end) < 1e-4
}

export interface ReplaceClipSourceInput {
  clipId: string
  sourceUrl: string
  sourceStart: number
  sourceEnd: number
  /** 镜像后的动画；`undefined` 表示没有关键帧（保持原样）。 */
  anim?: AnimationMap
  /**
   * 是否对调淡入 / 淡出（默认 true）。倒放时声音内容整体反向，
   * 原本的淡入应当变成淡出；反向切换（恢复正放）时再对调一次即还原。
   */
  swapFades?: boolean
}

/**
 * 对调片段的淡入 / 淡出。
 *
 * 值为 0 时不写字段（保持「缺省 = 0」的既有形状），这样
 * 「倒放 → 恢复正放」两次对调后连字段形状都与原片段一致。
 */
function swapClipFades<T extends Clip>(clip: T): T {
  const fadeIn = clip.fadeOut ?? 0
  const fadeOut = clip.fadeIn ?? 0
  if (fadeIn === (clip.fadeIn ?? 0) && fadeOut === (clip.fadeOut ?? 0)) return clip
  const next = { ...clip } as T & { fadeIn?: number; fadeOut?: number }
  if (fadeIn === 0) delete next.fadeIn
  else next.fadeIn = fadeIn
  if (fadeOut === 0) delete next.fadeOut
  else next.fadeOut = fadeOut
  return next as T
}

/**
 * 把一个片段的素材引用换成倒放素材，并断开挂在它身上的智能字幕链接。
 *
 * - 只改 sourceUrl / sourceStart / sourceEnd / anim：变速、调色、变换、转场、
 *   音量等属性全部原样保留。
 * - 字幕：CaptionLink 记录的是「原素材的源区间」，倒放后语音顺序整体反转，
 *   字幕时间与内容都对不上；继续保留链接会在下一次 relink 里被静默删除或错位，
 *   因此这里统一断开（保留字幕文本与当前位置，由用户重新对齐）并给出提示。
 */
export function replaceClipSourceInProject(
  project: Project,
  input: ReplaceClipSourceInput,
): Project {
  const { clipId, sourceUrl, sourceStart, sourceEnd, anim, swapFades = true } = input
  const apply = <T extends Clip>(clip: T): T => {
    if (clip.id !== clipId) return clip
    const next = { ...clip, sourceUrl, sourceStart, sourceEnd, ...(anim ? { anim } : {}) }
    // 淡入淡出跟着声音方向对调（对称操作，恢复正放时再对调一次即还原）。
    return swapFades ? swapClipFades(next) : next
  }

  let changed = false
  const clips = project.clips.map((clip) => {
    if (clip.id !== clipId) return clip
    changed = true
    return apply(clip)
  })
  const overlayTracks = project.overlayTracks?.map((track) => {
    if (!track.clips.some((clip) => clip.id === clipId)) return track
    changed = true
    return { ...track, clips: track.clips.map((clip) => apply(clip)) }
  })

  // 断开智能字幕链接：link 挂在 TextClip 上，指向该片段。
  const textTracks = project.textTracks?.map((track) => {
    if (!track.clips.some((clip) => clip.link?.clipId === clipId)) return track
    changed = true
    return {
      ...track,
      clips: track.clips.map((clip) => {
        if (clip.link?.clipId !== clipId) return clip
        const { link: _link, ...rest } = clip
        return rest
      }),
    }
  })

  if (!changed) return project
  return {
    ...project,
    clips,
    ...(overlayTracks ? { overlayTracks } : {}),
    ...(textTracks ? { textTracks } : {}),
  }
}

/** 挂在某片段上的智能字幕条数（用于完成后的提示）。 */
export function countLinkedCaptions(project: Project, clipId: string): number {
  let count = 0
  for (const track of project.textTracks ?? []) {
    for (const clip of track.clips) {
      if (clip.link?.clipId === clipId) count += 1
    }
  }
  return count
}