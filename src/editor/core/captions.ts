import { aspectValue } from './aspect'
import { captionFontSize } from './text'
import type { TimelineWord } from './captionMapping'
import type { AspectRatioPreset, CaptionLink, CaptionWord, TextClip } from './types'

export interface CaptionCue {
  start: number
  end: number
  text: string
  /** Word-level timestamps composing this cue (for accurate Enter splitting). */
  words?: CaptionWord[]
  /** Source clip this cue was recognised from (for caption-follows-clip). */
  link?: CaptionLink
}

// ----------------------------------------------------------------------------
// 剪映式断句（词级输入 → 字幕句）
//
// 断句优先级（规则 1）：
//   句末标点（。！？）> 停顿 > 0.45s > 逗号类标点 > 字数/宽度上限
// 所有切点都落在词边界上，绝不把一个词从中间切开。
// ----------------------------------------------------------------------------

const DEFAULT_PAUSE_GAP = 0.45
const DEFAULT_MIN_DURATION = 0.8
const DEFAULT_MAX_DURATION = 6
const DEFAULT_END_PADDING = 0.1
const DEFAULT_MIN_GAP = 0.3
const DEFAULT_MAX_WIDTH_FRACTION = 0.85

/** 每行「等效全角字数」上限，按画幅比例（已放宽，更接近 85% 宽度硬上限）。英文按 42 个半角字符折算。 */
const ENGLISH_CHAR_LIMIT = 42
const HALF_WIDTH_UNIT = 0.5
const CJK_CHAR_LIMITS: Record<AspectRatioPreset, number> = {
  original: 22,
  '16:9': 22,
  '4:3': 22,
  '1:1': 18,
  '9:16': 14,
  '3:4': 14,
}

export const DEFAULT_FILLER_WORDS: readonly string[] = [
  '嗯',
  '啊',
  '呃',
  '额',
  '诶',
  '哦',
  '噢',
  '那个',
  '就是说',
  '就是说呢',
  '然后',
  '就是',
  '这个',
  '嗯嗯',
  '呃呃',
]

export interface CaptionBreakOptions {
  aspectRatio?: AspectRatioPreset
  /** Font size as a fraction of canvas height. Defaults to `captionFontSize`. */
  fontSize?: number
  pauseGap?: number
  minDuration?: number
  maxDuration?: number
  endPadding?: number
  minGap?: number
  maxWidthFraction?: number
  removeFillers?: boolean
  fillers?: readonly string[]
}

interface ResolvedOptions {
  aspectRatio: AspectRatioPreset
  fontSize: number
  pauseGap: number
  minDuration: number
  maxDuration: number
  endPadding: number
  minGap: number
  maxWidthFraction: number
  removeFillers: boolean
  fillers: readonly string[]
}

function resolveOptions(options: CaptionBreakOptions): ResolvedOptions {
  const aspectRatio = options.aspectRatio ?? '16:9'
  return {
    aspectRatio,
    fontSize: options.fontSize ?? captionFontSize(aspectRatio),
    pauseGap: options.pauseGap ?? DEFAULT_PAUSE_GAP,
    minDuration: options.minDuration ?? DEFAULT_MIN_DURATION,
    maxDuration: options.maxDuration ?? DEFAULT_MAX_DURATION,
    endPadding: options.endPadding ?? DEFAULT_END_PADDING,
    minGap: options.minGap ?? DEFAULT_MIN_GAP,
    maxWidthFraction: options.maxWidthFraction ?? DEFAULT_MAX_WIDTH_FRACTION,
    removeFillers: options.removeFillers ?? true,
    fillers: options.fillers ?? DEFAULT_FILLER_WORDS,
  }
}

// ----------------------------------------------------------------------------
// 文本与宽度
// ----------------------------------------------------------------------------

function codePointOf(char: string): number {
  return char.codePointAt(0) ?? 0
}

function isFullWidthChar(char: string): boolean {
  const cp = codePointOf(char)
  return (
    (cp >= 0x2e80 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0xac00 && cp <= 0xd7af)
  )
}

function isHanChar(char: string): boolean {
  const cp = codePointOf(char)
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x20000 && cp <= 0x3134f)
  )
}

/** 全角字符记 1，半角字符记 0.5（英文/数字/半角标点/空格）。 */
export function charWidthUnit(char: string): number {
  return isFullWidthChar(char) ? 1 : HALF_WIDTH_UNIT
}

export function measureWidthUnits(text: string): number {
  let units = 0
  for (const char of text) units += charWidthUnit(char)
  return units
}

