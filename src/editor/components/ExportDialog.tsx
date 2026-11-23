import { useEffect, useMemo, useRef, useState } from 'react'
import { getOutputDimensions } from '../core/aspect'
import { clipTimelineDuration } from '../core/clipTime'
import { animationPerformanceHint } from '../core/animationExport'
import { buildAudioExportPlan } from '../core/exportPlan'
import { exportRangeDuration } from '../core/exportRange'
import { textAnimationPerformanceHint } from '../core/textAnimation'
import { formatFileSize, formatPlayhead } from '../core/format'
import type { ExportFps, ExportLoudness, ExportResolution, SourceInfo } from '../core/types'
import { useEditorStore } from '../store/EditorProvider'
import {
  exportProject,
  getRuntimeCapabilities,
  inspectExportAudio,
  isMp3EncoderAvailable,
  type AudioInspection,
  type ExportFormat,
  type ExportResult,
  type ExportStage,
} from '../services/ffmpegExporter'
import { Icon } from './Icon'

interface ExportDialogProps {
  onExport?: (blob: Blob) => void
  /** 宿主接收单独产出的封面图（未提供时仅在完成页可下载）。 */
  onCoverExport?: (blob: Blob) => void
}

type Phase = 'config' | 'running' | 'done' | 'error'

/** 导出阶段的中文名（进度条上方一行小字）。 */
const STAGE_LABELS: Record<ExportStage, string> = {
  'loading-core': '正在加载 FFmpeg 核心',
  'rendering-animations': '正在渲染动画片段',
  'writing-inputs': '正在写入素材',
  rendering: '正在编码',
  finalizing: '正在收尾',
}

/** 参与导出的素材总量超过该值时的内存预检阈值（粗略提示，不阻断导出）。 */
const MEMORY_WARN_BYTES = 1.5 * 1024 * 1024 * 1024

const isAbortError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { name?: string }).name === 'AbortError'

/**
 * 等待两帧：取消往往在几毫秒内就完成，直接切回配置态会让「正在停止…」
 * 一次都不被绘制。等两帧后再回到可编辑状态，用户能看到反馈。
 */
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      resolve()
      return
    }
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })

const RESOLUTIONS: { id: ExportResolution; label: string; hint: string }[] = [
  { id: '480p', label: '480P', hint: '轻量分享' },
  { id: '720p', label: '720P', hint: '快速导出' },
  { id: '1080p', label: '1080P', hint: '推荐' },
  { id: '4K', label: '4K', hint: '保留细节' },
]

const FRAME_RATES: ExportFps[] = [24, 30, 60]

const LOUDNESS_OPTIONS: { id: ExportLoudness; label: string; hint: string }[] = [
  { id: 'off', label: '关闭', hint: '原音量' },
  { id: 'platform', label: '短视频平台', hint: '-14 LUFS' },
  { id: 'broadcast', label: '广播', hint: '-23 LUFS' },
]

const FORMAT_OPTIONS: { id: ExportFormat; label: string; hint: string }[] = [
  { id: 'mp4', label: 'MP4', hint: '视频' },
  { id: 'm4a', label: 'M4A', hint: 'AAC 音频' },
  { id: 'mp3', label: 'MP3', hint: 'MP3 音频' },
]

function sanitizeBase(name: string): string {
  return (
    name
      .replace(/\.[^.]+$/, '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
      .trim()
      .slice(0, 64) || 'framecut'
  )
}

/** 触发浏览器下载（导出对话框与「导出当前帧」共用）。 */
export function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1200)
}

