import { useEffect, useRef, useState } from 'react'
import {
  clearAsrCache,
  createWhisperProvider,
  recognizeAssets,
  type AssetProgress,
  type RecognitionStats,
} from '../services/asr'
import type { TranscribeProvider } from '../services/asr/types'
import type { AsrLanguage } from '../core/asr'
import {
  CAPTION_MODELS,
  DEFAULT_CAPTION_MODEL_ID,
  captionModelInfo,
} from '../core/captionModels'
import { useEditorStore } from '../store/EditorProvider'
import { Icon } from './Icon'

interface AutoCaptionDialogProps {
  open: boolean
  onClose: () => void
  /** Host-injected provider; when set, the built-in model selector is hidden. */
  provider?: TranscribeProvider
}

const STAGE_LABEL: Record<AssetProgress['stage'], string> = {
  prepare: '准备',
  extract: '提取音轨',
  vad: '检测人声',
  transcribe: '识别语音',
  cache: '使用缓存',
  done: '完成',
}

/** 根据诊断数据给出三档建议：静音 / 有声但未检出人声 / 检出人声却 0 词。 */
function diagnosticHint(stats: RecognitionStats | null): string {
  if (!stats) return '建议：清除识别缓存后重试。'
  const rms = stats.audioRms ?? 0
  if (stats.speechSpans === 0) {
    if (rms < 0.003 && stats.vadMaxProb < 0.3) {
      return '素材音量很低或基本静音：请确认素材确实有对白声音，或换一段带人声的素材。'
    }
    return '音量正常但未检测到人声：这段可能是纯音乐/背景音，没有对白；如需给旁白配字幕，请确认主轨确实有人声。'
  }
  if (stats.whisperCalls > 0) {
    return '已检测到人声、也调用了识别，但结果为空：请把语言改成「中文」，并清除识别缓存后重试。'
  }
  return '建议：清除识别缓存后重试。'
}