export function containsCjk(text: string): boolean {
  return [...text].some(isHanChar)
}

const HARD_END = new Set(['。', '！', '？', '!', '?'])
const SOFT_END = new Set(['，', '、', '；', '：', ',', ';', ':'])
const CLOSERS = new Set(['」', '』', '）', ')', '】', '』', '》', '〉', '"', "'", '”', '’'])

export type PauseClass = 'hard' | 'soft' | null

/**
 * 词尾标点类别：句末标点（。！？）为 hard，逗号类（，、；：）为 soft，其余为 null。
 * 末尾成对引号/括号会先被忽略。
 */
export function captionPauseClass(text: string): PauseClass {
  let tail = text.trimEnd()
  while (tail.length > 0 && CLOSERS.has(tail[tail.length - 1])) {
    tail = tail.slice(0, -1)
  }
  if (tail.length === 0) return null
  const last = tail[tail.length - 1]
  if (HARD_END.has(last)) return 'hard'
  if (SOFT_END.has(last)) return 'soft'
  return null
}

/**
 * 规则 6 的中文清洗：只去掉句号（。 和 .），保留句中逗号/顿号/分号等标点与 ？！、
 * 书名号/引号；中英混排时在英文/数字与中文之间补一个半角空格。
 */
export function cleanCaptionWord(text: string): string {
  let out = text
  // 只去掉句号，保留逗号类标点（剪映保留句中逗号）。
  out = out.replace(/[。.]/g, ' ')
  out = out.replace(
    /([\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef])([A-Za-z0-9])/g,
    '$1 $2',
  )
  out = out.replace(
    /([A-Za-z0-9])([\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef])/g,
    '$1 $2',
  )
  out = out.replace(/\s+/g, ' ')
  return out.trim()
}

function isAsciiAlphaNum(char: string | undefined): boolean {
  return Boolean(char) && /[A-Za-z0-9]/.test(char as string)
}

/** 拼接一句字幕：中文词直接相连，英文词之间补空格。 */
function joinDisplay(parts: string[]): string {
  let out = ''
  for (const part of parts) {
    if (out.length === 0) {
      out = part
      continue
    }
    const needSpace =
      isAsciiAlphaNum(out[out.length - 1]) && isAsciiAlphaNum(part[0])
    out += needSpace ? ` ${part}` : part
  }
  return out
}

/** 每行宽度上限（等效全角字数），取「画幅字数上限」与「85% 画布宽度」中的较小者。 */
export function maxLineUnits(
  aspectRatio: AspectRatioPreset,
  fontSize: number,
  hasCjk: boolean,
  maxWidthFraction: number = DEFAULT_MAX_WIDTH_FRACTION,
): number {
  const readability = hasCjk
    ? CJK_CHAR_LIMITS[aspectRatio]
    : ENGLISH_CHAR_LIMIT * HALF_WIDTH_UNIT
  const byWidth = (maxWidthFraction * aspectValue(aspectRatio)) / fontSize
  return Math.min(readability, byWidth)
}

// ----------------------------------------------------------------------------
// 语气词（规则 7）
// ----------------------------------------------------------------------------

export function isFillerWord(text: string, fillers: readonly string[] = DEFAULT_FILLER_WORDS): boolean {
  return fillers.includes(text.trim())
}

/** 删除「单独出现」的语气词；其余词的时间保持不动，时间连续不断层。 */
export function stripFillers(
  words: readonly TimelineWord[],
  fillers: readonly string[] = DEFAULT_FILLER_WORDS,
): TimelineWord[] {
  return words.filter((word) => !isFillerWord(word.text, fillers))
}

// ----------------------------------------------------------------------------
// 主流程
// ----------------------------------------------------------------------------

interface CaptionToken {
  word: TimelineWord
  display: string
  pauseClass: PauseClass
  start: number
  end: number
}

function toToken(word: TimelineWord): CaptionToken {
  return {
    word,
    display: cleanCaptionWord(word.text),
    pauseClass: captionPauseClass(word.text),
    start: word.start,
    end: word.end,
  }
}

function exceedsLimit(
  current: CaptionToken[],
  next: CaptionToken,
  options: ResolvedOptions,
): boolean {
  const displays = current.map((token) => token.display)
  displays.push(next.display)
  const text = joinDisplay(displays)
  const hasCjk = containsCjk(text)
  return (
    measureWidthUnits(text) >
    maxLineUnits(options.aspectRatio, options.fontSize, hasCjk, options.maxWidthFraction)
  )
}