export function ExportDialog({ onExport, onCoverExport }: ExportDialogProps) {
  const open = useEditorStore((state) => state.exportDialogOpen)
  const project = useEditorStore((state) => state.project)
  const source = useEditorStore((state) => state.source)
  const assets = useEditorStore((state) => state.assets)
  const exportRange = useEditorStore((state) => state.exportRange)
  const close = useEditorStore((state) => state.closeExportDialog)
  const notify = useEditorStore((state) => state.notify)
  const setExportQuality = useEditorStore((state) => state.setExportQuality)

  const [phase, setPhase] = useState<Phase>('config')
  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState('准备中…')
  const [result, setResult] = useState<ExportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [callbackError, setCallbackError] = useState<string | null>(null)
  const [audioCheck, setAudioCheck] = useState<AudioInspection | null>(null)
  const [audioCheckError, setAudioCheckError] = useState<string | null>(null)
  const [checkingAudio, setCheckingAudio] = useState(false)
  const [stage, setStage] = useState<ExportStage>('loading-core')
  /** 导出封装格式（会话状态，不写进 Project）。 */
  const [format, setFormat] = useState<ExportFormat>('mp4')
  /** MP3 编码器支持情况：null = 还没检测过。 */
  const [mp3Support, setMp3Support] = useState<boolean | null>(null)
  /** 正在检测 MP3 编码器。 */
  const [checkingMp3, setCheckingMp3] = useState(false)
  /** 导出范围：全部 / 入出点区间（会话状态，不写进 Project）。 */
  const [rangeMode, setRangeMode] = useState<'all' | 'range'>('all')
  /** 已请求取消、正在等待运行时停止。 */
  const [stopping, setStopping] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const runtime = getRuntimeCapabilities()

  /** 纯音频 plan 只依赖素材与音频轨；有 audioLabel 才允许选择 M4A/MP3。 */
  const exportSources = useMemo<SourceInfo[]>(() => {
    const list: SourceInfo[] = [...assets]
    if (source && !list.some((asset) => asset.url === source.url)) list.unshift(source)
    return list
  }, [assets, source])
  const audioExportPlan = useMemo(() => {
    if (exportSources.length === 0) return null
    try {
      const plan = buildAudioExportPlan(project, exportSources, true)
      return plan.audioLabel ? plan : null
    } catch {
      return null
    }
  }, [project, exportSources])
  const audioAvailable = audioExportPlan !== null

  /**
   * 选择导出格式：MP3 依赖 libmp3lame，首次选择时实际检测一次编码器
   * （结果在 ffmpegExporter 里缓存）。不支持就退回 M4A 并说明原因，
   * 之后再点 MP3 会直接禁用。
   */
  const pickFormat = async (next: ExportFormat): Promise<void> => {
    if (next !== 'mp3') {
      setFormat(next)
      return
    }
    if (mp3Support === false || checkingMp3) return
    if (mp3Support === true) {
      setFormat('mp3')
      return
    }
    setCheckingMp3(true)
    try {
      const supported = await isMp3EncoderAvailable()
      setMp3Support(supported)
      if (supported) {
        setFormat('mp3')
      } else {
        setFormat('m4a')
        notify('当前 FFmpeg 核心不支持 MP3 编码，已改用 M4A', 'warning')
      }
    } finally {
      setCheckingMp3(false)
    }
  }
  useEffect(() => {
    if (audioAvailable) return
    setFormat((current) => (current === 'mp4' ? current : 'mp4'))
  }, [audioAvailable])
  const primarySource = source ?? assets[0] ?? null

  /** 粗略内存预检：只统计真正参与导出的素材（主轨 + 叠加轨 + 音频轨）。 */
  const exportAssetBytes = useMemo(() => {
    const urls = new Set<string>()
    for (const clip of project.clips) urls.add(clip.sourceUrl)
    for (const track of project.overlayTracks ?? []) {
      for (const clip of track.clips) urls.add(clip.sourceUrl)
    }
    for (const track of project.audioTracks ?? []) {
      for (const clip of track.clips) urls.add(clip.sourceUrl)
    }
    const sizeByUrl = new Map(assets.map((asset) => [asset.url, asset.size]))
    let total = 0
    for (const url of urls) {
      total += url === source?.url ? (source?.size ?? 0) : (sizeByUrl.get(url) ?? 0)
    }
    return total
  }, [project.clips, project.overlayTracks, project.audioTracks, assets, source])
  const animationHint = animationPerformanceHint(project, project.exportQuality.fps)
  const textAnimationHint = textAnimationPerformanceHint(project, project.exportQuality.fps)
  const loudness = project.exportQuality.loudness ?? 'off'
  const memoryWarning = exportAssetBytes > MEMORY_WARN_BYTES

  /** 「关闭 / Esc / 点遮罩」的统一入口：导出中先取消，其余情况直接关闭。 */
  const requestAbort = () => {
    if (phase !== 'running') {
      close()
      return
    }
    if (stopping) return
    setStopping(true)
    setStatus('正在停止…')
    abortRef.current?.abort()
  }

  useEffect(() => {
    if (!open) return
    setPhase('config')
    setProgress(0)
    setStatus('准备中…')
    setStage('loading-core')
    setStopping(false)
    setResult(null)
    setError(null)
    setCallbackError(null)
    setAudioCheck(null)
    setAudioCheckError(null)
    setCheckingAudio(false)
    // 有入/出点时默认导出该区间；没有时只能导出全部。
    setRangeMode(exportRange ? 'range' : 'all')
  }, [open])

  // 区间在弹窗打开期间被清除（Alt+X / 撤销导致）时退回「全部」，避免导出空区间。
  useEffect(() => {
    if (!exportRange) setRangeMode('all')
  }, [exportRange])

  // 组件卸载（编辑器销毁）时不要留下还在跑的 wasm 任务。
  useEffect(
    () => () => {
      abortRef.current?.abort()
      abortRef.current = null
    },
    [],
  )

  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (phase === 'running') requestAbort()
      else close()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, phase, close, stopping])

  if (!open) return null

  const duration = project.clips.reduce(
    (total, clip) => total + Math.max(0, clipTimelineDuration(clip)),
    0,
  )
  /** 选中的导出范围：没有区间或选了「全部」时为 null（导出整条时间轴）。 */
  const exportedRange = rangeMode === 'range' ? exportRange : null
  const exportedDuration = exportedRange ? exportRangeDuration(exportedRange) : duration
  const filenameSource = format === 'mp4' ? source : primarySource
  const extension = format === 'mp4' ? 'mp4' : format
  const filename = filenameSource
    ? `${sanitizeBase(filenameSource.name)}-framecut.${extension}`
    : `framecut.${extension}`
  const isLargeFile = Boolean(source && source.size > 500 * 1024 * 1024)
  const coverFilename = source ? `${sanitizeBase(source.name)}-cover.jpg` : 'framecut-cover.jpg'

  const startExport = async () => {
    const exportSource = format === 'mp4' ? source : primarySource
    if (!exportSource) return
    if (format === 'mp4' && project.clips.length === 0) return
    if (format !== 'mp4' && !audioAvailable) return
    // MP3 已经检测过且不支持时不再放行（exportProject 里还有一层兜底）。
    if (format === 'mp3' && mp3Support === false) return
    const controller = new AbortController()
    abortRef.current = controller
    setPhase('running')
    setProgress(0)
    setStage('loading-core')
    setStopping(false)
    setStatus('正在加载 FFmpeg…')
    setError(null)
    setCallbackError(null)
    setAudioCheck(null)
    setAudioCheckError(null)
    try {
      const exported = await exportProject(
        project,
        exportSource,
        assets,
        {
          onStatus: setStatus,
          onProgress: setProgress,
          onStage: setStage,
        },
        { signal: controller.signal, format, range: exportedRange },
      )
      setResult(exported)
      setPhase('done')
      if (onExport) {
        try {
          await Promise.resolve(onExport(exported.blob))
        } catch {
          setCallbackError('宿主平台的 onExport 回调执行失败，文件已生成但未提交。')
        }
      } else {
        triggerDownload(exported.blob, filename)
      }
      if (exported.cover && onCoverExport) {
        try {
          await Promise.resolve(onCoverExport(exported.cover))
        } catch {
          setCallbackError('宿主平台的 onCoverExport 回调执行失败，封面图已生成但未提交。')
        }
      }
    } catch (caught) {
      // 取消不是错误：直接回到可以重新配置的初始态。
      if (isAbortError(caught) || controller.signal.aborted) {
        await nextFrame()
        setPhase('config')
        setProgress(0)
        setStage('loading-core')
        setStatus('准备中…')
        return
      }
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(message)
      setPhase('error')
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setStopping(false)
    }
  }

  const checkAudio = async () => {
    if (!result) return
    setCheckingAudio(true)
    setAudioCheckError(null)
    try {
      const inspection = await inspectExportAudio(result.blob)
      setAudioCheck(inspection)
    } catch (caught) {
      setAudioCheckError(
        caught instanceof Error ? caught.message : String(caught),
      )
    } finally {
      setCheckingAudio(false)
    }
  }

  const width = source
    ? getOutputDimensions(project.aspectRatio, project.exportQuality.resolution, source).width
    : 0
  const height = source
    ? getOutputDimensions(project.aspectRatio, project.exportQuality.resolution, source).height
    : 0

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (phase === 'running') requestAbort()
        else close()
      }}
    >
      <div className="export-dialog" role="dialog" aria-modal="true" aria-label="导出影片">
        <header className="export-head">
          <div>
            <p className="panel-eyebrow">EXPORT · 本地渲染</p>
            <h2>
              {phase === 'config' && '导出影片'}
              {phase === 'running' && '正在合成'}
              {phase === 'done' && '导出完成'}
              {phase === 'error' && '导出遇到问题'}
            </h2>
            {phase === 'running' && (
              <p className="export-stage" role="status">
                {stopping ? '正在停止…' : STAGE_LABELS[stage]}
              </p>
            )}
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={
              phase === 'running'
                ? stopping
                  ? '正在停止导出'
                  : '取消导出'
                : '关闭导出弹窗'
            }
            title={
              phase === 'running'
                ? stopping
                  ? '正在停止…'
                  : '取消导出（Esc）'
                : '关闭'
            }
            disabled={stopping}
            onClick={requestAbort}
          >
            <Icon name="close" size={17} />
          </button>
        </header>

        {animationHint && (
          <div className="export-warning export-animation-warning" role="status">
            <Icon name="warning" size={16} />
            <span>{animationHint}</span>
          </div>
        )}

        {textAnimationHint && (
          <div className="export-warning export-animation-warning" role="status">
            <Icon name="warning" size={16} />
            <span>{textAnimationHint}</span>
          </div>
        )}

        {memoryWarning && (
          <div className="export-warning export-memory-warning" role="status">
            <Icon name="warning" size={16} />
            <span>
              素材总量较大，浏览器可能内存不足，建议先在本地压缩或分段导出
              <span className="export-warning-meta">
                （合计 {formatFileSize(exportAssetBytes)}）
              </span>
            </span>
          </div>
        )}

        {phase === 'config' && (
          <div className="export-body">
            <div className="export-callout">
              <span className="export-callout-icon">
                <Icon name="film" size={18} />
              </span>
              <div>
                <strong>在浏览器本地完成合成</strong>
                <p>视频不会上传。FFmpeg.wasm 使用 H.264 / AAC 生成 MP4。</p>
              </div>
              <span className="local-chip">
                <span className="live-dot" />
                不上传
              </span>
            </div>

            <section className="export-section">
              <div className="export-section-head">
                <h3>格式</h3>
                <span>MP4 含视频；M4A / MP3 仅导出音频</span>
              </div>
              <div className="fps-row" role="group" aria-label="导出格式">
                {FORMAT_OPTIONS.map((option) => {
                  const audioOption = option.id !== 'mp4'
                  const mp3Unsupported = option.id === 'mp3' && mp3Support === false
                  const disabled = (audioOption && !audioAvailable) || mp3Unsupported || checkingMp3
                  return (
                    <button
                      key={option.id}
                      type="button"
                      className={`fps-option${format === option.id ? ' is-active' : ''}`}
                      onClick={() => void pickFormat(option.id)}
                      aria-pressed={format === option.id}
                      disabled={disabled}
                      title={
                        mp3Unsupported
                          ? '当前 FFmpeg 核心不支持 MP3 编码，请改用 M4A'
                          : audioOption && !audioAvailable
                            ? '当前工程没有可用音频，只能导出 MP4'
                            : checkingMp3
                              ? '正在检测 MP3 编码器…'
                              : option.id === 'mp4'
                                ? '导出视频 MP4'
                                : `仅音频导出 ${option.label}`
                      }
                    >
                      {option.label} <span>{option.hint}</span>
                    </button>
                  )
                })}
              </div>
              {!audioAvailable && (
                <p className="control-note">
                  当前工程没有可用音频，M4A / MP3 已禁用。
                </p>
              )}
            </section>

            <section className="export-section">
              <div className="export-section-head">
                <h3>画质</h3>
                <span>输出不会超过源视频分辨率</span>
              </div>
              <div className="quality-grid">
                {RESOLUTIONS.map((resolution) => {
                  const dimensions = source
                    ? getOutputDimensions(project.aspectRatio, resolution.id, source)
                    : null
                  return (
                    <button
                      key={resolution.id}
                      type="button"
                      className={`quality-card${
                        project.exportQuality.resolution === resolution.id ? ' is-active' : ''
                      }`}
                      onClick={() =>
                        setExportQuality({ ...project.exportQuality, resolution: resolution.id })
                      }
                      aria-pressed={project.exportQuality.resolution === resolution.id}
                    >
                      <span className="quality-label">{resolution.label}</span>
                      <span className="quality-res">
                        {dimensions ? `${dimensions.width} × ${dimensions.height}` : '—'}
                      </span>
                      <span className="quality-hint">{resolution.hint}</span>
                    </button>
                  )
                })}
              </div>
            </section>

            <section className="export-section">
              <div className="export-section-head">
                <h3>帧率</h3>
                <span>24 电影感 · 30 通用 · 60 流畅</span>
              </div>
              <div className="fps-row" role="group" aria-label="帧率">
                {FRAME_RATES.map((fps) => (
                  <button
                    key={fps}
                    type="button"
                    className={`fps-option${
                      project.exportQuality.fps === fps ? ' is-active' : ''
                    }`}
                    onClick={() => setExportQuality({ ...project.exportQuality, fps })}
                    aria-pressed={project.exportQuality.fps === fps}
                  >
                    {fps} <span>fps</span>
                  </button>
                ))}
              </div>
            </section>

            <section className="export-section">
              <div className="export-section-head">
                <h3>导出范围</h3>
                <span>时间轴上按 I / O 打入点与出点，Alt+X 清除</span>
              </div>
              <div className="fps-row" role="group" aria-label="导出范围">
                <button
                  type="button"
                  className={`fps-option${rangeMode === 'all' ? ' is-active' : ''}`}
                  onClick={() => setRangeMode('all')}
                  aria-pressed={rangeMode === 'all'}
                >
                  全部 <span>整条时间轴</span>
                </button>
                <button
                  type="button"
                  className={`fps-option${rangeMode === 'range' ? ' is-active' : ''}`}
                  onClick={() => setRangeMode('range')}
                  aria-pressed={rangeMode === 'range'}
                  disabled={!exportRange}
                  title={
                    exportRange
                      ? '只导出入点与出点之间的这一段'
                      : '还没有入点 / 出点：在时间轴上按 I 设入点、O 设出点'
                  }
                >
                  入出点区间
                  <span>
                    {exportRange ? `${exportRangeDuration(exportRange).toFixed(1)} 秒` : '未设置'}
                  </span>
                </button>
              </div>
              {!exportRange && (
                <p className="control-note">
                  还没有入点 / 出点：在时间轴上按 I 设入点、O 设出点，Alt+X 清除。
                </p>
              )}
            </section>

            <section className="export-section">
              <div className="export-section-head">
                <h3>音量标准化</h3>
                <span>关闭时保持原音量；平台 -14 LUFS，广播 -23 LUFS</span>
              </div>
              <div className="fps-row" role="group" aria-label="音量标准化">
                {LOUDNESS_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`fps-option${loudness === option.id ? ' is-active' : ''}`}
                    onClick={() =>
                      setExportQuality({
                        ...project.exportQuality,
                        loudness: option.id,
                      })
                    }
                    aria-pressed={loudness === option.id}
                  >
                    {option.label} <span>{option.hint}</span>
                  </button>
                ))}
              </div>
            </section>

            <div className="export-summary">
              <div>
                <span>成片</span>
                <strong>
                  {width} × {height}
                </strong>
              </div>
              <div>
                <span>时长</span>
                <strong>{formatPlayhead(exportedDuration, project.exportQuality.fps)}</strong>
              </div>
              <div>
                <span>片段</span>
                <strong>{project.clips.length}</strong>
              </div>
              <div>
                <span>标记</span>
                <strong>{project.markers.length}</strong>
              </div>
            </div>

            {isLargeFile && source && (
              <div className="export-warning">
                <Icon name="warning" size={16} />
                <span>
                  文件大小 {formatFileSize(source.size)}。建议使用不超过 500MB
                  的素材，过大文件可能因浏览器内存限制而合成失败。
                </span>
              </div>
            )}

            <div className={`export-warning${runtime.multiThread ? ' is-ok' : ''}`}>
              <Icon name={runtime.multiThread ? 'spark' : 'warning'} size={16} />
              <span>
                {runtime.multiThread
                  ? 'SharedArrayBuffer 已启用，将优先使用多线程 FFmpeg；若核心自检失败会自动切换为单线程。'
                  : runtime.reason ??
                    '当前环境无法使用 SharedArrayBuffer，将降级为单线程 FFmpeg，导出速度会较慢。'}
              </span>
            </div>

            <div className="export-actions">
              <button type="button" className="button ghost" onClick={close}>
                取消
              </button>
              <button
                type="button"
                className="button primary"
                onClick={startExport}
                disabled={!source || project.clips.length === 0}
              >
                <Icon name="export" size={16} />
                开始导出
                <span className="button-meta">
                  {project.exportQuality.resolution} · {project.exportQuality.fps}fps
                </span>
              </button>
            </div>
          </div>
        )}

        {phase === 'running' && (
          <div className="export-body export-running">
            <div className="render-visual" aria-hidden="true">
              <span className="render-orbit orbit-one" />
              <span className="render-orbit orbit-two" />
              <span className="render-core">
                <Icon name="film" size={23} />
              </span>
            </div>
            <p className="render-status">{status}</p>
            <div
              className={`progress-track${stage === 'rendering' ? '' : ' is-indeterminate'}`}
              role="progressbar"
              aria-valuenow={stage === 'rendering' ? Math.round(progress * 100) : undefined}
              aria-valuetext={stage === 'rendering' ? `${Math.round(progress * 100)}%` : STAGE_LABELS[stage]}
            >
              <span
                style={
                  stage === 'rendering'
                    ? { width: `${Math.max(2, Math.min(100, progress * 100))}%` }
                    : undefined
                }
              />
            </div>
            <div className="render-progress-meta">
              {stage === 'rendering' && <span>{Math.round(progress * 100)}%</span>}
              <span>{runtime.multiThread ? '多线程 FFmpeg' : '单线程 FFmpeg'}</span>
            </div>
            <p className="render-note">
              首次导出需要加载约 30–65MB 的本地 FFmpeg 核心；多线程核心会先做一次快速自检，失败时自动切换单线程。导出过程中可以随时取消，取消后可以重新开始。
            </p>
            <div className="export-actions export-actions-running">
              <button
                type="button"
                className="button ghost"
                onClick={requestAbort}
                disabled={stopping}
              >
                <Icon name="close" size={16} />
                {stopping ? '正在停止…' : '取消'}
              </button>
            </div>
          </div>
        )}

        {phase === 'done' && result && (
          <div className="export-body export-done">
            <span className="done-icon">
              <Icon name="check" size={27} />
            </span>
            <h3>{format === 'mp4' ? '影片已经准备好' : '音频已经准备好'}</h3>
            <p>
              {format === 'mp4'
                ? '文件已在浏览器内合成完成。'
                : '音频文件已在浏览器内合成完成。'}
            </p>
            <div className="done-stats">
              {format === 'mp4' ? (
                <div>
                  <span>分辨率</span>
                  <strong>
                    {result.width} × {result.height}
                  </strong>
                </div>
              ) : (
                <div>
                  <span>格式</span>
                  <strong>{format.toUpperCase()}</strong>
                </div>
              )}
              <div>
                <span>{format === 'mp4' ? '帧率' : '时长'}</span>
                <strong>
                  {format === 'mp4'
                    ? `${result.fps} fps`
                    : formatPlayhead(
                        // 有区间时按区间时长显示（audioExportPlan 是按完整时间轴构建的）。
                        exportedRange
                          ? exportRangeDuration(exportedRange)
                          : (audioExportPlan?.totalDuration ?? duration),
                        project.exportQuality.fps,
                      )}
                </strong>
              </div>
              <div>
                <span>大小</span>
                <strong>{formatFileSize(result.blob.size)}</strong>
              </div>
              <div>
                <span>音轨</span>
                <strong>
                  {checkingAudio
                    ? '检测中…'
                    : audioCheck
                      ? audioCheck.hasAudio
                        ? audioCheck.maxVolumeDb === null
                          ? '有声'
                          : `有声 ${audioCheck.maxVolumeDb.toFixed(1)} dB`
                        : '无音轨/静音'
                      : result.hasAudio
                        ? '原声'
                        : '无'}
                </strong>
              </div>
            </div>
            {audioCheck && (
              <div className={`export-warning${audioCheck.hasAudio ? ' is-ok' : ''}`}>
                <Icon name={audioCheck.hasAudio ? 'volume' : 'volumeOff'} size={16} />
                <span>
                  {audioCheck.hasAudio
                    ? audioCheck.maxVolumeDb === null &&
                      audioCheck.meanVolumeDb === null
                      ? `检测到音轨（${
                          audioCheck.codec ??
                          (audioCheck.containerHasAudio ? '容器音轨' : '未知编码')
                        }），但未取到音量数据；文件仍包含音频流。`
                      : `检测到音轨（${audioCheck.codec ?? '未知编码'}）：峰值 ${
                          audioCheck.maxVolumeDb === null
                            ? '-∞'
                            : `${audioCheck.maxVolumeDb.toFixed(1)}`
                        } dB，平均 ${
                          audioCheck.meanVolumeDb === null
                            ? '-∞'
                            : `${audioCheck.meanVolumeDb.toFixed(1)}`
                        } dB。数值越接近 0 越响；-∞ 表示完全静音。`
                    : '导出文件未检测到音频流，或整段为静音。'}
                </span>
              </div>
            )}
            {audioCheckError && (
              <div className="export-warning">
                <Icon name="warning" size={16} />
                <span>音频检测失败：{audioCheckError}</span>
              </div>
            )}
            {(result.warning || callbackError) && (
              <div className="export-warning">
                <Icon name="warning" size={16} />
                <span>{callbackError ?? result.warning}</span>
              </div>
            )}
            <div className="export-actions">
              <button
                type="button"
                className="button ghost"
                onClick={checkAudio}
                disabled={checkingAudio}
              >
                <Icon name="volume" size={16} />
                {checkingAudio ? '检测中…' : '检测音频'}
              </button>
              {result?.cover && (
                <button
                  type="button"
                  className="button ghost"
                  onClick={() => triggerDownload(result.cover!, coverFilename)}
                  title="下载单独产出的封面图（JPG）"
                >
                  <Icon name="camera" size={16} />
                  下载封面
                </button>
              )}
              <button
                type="button"
                className="button ghost"
                onClick={() => {
                  setPhase('config')
                  setResult(null)
                  setProgress(0)
                  setAudioCheck(null)
                  setAudioCheckError(null)
                }}
              >
                再次导出
              </button>
              <button type="button" className="button primary" onClick={close}>
                完成
              </button>
            </div>
            <p className="done-foot">
              {onExport
                ? '已通过 onExport(blob) 提交给宿主平台。'
                : '浏览器下载已开始。宿主集成时可传入 onExport(blob) 接管文件。'}
            </p>
          </div>
        )}

        {phase === 'error' && (
          <div className="export-body export-error">
            <span className="error-icon">
              <Icon name="warning" size={25} />
            </span>
            <h3>这次合成没有完成</h3>
            <p className="error-copy">{error}</p>
            <p className="render-note">
              可以尝试降低画质、减少定格片段或更换素材。若当前为单线程模式，较长的视频可能需要更久。
            </p>
            <div className="export-actions">
              <button type="button" className="button ghost" onClick={close}>
                关闭
              </button>
              <button
                type="button"
                className="button primary"
                onClick={() => {
                  setPhase('config')
                  setError(null)
                }}
              >
                返回设置
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}