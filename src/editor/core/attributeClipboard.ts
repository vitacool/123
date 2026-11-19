import { clipFadeIn, clipFadeOut, clipVolume } from './clipAudio'
import { clipBlendMode, clipOpacity } from './blend'
import type { BlendMode, Clip, CropRect, Point } from './types'

/**
 * 画面属性（视觉）：不含片段身份字段（id / sourceUrl / sourceStart / sourceEnd / type）、
 * 也不含 speed / transitionOut。
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
}

/** 音频属性：只包含音量与淡入淡出。 */
export interface AudioAttrs {
  volume?: number
  fadeIn?: number
  fadeOut?: number
}

export interface AttributeClipboard {
  visual: VisualAttrs | null
  audio: AudioAttrs | null
}

/**
 * 属性剪贴板是**模块级单例**（内存态，不持久化、不进草稿、不进撤销栈）。
 *
 * 取舍说明：与 editorStore 内的片段剪贴板（`ClipboardPayload`）保持一致 ——
 * 同一页面里若挂载多个编辑器实例，它们会共享这份剪贴板。
 * 这是「剪贴板属于会话级临时数据」的既定取舍，而不是按实例隔离。
 */
let clipboard: AttributeClipboard = { visual: null, audio: null }

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

export function setVisual(attrs: VisualAttrs | null): void {
  clipboard = { ...clipboard, visual: attrs }
  emit()
}

export function setAudio(attrs: AudioAttrs | null): void {
  clipboard = { ...clipboard, audio: attrs }
  emit()
}

export function getVisual(): VisualAttrs | null {
  return clipboard.visual
}

export function getAudio(): AudioAttrs | null {
  return clipboard.audio
}

export function hasVisual(): boolean {
  const visual = clipboard.visual
  return Boolean(visual && Object.keys(visual).length > 0)
}

export function hasAudio(): boolean {
  const audio = clipboard.audio
  return Boolean(audio && Object.keys(audio).length > 0)
}

/** 清空两组剪贴板（测试/重置用）。 */
export function clear(): void {
  clipboard = { visual: null, audio: null }
  emit()
}