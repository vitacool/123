import { useEffect, useRef, useState } from 'react'
import { audioClipDuration } from '../core/audio'
import type { AudioClip, SourceInfo } from '../core/types'
import { getAudioPeaks, type AudioPeaks } from '../services/audioWaveform'
import { useEditorStore } from '../store/EditorProvider'
import { readThemeToken } from '../services/themeTokens'

interface AudioWaveformProps {
  clip: AudioClip
  asset: SourceInfo
  width: number
  height: number
}

/** Draws cached audio peaks for the clip's own source range. */
export function AudioWaveform({ clip, asset, width, height }: AudioWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [peaks, setPeaks] = useState<AudioPeaks | null>(null)
  // 主题变化时重绘（波形颜色是界面色，从 CSS 变量读取）。
  const resolvedTheme = useEditorStore((state) => state.resolvedTheme)

  useEffect(() => {
    let cancelled = false
    setPeaks(null)
    void getAudioPeaks(asset).then(
      (result) => {
        if (!cancelled) setPeaks(result)
      },
      () => undefined,
    )
    return () => {
      cancelled = true
    }
  }, [asset.url])

  useEffect(() => {
    let raf = 0
    const paint = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const pixelWidth = Math.max(2, Math.round(width * ratio))
      const pixelHeight = Math.max(2, Math.round(height * ratio))
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight
      const context = canvas.getContext('2d')
      if (!context) return
      context.clearRect(0, 0, pixelWidth, pixelHeight)
      if (!peaks || peaks.duration <= 0) return
      const duration = audioClipDuration(clip)
      if (duration <= 0) return
      const startRatio = Math.min(1, clip.sourceStart / peaks.duration)
      const endRatio = Math.min(1, clip.sourceEnd / peaks.duration)
      const center = pixelHeight / 2
      context.fillStyle = readThemeToken('--fc-waveform', 'rgba(61, 89, 106, 0.55)')
      const step = Math.max(2, Math.round(2 * ratio))
      for (let x = 0; x < pixelWidth; x += step) {
        const position = x / Math.max(1, pixelWidth)
        const sourcePosition = startRatio + (endRatio - startRatio) * position
        const index = Math.min(
          peaks.peaks.length - 1,
          Math.max(0, Math.round(sourcePosition * (peaks.peaks.length - 1))),
        )
        const amplitude = peaks.peaks[index] * center * 0.9
        context.fillRect(x, center - amplitude, Math.max(1, step - 1), amplitude * 2)
      }
    }
    raf = requestAnimationFrame(paint)
    return () => cancelAnimationFrame(raf)
  }, [peaks, width, height, clip.sourceStart, clip.sourceEnd, resolvedTheme])

  return (
    <canvas
      ref={canvasRef}
      className="audio-waveform"
      aria-hidden="true"
      style={{ width: '100%', height: '100%' }}
    />
  )
}