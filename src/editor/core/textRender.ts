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
  const italic = clip.italic === true
  const rawShadowColor = clip.shadowColor?.trim()
  const hasShadow = Boolean(
    rawShadowColor && rawShadowColor.toLowerCase() !== 'transparent',
  )
  const finiteOr = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback
  // 阴影的 blur/offset 都按 fontSize 比例存储，保证 480p / 1080p 观感一致。
  const shadowBlur = hasShadow
    ? Math.max(0, finiteOr(clip.shadowBlur, 0)) * fontSize
    : 0
  const shadowOffsetX = hasShadow
    ? finiteOr(clip.shadowOffsetX, 0) * fontSize
    : 0
  const shadowOffsetY = hasShadow
    ? finiteOr(clip.shadowOffsetY, 0) * fontSize
    : 0
  context.save()
  context.globalAlpha = opacity
  const applyTextShadow = (): void => {
    if (!hasShadow) return
    context.shadowColor = rawShadowColor ?? 'transparent'
    context.shadowBlur = shadowBlur
    context.shadowOffsetX = shadowOffsetX
    context.shadowOffsetY = shadowOffsetY
  }
  const clearTextShadow = (): void => {
    if (!hasShadow) return
    context.shadowColor = 'transparent'
    context.shadowBlur = 0
    context.shadowOffsetX = 0
    context.shadowOffsetY = 0
  }
  // 背景框不能带阴影：先确保阴影关闭，再由文字绘制单独打开。
  if (hasShadow) clearTextShadow()
  context.font = `${italic ? 'italic ' : ''}${weight} ${fontSize}px ${family}`
  context.textBaseline = 'middle'
  // 行距/字距按 fontSize 比例存储，保证不同导出分辨率观感一致。
  const lineHeightRatio = Math.min(3, Math.max(0.8, finiteOr(clip.lineHeight, 1.26)))
  const letterSpacingEm = Math.min(0.5, Math.max(-0.2, finiteOr(clip.letterSpacing, 0)))
  // Canvas letterSpacing 在 Chromium 可用；不支持的环境优雅退化为 0（不影响其它排版）。
  const spacingContext = context as CanvasRenderingContext2D & { letterSpacing?: string }
  if ('letterSpacing' in spacingContext) {
    spacingContext.letterSpacing = `${(letterSpacingEm * fontSize).toFixed(2)}px`
  }
  const maxWidth = width * 0.86
  const lines = clip.text
    .split('\n')
    .flatMap((paragraph) => wrapParagraph(context, paragraph, maxWidth))
  const lineHeight = fontSize * lineHeightRatio
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
  const strokeColor = clip.strokeColor
  const hasStroke = strokeWidth > 0 && Boolean(strokeColor)
  if (hasStroke) {
    context.strokeStyle = strokeColor ?? '#000000'
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
  // 有描边时只给描边那次绘制开阴影。描边定义外轮廓，阴影跟着它最干净；
  // 若把阴影开在随后的填充上，阴影会盖在已经画好的描边上，边缘发灰。
  if (hasShadow && !hasStroke) applyTextShadow()
  lines.forEach((line, index) => {
    const y = top + padY + lineHeight * (index + 0.5)
    if (hasStroke) {
      if (hasShadow) applyTextShadow()
      context.strokeText(line, textLeft, y, maxWidth)
      if (hasShadow) clearTextShadow()
    }
    context.fillText(line, textLeft, y, maxWidth)
  })
  if ('letterSpacing' in spacingContext) spacingContext.letterSpacing = '0px'
  context.restore()
}