/** 规则 1：按优先级在词边界上切分。 */
function segmentByPriority(tokens: CaptionToken[], options: ResolvedOptions): CaptionToken[][] {
  const segments: CaptionToken[][] = []
  let current: CaptionToken[] = []

  const flush = (): void => {
    if (current.length > 0) {
      segments.push(current)
      current = []
    }
  }

  for (const token of tokens) {
    // 纯标点 token：只作为断句信号，不参与文本。
    if (token.display === '') {
      if (token.pauseClass !== null) flush()
      continue
    }
    if (current.length === 0) {
      current.push(token)
      continue
    }
    const previous = current[current.length - 1]
    // 规则（修复 A·7）：相邻词来自不同片段时强制断句，避免一句话跨两个片段。
    if (
      token.word.source.clipId !== previous.word.source.clipId ||
      token.word.source.sourceUrl !== previous.word.source.sourceUrl
    ) {
      flush()
    } else if (previous.pauseClass === 'hard') {
      flush()
    } else if (token.start - previous.end > options.pauseGap) {
      flush()
    } else if (previous.pauseClass === 'soft') {
      flush()
    } else if (exceedsLimit(current, token, options)) {
      flush()
    }
    current.push(token)
  }
  flush()
  return segments
}

/** 规则 3：超过最长时长时，在距离 start+maxDuration 最近的词边界切开。 */
function splitLongSegments(
  segments: CaptionToken[][],
  options: ResolvedOptions,
): CaptionToken[][] {
  const result: CaptionToken[][] = []
  for (const segment of segments) {
    let rest = segment
    while (rest.length > 0) {
      const limit = rest[0].start + options.maxDuration
      let cut = 1
      while (cut < rest.length && rest[cut].end <= limit) cut += 1
      result.push(rest.slice(0, cut))
      rest = rest.slice(cut)
    }
  }
  return result
}

/** 规则 4：起止时间以词为准，结束时间 = 末词 end + 0.1s。 */
function cueFromTokens(tokens: CaptionToken[], options: ResolvedOptions): CaptionCue {
  const first = tokens[0].word
  const last = tokens[tokens.length - 1].word
  const words: CaptionWord[] = tokens.map((token) => ({
    text: token.display,
    start: token.start,
    end: token.end,
  }))
  const sourceUrls = new Set(tokens.map((token) => token.word.source.sourceUrl))
  // A link is only meaningful when every word came from the same source asset.
  const link: CaptionLink | undefined =
    sourceUrls.size === 1
      ? {
          clipId: first.source.clipId,
          sourceUrl: first.source.sourceUrl,
          sourceStart: Math.min(...tokens.map((token) => token.word.sourceStart ?? token.start)),
          sourceEnd: Math.max(...tokens.map((token) => token.word.sourceEnd ?? token.end)),
          padStart: 0,
          padEnd: options.endPadding,
        }
      : undefined
  return {
    start: first.start,
    end: last.end + options.endPadding,
    text: joinDisplay(tokens.map((token) => token.display)),
    words,
    link,
  }
}

/** 规则 3：最短 0.8s，向后延长但不得盖到下一条。 */
function enforceMinDuration(cues: CaptionCue[], options: ResolvedOptions): CaptionCue[] {
  return cues.map((cue, index) => {
    if (cue.end - cue.start >= options.minDuration) return cue
    let end = cue.start + options.minDuration
    const next = cues[index + 1]
    if (next && end > next.start) end = next.start
    return { ...cue, end }
  })
}

/** 规则 5：相邻两条间隔 < 0.3s 时，把前一条 end 延长到下一条 start。 */
function enforceAntiFlicker(cues: CaptionCue[], options: ResolvedOptions): CaptionCue[] {
  return cues.map((cue, index) => {
    const next = cues[index + 1]
    if (next && next.start - cue.end < options.minGap) {
      return { ...cue, end: next.start }
    }
    return cue
  })
}

export function buildCaptionsFromWords(
  words: readonly TimelineWord[],
  options: CaptionBreakOptions = {},
): CaptionCue[] {
  const resolved = resolveOptions(options)
  const source = resolved.removeFillers ? stripFillers(words, resolved.fillers) : words
  const tokens = source
    .map(toToken)
    .filter((token) => token.display !== '' || token.pauseClass !== null)
    .sort((left, right) => left.start - right.start)

  const segments = segmentByPriority(tokens, resolved)
  const split = splitLongSegments(segments, resolved)
  let cues = split.map((segment) => cueFromTokens(segment, resolved))
  cues = enforceMinDuration(cues, resolved)
  cues = enforceAntiFlicker(cues, resolved)
  // 修复 A·2：把最短/防闪烁延长等“时间轴时长超出源区间”的部分记进 link.padEnd，
  // 这样 relink 之后字幕保持原时长。
  for (const cue of cues) {
    if (!cue.link || !cue.words || cue.words.length === 0) continue
    const offset = cue.words[0].start - cue.link.sourceStart
    cue.link.padStart = 0
    cue.link.padEnd = cue.end - (cue.link.sourceEnd + offset)
  }
  return cues
}