export function AutoCaptionDialog({ open, onClose, provider }: AutoCaptionDialogProps) {
  const project = useEditorStore((state) => state.project)
  const assets = useEditorStore((state) => state.assets)
  const source = useEditorStore((state) => state.source)
  const selectedClipId = useEditorStore((state) => state.selectedClipId)
  const importAutoCaptions = useEditorStore((state) => state.importAutoCaptions)
  const setAsrWordsBySource = useEditorStore((state) => state.setAsrWordsBySource)
  const realignCaptions = useEditorStore((state) => state.realignCaptions)

  const [language, setLanguage] = useState<AsrLanguage>('zh')
  const [modelId, setModelId] = useState(DEFAULT_CAPTION_MODEL_ID)
  const [clearExisting, setClearExisting] = useState(true)
  const [includeAudio, setIncludeAudio] = useState(true)
  const [includeOverlay, setIncludeOverlay] = useState(false)
  const [scope, setScope] = useState<'all' | 'selected'>('all')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<AssetProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    count: number
    replaced: boolean
    stats: RecognitionStats | null
  } | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort()
      abortRef.current = null
      setRunning(false)
      return
    }
    setError(null)
    setResult(null)
    setProgress(null)
    setRunning(false)
    abortRef.current?.abort()
    abortRef.current = null
  }, [open])

  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  if (!open) return null

  const start = async () => {
    if (running) return
    if (scope === 'selected') {
      const selectedClip = project.clips.find((c) => c.id === selectedClipId)
      const dur = selectedClip ? selectedClip.sourceEnd - selectedClip.sourceStart : 0
      if (!selectedClip || dur < 0.5) {
        setError('「仅选中片段」需要选中主轨上一个至少 0.5 秒的视频片段，且不能是定格片段。')
        return
      }
    }
    setRunning(true)
    setError(null)
    setResult(null)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const engine = provider ?? createWhisperProvider(modelId)
      const output = await recognizeAssets(project, assets, source, {
        language,
        modelId,
        provider: engine,
        includeAudio,
        includeOverlay,
        clipId: scope === 'selected' ? selectedClipId : null,
        signal: controller.signal,
        onProgress: setProgress,
      })
      setAsrWordsBySource(output.wordsBySource)
      const imported = importAutoCaptions(output.timelineWords, { replace: clearExisting })
      setResult({ count: imported, replaced: clearExisting, stats: output.stats })
      setRunning(false)
    } catch (reason) {
      setRunning(false)
      if (reason instanceof DOMException && reason.name === 'AbortError') {
        setError('已取消识别。')
      } else {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      abortRef.current = null
    }
  }

  const reAlign = () => {
    realignCaptions()
  }

  const cancel = () => {
    abortRef.current?.abort()
    setRunning(false)
  }

  const pct = Math.max(0, Math.min(100, progress?.percent ?? 0))
  const busyModel = running && (progress?.stage === 'prepare' || progress?.detail.startsWith('下载模型'))

  return (
    <div className="modal-backdrop" role="presentation" onClick={running ? undefined : onClose}>
      <section
        className="auto-caption-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auto-caption-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <div>
            <p className="panel-eyebrow">本地语音识别</p>
            <h2 id="auto-caption-title">智能字幕</h2>
            <p className="dialog-subtitle">
              {provider
                ? `使用宿主提供的识别引擎「${provider.label}」。`
                : '使用本地 Whisper（词级时间戳 + 人声检测），不会上传素材；首次使用需下载模型。'}
            </p>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="关闭智能字幕"
            title="关闭"
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        {result ? (
          result.count > 0 ? (
            <div className="auto-caption-result">
              <span className="auto-caption-result-icon">
                <Icon name="check" size={22} />
              </span>
              <div>
                <h3>已生成 {result.count} 条字幕</h3>
                <p>
                  {result.replaced ? '已更新“智能字幕”轨。' : '已放入新的“智能字幕”文本轨。'}
                  调整片段顺序后可点「重新对齐」，无需重新识别。
                </p>
              </div>
            </div>
          ) : (
            <div className="auto-caption-result is-empty">
              <span className="auto-caption-result-icon">
                <Icon name="warning" size={22} />
              </span>
              <div>
                <h3>识别到 0 个词</h3>
                <p>
                  素材 {result.stats?.assetCount ?? 0} 个 / 人声片段{' '}
                  {result.stats?.speechSpans ?? 0} 个 / Whisper 调用{' '}
                  {result.stats?.whisperCalls ?? 0} 次 / 命中缓存{' '}
                  {result.stats?.cacheHits ?? 0} 次 / VAD 最大概率{' '}
                  {(result.stats?.vadMaxProb ?? 0).toFixed(3)} / 音量 RMS{' '}
                  {(result.stats?.audioRms ?? 0).toFixed(4)}
                  {result.stats && result.stats.skippedAssets > 0
                    ? ` / 跳过素材 ${result.stats.skippedAssets} 个`
                    : ''}
                </p>
                <p className="control-note">{diagnosticHint(result.stats)}</p>
              </div>
            </div>
          )
        ) : (
          <>
            <div className="auto-caption-grid">
              <label>
                <span>语言</span>
                <select
                  value={language}
                  disabled={running}
                  onChange={(event) => setLanguage(event.target.value as AsrLanguage)}
                >
                  <option value="auto">自动检测</option>
                  <option value="zh">中文</option>
                  <option value="en">英文</option>
                </select>
              </label>
              {!provider && (
                <label>
                  <span>模型</span>
                  <select
                    value={modelId}
                    disabled={running}
                    onChange={(event) => setModelId(event.target.value)}
                  >
                    {CAPTION_MODELS.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                <span>识别范围</span>
                <select
                  value={scope}
                  disabled={running}
                  onChange={(event) => setScope(event.target.value as 'all' | 'selected')}
                >
                  <option value="all">全部</option>
                  <option value="selected">仅选中片段</option>
                </select>
              </label>
              <label className="auto-caption-check">
                <input
                  type="checkbox"
                  checked={includeAudio}
                  disabled={running}
                  onChange={(event) => setIncludeAudio(event.target.checked)}
                />
                <span>识别配音/旁白轨</span>
              </label>
              <label className="auto-caption-check">
                <input
                  type="checkbox"
                  checked={includeOverlay}
                  disabled={running}
                  onChange={(event) => setIncludeOverlay(event.target.checked)}
                />
                <span>包含画中画轨</span>
              </label>
              <label className="auto-caption-check">
                <input
                  type="checkbox"
                  checked={clearExisting}
                  disabled={running}
                  onChange={(event) => setClearExisting(event.target.checked)}
                />
                <span>同时清空已有智能字幕</span>
              </label>
            </div>
            <p className="auto-caption-hint">
              {provider
                ? '按素材识别并缓存，剪辑后无需重复识别。'
                : `${captionModelInfo(modelId).sizeHint}；按素材识别并缓存，纯音乐/静音片段由人声检测自动跳过。`}
            </p>
          </>
        )}

        {running && (
          <div className="auto-caption-progress">
            <div className="auto-caption-progress-head">
              <span>
                {progress ? `素材 ${progress.assetIndex}/${progress.assetCount} · ${STAGE_LABEL[progress.stage]}` : '准备中'}
              </span>
              <span>{busyModel ? '下载中' : `${Math.round(pct)}%`}</span>
            </div>
            <div className={`progress-track${busyModel ? ' is-indeterminate' : ''}`}>
              <span style={busyModel ? undefined : { width: `${Math.max(2, pct)}%` }} />
            </div>
            <p>{progress?.detail ?? '正在准备…'}</p>
          </div>
        )}

        {error && (
          <p className="auto-caption-error" role="alert">
            <Icon name="warning" size={14} />
            {error}
          </p>
        )}

        <div className="dialog-actions">
          {result ? (
            <>
              <button type="button" className="button" onClick={reAlign}>
                <Icon name="spark" size={14} />
                重新对齐
              </button>
              <button type="button" className="button primary" onClick={onClose}>
                完成
              </button>
            </>
          ) : running ? (
            <>
              <button type="button" className="button" onClick={cancel}>
                取消识别
              </button>
              <span className="control-note">取消后会停止后续片段识别</span>
            </>
          ) : (
            <>
              <button
                type="button"
                className="button"
                onClick={onClose}
              >
                取消
              </button>
              <button
                type="button"
                className="button"
                disabled={running}
                onClick={() => void clearAsrCache()}
              >
                清除识别缓存
              </button>
              <button type="button" className="button primary" onClick={start}>
                <Icon name="spark" size={14} />
                开始识别
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  )
}