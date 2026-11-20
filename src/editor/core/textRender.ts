import type { TextClip } from './types'

const DEFAULT_FONT =
  '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", "Songti SC", sans-serif'

function wrapParagraph(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  if (text.length === 0) return ['']
  const lines: string[] = []
  let current = ''
  for (const char of text) {
    const next = current + char
    if (current.length > 0 && context.measureText(next).width > maxWidth) {
      lines.push(current)
      current = char
    } else {
      current = next
    }
  }
  lines.push(current)
  return lines
}

/** 文本层在某一时刻的动画覆盖值（与 drawClipFrame 的 overrides 同构）。 */
export interface TextRenderOverrides {
  /** 画布百分比中心位置。 */
  position?: { x: number; y: number }
  /** 在 fontSize 之上的缩放倍数。 */
  scale?: number
  /** 整体不透明度 0–1。 */
  opacity?: number
}

/** Shared text renderer for preview canvas and exported PNG overlays. */
export function drawTextClip(
  context: CanvasRenderingContext2D,
  clip: TextClip,
  width: number,
  height: number,
  overrides: TextRenderOverrides = {},
): void {
  if (!clip.text.trim()) return
  const scale = Math.max(0.01, overrides.scale ?? clip.scale ?? 1)
  const opacity = Math.max(0, Math.min(1, overrides.opacity ?? clip.opacity ?? 1))
  if (opacity <= 0.0001) return
  const fontSize = Math.max(10, clip.fontSize * height * scale)
  const x = overrides.position?.x ?? clip.x
  const y = overrides.position?.y ?? clip.y
  const family = clip.fontFamily ?? DEFAULT_FONT
  const weight = clip.bold ? 700 : 400
  context.save()
  context.globalAlpha = opacity
  context.font = `${weight} ${fontSize}px ${family}`
  context.textBaseline = 'middle'
  const maxWidth = width * 0.86
  const lines = clip.text
    .split('\n')
    .flatMap((paragraph) => wrapParagraph(context, paragraph, maxWidth))
  const lineHeight = fontSize * 1.26
  const totalHeight = Math.max(lineHeight, lines.length * lineHeight)
  const measured = lines.map((line) => context.measureText(line).width)
  const widest = Math.max(1, ...measured)
  const padX = fontSize * 0.45
  const padY = fontSize * 0.28
  const boxWidth = Math.min(maxWidth + padX * 2, widest + padX * 2)
  const boxHeight = totalHeight + padY * 2
  const centerX = x * width
  const centerY = y * height
  const left =
    clip.align === 'left'
      ? centerX
      : clip.align === 'right'
        ? centerX - boxWidth
        : centerX - boxWidth / 2
  const top = centerY - boxHeight / 2

  if (clip.background && clip.background !== 'transparent') {
    context.fillStyle = clip.background
    context.beginPath()
    if (typeof context.roundRect === 'function') {
      context.roundRect(left, top, boxWidth, boxHeight, fontSize * 0.22)
    } else {
      context.rect(left, top, boxWidth, boxHeight)
    }
    context.fill()
  }

  context.fillStyle = clip.color
  context.textAlign = clip.align
  const strokeWidth =
    clip.strokeWidth && clip.strokeWidth > 0
      ? Math.max(1.2, clip.strokeWidth * fontSize)
      : 0
  if (strokeWidth > 0 && clip.strokeColor) {
    context.strokeStyle = clip.strokeColor
    context.lineWidth = strokeWidth
    context.lineJoin = 'round'
    context.miterLimit = 2
  }
  const textLeft =
    clip.align === 'left'
      ? left + padX
      : clip.align === 'right'
        ? left + boxWidth - padX
        : left + boxWidth / 2
  lines.forEach((line, index) => {
    const y = top + padY + lineHeight * (index + 0.5)
    if (strokeWidth > 0 && clip.strokeColor) {
      context.strokeText(line, textLeft, y, maxWidth)
    }
    context.fillText(line, textLeft, y, maxWidth)
  })
  context.restore()
}