export interface CaptionSplitParts {
  leftText: string
  rightText: string
  leftStart: number
  leftEnd: number
  rightStart: number
  rightEnd: number
  leftWords?: CaptionWord[]
  rightWords?: CaptionWord[]
}

/**
 * 在光标处把一条字幕拆成两条：文字按光标切，时间尽量落在最近的词边界上
 * （有词级时间戳时）；没有词级时间则按字数比例切。
 */
export function splitCaptionText(clip: TextClip, cursorIndex: number): CaptionSplitParts {
  const text = clip.text
  const index = Math.max(0, Math.min(text.length, cursorIndex))
  const leftText = text.slice(0, index)
  const rightText = text.slice(index)
  const duration = Math.max(0.001, clip.end - clip.start)
  const ratio = text.length > 0 ? index / text.length : 0
  const targetTime = clip.start + duration * ratio

  const words = clip.words
  if (words && words.length > 1) {
    const boundaries = words.slice(1).map((word) => word.start)
    let splitTime = targetTime
    let best = Number.POSITIVE_INFINITY
    for (const boundary of boundaries) {
      if (boundary <= clip.start + 0.001 || boundary >= clip.end - 0.001) continue
      const distance = Math.abs(boundary - targetTime)
      if (distance < best) {
        best = distance
        splitTime = boundary
      }
    }
    return {
      leftText,
      rightText,
      leftStart: clip.start,
      leftEnd: splitTime,
      rightStart: splitTime,
      rightEnd: clip.end,
      leftWords: words.filter((word) => word.start < splitTime - 0.0001),
      rightWords: words.filter((word) => word.start >= splitTime - 0.0001),
    }
  }

  return {
    leftText,
    rightText,
    leftStart: clip.start,
    leftEnd: targetTime,
    rightStart: targetTime,
    rightEnd: clip.end,
  }
}

// ----------------------------------------------------------------------------
// PCM 辅助（供音频抽取复用）
// ----------------------------------------------------------------------------

export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0)
  const length = Math.min(...channels.map((channel) => channel.length))
  if (channels.length === 1) return channels[0].slice(0, length)
  const mono = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    let sum = 0
    for (const channel of channels) sum += channel[i] ?? 0
    mono[i] = sum / channels.length
  }
  return mono
}

export function slicePcm(
  pcm: Float32Array,
  sampleRate: number,
  start: number,
  end: number,
): Float32Array {
  const from = Math.max(0, Math.floor(start * sampleRate))
  const to = Math.min(pcm.length, Math.ceil(end * sampleRate))
  if (to <= from) return new Float32Array(0)
  return pcm.slice(from, to)
}

/** Linear resampling is sufficient for 16 kHz speech recognition input. */
export function resamplePcm(
  pcm: Float32Array,
  inputRate: number,
  outputRate = 16000,
): Float32Array {
  if (pcm.length === 0 || inputRate <= 0 || outputRate <= 0) return new Float32Array(0)
  if (Math.abs(inputRate - outputRate) < 0.001) return pcm.slice()
  const ratio = inputRate / outputRate
  const length = Math.max(1, Math.round(pcm.length / ratio))
  const output = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    const source = i * ratio
    const index = Math.floor(source)
    const fraction = source - index
    const a = pcm[Math.min(index, pcm.length - 1)] ?? 0
    const b = pcm[Math.min(index + 1, pcm.length - 1)] ?? a
    output[i] = a + (b - a) * fraction
  }
  return output
}

/** 采样计算的 RMS（均方根），用于判断音量/是否静音。 */
export function audioRms(pcm: Float32Array): number {
  if (pcm.length === 0) return 0
  const step = Math.max(1, Math.floor(pcm.length / 8000))
  let sum = 0
  let count = 0
  for (let i = 0; i < pcm.length; i += step) {
    sum += pcm[i] * pcm[i]
    count += 1
  }
  return count > 0 ? Math.sqrt(sum / count) : 0
}

export function hasAudibleSignal(pcm: Float32Array, threshold = 0.0015): boolean {
  return audioRms(pcm) > threshold
}