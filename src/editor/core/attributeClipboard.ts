import { clipFadeIn, clipFadeOut, clipVolume } from './clipAudio'
import { clipBlendMode, clipOpacity } from './blend'
import {
  clampSpeed,
  clipKeepsPitch,
  clipSpeedValue,
  normalizeSpeedCurve,
  normalizeSpeedSegments,
} from './speed'
import type { BlendMode, Clip, CropRect, Point } from './types'

/**
 * 画面属性（视觉）：不含片段身份字段（id / sourceUrl / sourceStart / sourceEnd / type）、
 * 也不含 speed / transitionOut（变速见下面的 SpeedAttrs）。
 */
export interface VisualAttrs {
  rotation?: number
  flipH?: boolean
  flipV?: boolean
  crop?: CropRect
  scale?: number
  position?: Point
  opacity?: number
  blendMode?: BlendMode
  /** 片段有调色字段时一并复制。 */
  color?: Clip['color']
  /** 形状蒙版：有蒙版才复制（与 color 同样的约定）。 */
  mask?: Clip['mask']
  /** 色度抠像：有抠像才复制。 */
  chromaKey?: Clip['chromaKey']
}

/** 音频属性：只包含音量与淡入淡出。 */
export interface AudioAttrs {
  volume?: number
  fadeIn?: number
  fadeOut?: number
}

/**
 * 变速属性：常规倍率 / 分段 / 平滑曲线三者一起走剪贴板。
 *
 * 为什么单独一组而不是塞进 VisualAttrs：
 * - 变速会改片段的时间轴时长，粘到定格 / 图片片段上等于偷偷改停留时长，
 *   所以粘贴时必须能按片段类型过滤（见 createPasteSpeedAttributesCommand）；
 * - 三者互斥（分段与曲线只认一个，见 segmentPlan）：粘贴时要把另一路显式写回
 *   undefined，否则「复制曲线片段 → 粘到分段片段」会留下旧的分段覆盖曲线。
 */
export interface SpeedAttrs {
  speed?: number
  keepPitch?: boolean
  speedSegments?: Clip['speedSegments']
  speedCurve?: Clip['speedCurve']
}

export interface AttributeClipboard {
  visual: VisualAttrs | null
  audio: AudioAttrs | null
  speed: SpeedAttrs | null
}

/**
 * 属性剪贴板是**模块级单例**（内存态，不持久化、不进草稿、不进撤销栈）。
 *
 * 取舍说明：与 editorStore 内的片段剪贴板（`ClipboardPayload`）保持一致 ——
 * 同一页面里若挂载多个编辑器实例，它们会共享这份剪贴板。
 * 这是「剪贴板属于会话级临时数据」的既定取舍，而不是按实例隔离。
 */
let clipboard: AttributeClipboard = { visual: null, audio: null, speed: null }

const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** 供 useSyncExternalStore 订阅（粘贴按钮的 disabled 状态需要跟随剪贴板变化）。 */
export function subscribeAttributeClipboard(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 稳定的快照引用：只在内容变化时替换对象，避免无谓重渲染。 */
export function getAttributeClipboardSnapshot(): AttributeClipboard {
  return clipboard
}

// ---------------------------------------------------------------- 取值 / 写入

/** 取片段当前的画面属性（缺省值按实际生效值归一化后再存）。 */
export function captureVisualAttrs(clip: Clip): VisualAttrs {
  const attrs: VisualAttrs = {
    rotation: clip.rotation,
    flipH: clip.flipH,
    flipV: clip.flipV,
    crop: { ...clip.crop },
    scale: clip.scale,
    position: { ...clip.position },
    opacity: clipOpacity(clip),
    blendMode: clipBlendMode(clip),
  }
  // 只有源片段真的有 color 字段时才复制，避免把「默认调色」硬写进其它片段。
  if (clip.color) attrs.color = { ...clip.color }
  // 蒙版同理：没有蒙版就不写字段（粘贴到其它片段时不会凭空加蒙版）。
  if (clip.mask) attrs.mask = { ...clip.mask }
  if (clip.chromaKey) attrs.chromaKey = { ...clip.chromaKey }
  return attrs
}

/** 取片段当前的音频属性（缺省值按实际生效值归一化后再存）。 */
export function captureAudioAttrs(clip: Clip): AudioAttrs {
  return {
    volume: clipVolume(clip),
    fadeIn: clipFadeIn(clip),
    fadeOut: clipFadeOut(clip),
  }
}

/**
 * 取片段当前的变速属性：倍率 / 保持音调一定带上；
 * 分段与曲线只在片段真的有、且归一化后仍然成立时才写字段
 * （这样「复制一个 1x 片段 → 粘贴」会清掉目标的变速，而不会凭空造出分段）。
 */
export function captureSpeedAttrs(clip: Clip): SpeedAttrs {
  const attrs: SpeedAttrs = {
    speed: clipSpeedValue(clip),
    keepPitch: clipKeepsPitch(clip),
  }
  const segments = normalizeSpeedSegments(clip.speedSegments)
  if (segments) attrs.speedSegments = segments.map((segment) => ({ ...segment }))
  const curve = normalizeSpeedCurve(clip.speedCurve)
  if (curve) attrs.speedCurve = curve.map((point) => ({ ...point }))
  return attrs
}

/**
 * 把剪贴板里的变速属性整理成可以直接写进 `Clip` 的补丁：
 * - 分段与曲线互斥，没有的那一路显式写 undefined，避免旧值盖住新值；
 * - 倍率夹到 0.1–10。
 */
export function speedAttrsPatch(attrs: SpeedAttrs): Partial<Clip> {
  return {
    speed: clampSpeed(attrs.speed ?? 1),
    keepPitch: attrs.keepPitch !== false,
    speedSegments: attrs.speedSegments ? normalizeSpeedSegments(attrs.speedSegments) : undefined,
    speedCurve: attrs.speedCurve ? normalizeSpeedCurve(attrs.speedCurve) : undefined,
  }
}

export function setVisual(attrs: VisualAttrs | null): void {
  clipboard = { ...clipboard, visual: attrs }
  emit()
}

export function setAudio(attrs: AudioAttrs | null): void {
  clipboard = { ...clipboard, audio: attrs }
  emit()
}

export function setSpeed(attrs: SpeedAttrs | null): void {
  clipboard = { ...clipboard, speed: attrs }
  emit()
}

export function getVisual(): VisualAttrs | null {
  return clipboard.visual
}

export function getAudio(): AudioAttrs | null {
  return clipboard.audio
}

export function getSpeed(): SpeedAttrs | null {
  return clipboard.speed
}

export function hasVisual(): boolean {
  const visual = clipboard.visual
  return Boolean(visual && Object.keys(visual).length > 0)
}

export function hasAudio(): boolean {
  const audio = clipboard.audio
  return Boolean(audio && Object.keys(audio).length > 0)
}

export function hasSpeed(): boolean {
  const speed = clipboard.speed
  return Boolean(speed && Object.keys(speed).length > 0)
}

/** 清空三组剪贴板（测试/重置用）。 */
export function clear(): void {
  clipboard = { visual: null, audio: null, speed: null }
  emit()
}