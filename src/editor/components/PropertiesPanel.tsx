import { formatClock } from '../core/format'
import { clipFreezeFrame, clipTimelineDuration } from '../core/clipTime'
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { FREEZE_DEFAULT_DURATION, FREEZE_MAX_DURATION, FREEZE_MIN_DURATION } from '../core/constants'
import { clipVolume } from '../core/clipAudio'
import { clipOpacity } from '../core/blend'
import { findAudioClipLocation } from '../core/audio'
import { findTextClipLocation } from '../core/text'
import { findClipLocation } from '../core/timeline'
import type { Clip, TextClip, TextTrack } from '../core/types'
import { useEditorStore } from '../store/EditorProvider'
import { CommitNumber } from './Toast'
import { CommitSlider } from './CommitSlider'
import { AudioPropertiesPanel } from './AudioPropertiesPanel'
import { ClipAudioSection } from './ClipAudioSection'
import { canChangeClipSpeed, clipSpeedValue } from '../core/speed'
import { clipTransitionOut } from '../core/transition'
import { clipColor } from '../core/color'
import {
  getAttributeClipboardSnapshot,
  subscribeAttributeClipboard,
} from '../core/attributeClipboard'
import { NoSelectionPanel } from './NoSelectionPanel'
import { ClipCompositingSection } from './ClipCompositingSection'
import { ClipTransitionSection } from './ClipTransitionSection'
import { ClipColorSection } from './ClipColorSection'
import { ClipSpeedSection } from './ClipSpeedSection'
import { TextPropertiesPanel } from './TextPropertiesPanel'
import { CaptionListPanel } from './CaptionListPanel'
import { Icon } from './Icon'
import { KeyframeButton } from './KeyframeButton'
import { PanelSection } from './PanelSection'

const round = (value: number, digits = 2): number => Number(value.toFixed(digits))

type PanelTab = 'picture' | 'audio' | 'speed' | 'transition' | 'color'

const PANEL_TABS: readonly { id: PanelTab; label: string }[] = [
  { id: 'picture', label: '画面' },
  { id: 'audio', label: '音频' },
  { id: 'speed', label: '变速' },
  { id: 'transition', label: '转场' },
  { id: 'color', label: '调节' },
]

/** 每个 section 的「恢复默认值」补丁：一次命令提交，1 步撤销。 */

const SECTION_DEFAULTS: Record<string, Partial<Clip>> = {
  rotation: { rotation: 0 },
  mirror: { flipH: false, flipV: false },
  transform: { scale: 1, position: { x: 0, y: 0 } },
  crop: { crop: { x: 0, y: 0, w: 1, h: 1 } },
  compositing: { opacity: 1, blendMode: 'normal' },
  speed: { speed: 1, keepPitch: true },
  audio: { volume: 1, fadeIn: 0, fadeOut: 0 },
}

function CaptionPanelSwitcher({ track, clip }: { track: TextTrack; clip: TextClip }) {
  const [tab, setTab] = useState<'style' | 'list'>('list')
  return (
    <>
      <div className="properties-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'style'}
          className={`properties-tab${tab === 'style' ? ' is-active' : ''}`}
          onClick={() => setTab('style')}
        >
          样式
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'list'}
          className={`properties-tab${tab === 'list' ? ' is-active' : ''}`}
          onClick={() => setTab('list')}
        >
          字幕
        </button>
      </div>
      {tab === 'style' ? (
        <TextPropertiesPanel track={track} clip={clip} />
      ) : (
        <CaptionListPanel track={track} clip={clip} />
      )}
    </>
  )
}

/** 多选时的公共属性摘要（只展示各选中项取值一致的属性）。 */
function MultiSelectionPanel({ ids }: { ids: string[] }) {
  const project = useEditorStore((state) => state.project)
  const deleteSelectedClip = useEditorStore((state) => state.deleteSelectedClip)
  const selectClip = useEditorStore((state) => state.selectClip)
  const copyVisualAttributes = useEditorStore((state) => state.copyVisualAttributes)
  const pasteVisualAttributes = useEditorStore((state) => state.pasteVisualAttributes)
  const copyAudioAttributes = useEditorStore((state) => state.copyAudioAttributes)
  const pasteAudioAttributes = useEditorStore((state) => state.pasteAudioAttributes)
  const attributeClipboard = useSyncExternalStore(
    subscribeAttributeClipboard,
    getAttributeClipboardSnapshot,
  )
  const canPasteVisual = Boolean(
    attributeClipboard.visual && Object.keys(attributeClipboard.visual).length > 0,
  )
  const canPasteAudio = Boolean(
    attributeClipboard.audio && Object.keys(attributeClipboard.audio).length > 0,
  )

  const clips = ids
    .map((id) => findClipLocation(project, id)?.clip ?? null)
    .filter((clip): clip is Clip => clip !== null)
  const tracks = ids
    .map((id) => findClipLocation(project, id)?.track ?? null)
    .filter((track): track is NonNullable<typeof track> => track !== null)

  const totalDuration = clips.reduce((sum, clip) => sum + clipTimelineDuration(clip), 0)
  const shared = <T,>(pick: (clip: Clip) => T): T | null => {
    if (clips.length === 0) return null
    const first = pick(clips[0])
    return clips.every((clip) => pick(clip) === first) ? first : null
  }
  const sharedRotation = shared((clip) => clip.rotation)
  const sharedScale = shared((clip) => clip.scale)
  const sharedType = shared((clip) => clip.type)

  return (
    <aside className="properties-panel" aria-label="多选属性">
      <div className="panel-head">
        <div>
          <p className="panel-eyebrow">多选</p>
          <h2>
            已选中 {ids.length} 项
            <span className="panel-index">仅显示公共属性</span>
          </h2>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={() => selectClip(null)}
          aria-label="取消选择"
          title="取消选择"
        >
          <Icon name="close" size={16} />
        </button>
      </div>

      <div className="panel-scroll">
        <div className="clip-summary">
          <span className="type-pill text">{clips.length} VIDEO</span>
          <span className="summary-duration">{totalDuration.toFixed(1)}s</span>
        </div>

        <section className="panel-section">
          <div className="section-title">
            <span>公共属性</span>
          </div>
          <dl className="freeze-summary">
            <dt>视频片段</dt>
            <dd>{clips.length} 个</dd>
            {tracks.length > 0 && (
              <>
                <dt>叠加轨</dt>
                <dd>{new Set(tracks.map((track) => track.id)).size} 条</dd>
              </>
            )}
            <dt>总时长</dt>
            <dd>{totalDuration.toFixed(2)} s</dd>
            {sharedType && (
              <>
                <dt>类型</dt>
                <dd>{sharedType === 'freeze' ? '定格' : '视频'}</dd>
              </>
            )}
            {sharedRotation !== null && (
              <>
                <dt>旋转</dt>
                <dd>{sharedRotation}°</dd>
              </>
            )}
            {sharedScale !== null && (
              <>
                <dt>缩放</dt>
                <dd>{Math.round(sharedScale * 100)}%</dd>
              </>
            )}
          </dl>
          <p className="control-note">
            各选中项取值不一致的属性已隐藏；单独选中某一项可编辑其全部属性。
          </p>
        </section>

        <section className="panel-section attribute-actions">
          <div className="section-title">
            <span>粘贴属性</span>
            <span className="section-hint">作用于全部选中项</span>
          </div>
          <div className="inline-actions">
            <button
              type="button"
              className="button mini"
              disabled={!canPasteVisual}
              onClick={() => pasteVisualAttributes(ids)}
              title={canPasteVisual ? '粘贴到选中的全部片段（1 步撤销）' : '先复制一个片段的属性'}
            >
              粘贴画面属性
            </button>
            <button
              type="button"
              className="button mini"
              disabled={!canPasteAudio}
              onClick={() => pasteAudioAttributes(ids)}
              title={canPasteAudio ? '粘贴到选中的全部片段（1 步撤销）' : '先复制一个片段的属性'}
            >
              粘贴音频属性
            </button>
          </div>
          <div className="inline-actions">
            <button
              type="button"
              className="button mini ghost-mini"
              disabled={clips.length === 0}
              onClick={() => copyVisualAttributes(ids[0])}
              title="以最先选中的片段为源复制画面属性"
            >
              复制首项画面属性
            </button>
            <button
              type="button"
              className="button mini ghost-mini"
              disabled={clips.length === 0}
              onClick={() => copyAudioAttributes(ids[0])}
              title="以最先选中的片段为源复制音频属性"
            >
              复制首项音频属性
            </button>
          </div>
          <p className="control-note">
            先把属性复制到剪贴板，再点粘贴即可批量套用到选中的片段。
          </p>
        </section>

        <section className="panel-section panel-danger">
          <button type="button" className="button delete-clip" onClick={deleteSelectedClip}>
            <Icon name="trash" size={16} />
            删除选中 {ids.length} 项
            <kbd>Delete</kbd>
          </button>
          <p className="control-note">一次撤销即可恢复全部。</p>
        </section>
      </div>
    </aside>
  )
}

export function PropertiesPanel() {
  const project = useEditorStore((state) => state.project)
  const assets = useEditorStore((state) => state.assets)
  const selectedClipId = useEditorStore((state) => state.selectedClipId)
  const selectedIds = useEditorStore((state) => state.selectedIds)
  const cropSession = useEditorStore((state) => state.cropSession)
  const selectClip = useEditorStore((state) => state.selectClip)
  const setRotation = useEditorStore((state) => state.setRotation)
  const setAnimatableValue = useEditorStore((state) => state.setAnimatableValue)
  const toggleFlipH = useEditorStore((state) => state.toggleFlipH)
  const toggleFlipV = useEditorStore((state) => state.toggleFlipV)
  const fitSelected = useEditorStore((state) => state.fitSelected)
  const fillSelected = useEditorStore((state) => state.fillSelected)
  const resetPosition = useEditorStore((state) => state.resetPosition)
  const beginCrop = useEditorStore((state) => state.beginCrop)
  const resizeFreeze = useEditorStore((state) => state.resizeFreeze)
  const deleteSelectedClip = useEditorStore((state) => state.deleteSelectedClip)
  const setPreviewPatch = useEditorStore((state) => state.setPreviewPatch)
  const setClipAudio = useEditorStore((state) => state.setClipAudio)
  const detachAudio = useEditorStore((state) => state.detachAudio)
  const setClipSpeed = useEditorStore((state) => state.setClipSpeed)
  const setClipBlendMode = useEditorStore((state) => state.setClipBlendMode)
  const setTransition = useEditorStore((state) => state.setTransition)
  const applyTransitionToAll = useEditorStore((state) => state.applyTransitionToAll)
  const closeGapBefore = useEditorStore((state) => state.closeGapBefore)
  const setClipColor = useEditorStore((state) => state.setClipColor)
  const applyColorToAll = useEditorStore((state) => state.applyColorToAll)
  const colorClipboard = useEditorStore((state) => state.colorClipboard)
  const copyClipColor = useEditorStore((state) => state.copyClipColor)
  const pasteClipColor = useEditorStore((state) => state.pasteClipColor)
  const copyVisualAttributes = useEditorStore((state) => state.copyVisualAttributes)
  const pasteVisualAttributes = useEditorStore((state) => state.pasteVisualAttributes)
  const copyAudioAttributes = useEditorStore((state) => state.copyAudioAttributes)
  const pasteAudioAttributes = useEditorStore((state) => state.pasteAudioAttributes)

  // 属性剪贴板是模块级单例，用 useSyncExternalStore 让粘贴按钮的禁用态跟随变化。
  const attributeClipboard = useSyncExternalStore(
    subscribeAttributeClipboard,
    getAttributeClipboardSnapshot,
  )
  const canPasteVisual = Boolean(
    attributeClipboard.visual && Object.keys(attributeClipboard.visual).length > 0,
  )
  const canPasteAudio = Boolean(
    attributeClipboard.audio && Object.keys(attributeClipboard.audio).length > 0,
  )
  const applyClipDefaults = useEditorStore((state) => state.applyClipDefaults)

  const location = findClipLocation(project, selectedClipId)

  // 这些状态在「无选区 / 多选 / 音频 / 文字片段」时也必须按同一次序调用，
  // 因此统一放在所有 early-return 之前。
  const [tab, setTab] = useState<PanelTab>('picture')
  const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>({})
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const scrollByTab = useRef<Partial<Record<PanelTab, number>>>({})
  const clipId = location?.clip.id ?? ''

  // 切 tab 时恢复该 tab 上次的滚动位置。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = scrollByTab.current[tab] ?? 0
  }, [tab])

  // 换片段时回到顶部（各 tab 的滚动记忆只在本片段内有效）。
  const lastClipId = useRef(clipId)
  useLayoutEffect(() => {
    if (lastClipId.current === clipId) return
    lastClipId.current = clipId
    scrollByTab.current = {}
    const el = scrollRef.current
    if (el) el.scrollTop = 0
  }, [clipId])

  const isCollapsed = (id: string) => collapsedMap[id] === true
  const toggleSection = (id: string) =>
    setCollapsedMap((current) => ({ ...current, [id]: !current[id] }))

  // 多选：只显示各选中项的公共属性。
  if (selectedIds.length > 1) {
    return <MultiSelectionPanel ids={selectedIds} />
  }

  if (!location) {
    const audioLocation = findAudioClipLocation(project, selectedClipId)
    if (audioLocation) {
      return (
        <AudioPropertiesPanel track={audioLocation.track} clip={audioLocation.clip} />
      )
    }
    const textLocation = findTextClipLocation(project, selectedClipId)
    if (textLocation) {
      if (textLocation.track.kind === 'caption') {
        return <CaptionPanelSwitcher track={textLocation.track} clip={textLocation.clip} />
      }
      return (
        <TextPropertiesPanel track={textLocation.track} clip={textLocation.clip} />
      )
    }
    return <NoSelectionPanel />
  }
  const clip = location.clip

  const segment = location.segment
  const isOverlay = Boolean(location.track)
  const duration = clipTimelineDuration(clip)
  const freezeDuration = duration
  const isCropping = Boolean(cropSession)
  // 素材已被从素材库移除：画面属性（旋转/裁剪/调色…）都失去意义，但删除与移动仍可用。
  const missingAsset = !assets.some((asset) => asset.url === clip.sourceUrl)
  const disabled = isCropping || missingAsset
  // 转场作用在「本片段 → 下一片段」交界，叠加轨只在同一轨道内相邻。
  const nextTransitionClip = location.track
    ? (location.track.clips[location.track.clips.findIndex((item) => item.id === clip.id) + 1] ?? null)
    : (project.clips[project.clips.findIndex((item) => item.id === clip.id) + 1] ?? null)

  const preview = (patch: Partial<Clip>) => {
    setPreviewPatch({ clipId: clip.id, patch })
  }

  const clearPreview = () => setPreviewPatch(null)

  // 可动画属性统一走 setAnimatableValue：有关键帧时改关键帧，否则改基础值（Toast 区分）。
  const commitRotation = (angle: number) => {
    setAnimatableValue('rotation', angle)
    clearPreview()
  }

  const commitScale = (scale: number) => {
    setAnimatableValue('scale', scale)
    clearPreview()
  }

  const commitPosition = (xPercent: number, yPercent: number) => {
    const x = xPercent / 100
    const y = yPercent / 100
    setAnimatableValue('position.x', x)
    setAnimatableValue('position.y', y)
    clearPreview()
  }

  const commitFreeze = (seconds: number) => {
    resizeFreeze(seconds)
  }

  // 一次点击 = 一个命令 = 1 条撤销：该 section 的所有默认值合并在同一个 patch 里。
  const resetSection = (id: string, label: string) => {
    const patch = SECTION_DEFAULTS[id]
    if (!patch) return
    clearPreview()
    applyClipDefaults(clip.id, patch, `重置${label}`)
  }

  // 定格时长编码在 sourceStart..sourceEnd 里，重置值是「冻结帧 + 默认 3 秒」，
  // 绝不能用 { sourceEnd: 0 } 把时长归零。
  const resetFreeze = () => {
    clearPreview()
    applyClipDefaults(
      clip.id,
      { sourceEnd: clip.sourceStart + FREEZE_DEFAULT_DURATION },
      '重置定格时长',
    )
  }

  const mirrorHint =
    [clip.flipH ? '水平' : '', clip.flipV ? '垂直' : ''].filter(Boolean).join(' + ') || '未启用'

  const clipNumber = segment ? segment.index + 1 : 0

  // 粘贴作用于「当前选中的所有片段」；单选时就是当前片段。
  const pasteTargets = selectedIds.length > 0 ? selectedIds : [clip.id]

  return (
    <aside className={`properties-panel${isCropping ? ' is-cropping' : ''}`} aria-label="片段属性">
      <div className="panel-head">
        <div>
          <p className="panel-eyebrow">片段属性</p>
          <h2>
            {clip.type === 'freeze' ? '定格片段' : '视频片段'}
            <span className="panel-index">#{String(clipNumber).padStart(2, '0')}</span>
          </h2>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={() => selectClip(null)}
          aria-label="收起属性面板"
          title="收起属性面板"
        >
          <Icon name="close" size={16} />
        </button>
      </div>

      <div
        className="panel-scroll"
        ref={scrollRef}
        onScroll={(event) => {
          scrollByTab.current[tab] = event.currentTarget.scrollTop
        }}
      >
        <div className="clip-summary">
          <span className={`type-pill ${clip.type}`}>
            {clip.type === 'freeze' ? 'FREEZE' : 'VIDEO'}
          </span>
          <span className="summary-duration">{formatClock(duration)}</span>
          <span className="summary-dot" />
          <span className="summary-meta">
            {segment ? `从 ${formatClock(segment.start)} 开始` : '—'}
          </span>
        </div>

        {/* 只读的时间信息不再占一个 section，压缩成头部 chips。 */}
        {missingAsset && (
          <section className="panel-section">
            <div className="section-title">
              <span>素材已移除</span>
            </div>
            <p className="control-note">
              该片段的素材已从素材库删除，预览与导出都按画布背景处理；画面属性暂不可编辑，
              仍可移动或删除这个片段。重新导入同一文件后可恢复编辑。
            </p>
          </section>
        )}
        <div className="summary-chips">
          <span className="summary-chip">
            时长 <strong>{duration.toFixed(2)}s</strong>
          </span>
          <span className="summary-chip">
            {clip.type === 'freeze' ? '定格帧' : '源入点'}{' '}
            <strong>{clipFreezeFrame(clip).toFixed(2)}s</strong>
          </span>
          <span className="summary-chip">
            {clip.type === 'freeze' ? '冻结时长' : '源出点'}{' '}
            <strong>
              {clip.type === 'freeze' ? duration.toFixed(2) : clip.sourceEnd.toFixed(2)}s
            </strong>
          </span>
        </div>

        <div className="properties-tabs is-compact" role="tablist" aria-label="片段属性分类">
          {PANEL_TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={`properties-tab${tab === item.id ? ' is-active' : ''}`}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {tab === 'picture' && clip.type === 'freeze' && (
          <PanelSection
            title="定格时长"
            tone="accent"
            hint={`${round(freezeDuration, 1)} s`}
            collapsed={isCollapsed('freeze')}
            onToggle={() => toggleSection('freeze')}
            onReset={resetFreeze}
            resetDisabled={disabled}
          >
            <div className="control-with-field">
              <CommitSlider
                value={freezeDuration}
                min={FREEZE_MIN_DURATION}
                max={FREEZE_MAX_DURATION}
                step={0.1}
                ariaLabel="定格时长"
                disabled={disabled}
                onPreview={(value) =>
                  // 定格时长编码在 sourceStart..sourceEnd 里，预览只改这一段跨度。
                  preview({ sourceEnd: clip.sourceStart + value })
                }
                onCommit={commitFreeze}
                format={(value) => `${value.toFixed(1)}s`}
              />
              <CommitNumber
                value={round(freezeDuration, 1)}
                min={FREEZE_MIN_DURATION}
                max={FREEZE_MAX_DURATION}
                step={0.1}
                unit="s"
                ariaLabel="定格时长（秒）"
                disabled={disabled}
                onPreview={(value) => preview({ sourceEnd: clip.sourceStart + value })}
                onCommit={commitFreeze}
              />
            </div>
            <p className="control-note">也可在时间轴拖动定格片段右边缘调整。</p>
          </PanelSection>
        )}

        {tab === 'picture' && (
          <p className="control-note keyframe-hint">
            <span className="keyframe-hint-diamond" aria-hidden="true" />
            行尾的 ◆ 可在当前播放头给该属性打关键帧（位置 / 缩放 / 旋转在各行，不透明度在「合成」）
          </p>
        )}

        {tab === 'picture' && (
          <PanelSection
            title="旋转"
            hint={`${round(clip.rotation, 0)}°`}
            collapsed={isCollapsed('rotation')}
            onToggle={() => toggleSection('rotation')}
            onReset={() => resetSection('rotation', '旋转')}
            resetDisabled={disabled}
          >
            <div className="control-with-field">
            <CommitSlider
              value={clip.rotation}
              min={-180}
              max={180}
              step={1}
              ariaLabel="旋转角度"
              disabled={disabled}
              onPreview={(value) => preview({ rotation: value })}
              onCommit={commitRotation}
              format={(value) => `${round(value, 0)}°`}
            />
            <CommitNumber
              value={round(clip.rotation, 0)}
              min={-180}
              max={180}
              step={1}
              unit="°"
              ariaLabel="旋转角度（度）"
              disabled={disabled}
              onPreview={(value) => preview({ rotation: value })}
              onCommit={commitRotation}
            />
            <KeyframeButton prop="rotation" clip={clip} />
          </div>
          <div className="inline-actions">
            <button
              type="button"
              className="button mini"
              disabled={disabled}
              onClick={() => {
                setRotation(clip.rotation - 90)
                clearPreview()
              }}
            >
              <Icon name="rotateLeft" size={14} />
              逆时针 90°
            </button>
            <button
              type="button"
              className="button mini"
              disabled={disabled}
              onClick={() => {
                setRotation(clip.rotation + 90)
                clearPreview()
              }}
            >
              <Icon name="rotateRight" size={14} />
              顺时针 90°
            </button>
          </div>
          </PanelSection>
        )}

        {tab === 'picture' && (
          <PanelSection
            title="镜像"
            hint={mirrorHint}
            collapsed={isCollapsed('mirror')}
            onToggle={() => toggleSection('mirror')}
            onReset={() => resetSection('mirror', '镜像')}
            resetDisabled={disabled}
          >
            <div className="flip-row">
            <button
              type="button"
              className={`flip-toggle${clip.flipH ? ' is-active' : ''}`}
              onClick={() => {
                toggleFlipH()
                clearPreview()
              }}
              disabled={disabled}
              aria-pressed={clip.flipH}
            >
              <Icon name="flipH" size={17} />
              <span>水平镜像</span>
              <span className="toggle-state">{clip.flipH ? 'ON' : 'OFF'}</span>
            </button>
            <button
              type="button"
              className={`flip-toggle${clip.flipV ? ' is-active' : ''}`}
              onClick={() => {
                toggleFlipV()
                clearPreview()
              }}
              disabled={disabled}
              aria-pressed={clip.flipV}
            >
              <Icon name="flipV" size={17} />
              <span>垂直镜像</span>
              <span className="toggle-state">{clip.flipV ? 'ON' : 'OFF'}</span>
            </button>
          </div>
          </PanelSection>
        )}

        {tab === 'picture' && (
          <PanelSection
            title="缩放与位置"
            hint={`${round(clip.scale * 100, 0)}%`}
            collapsed={isCollapsed('transform')}
            onToggle={() => toggleSection('transform')}
            onReset={() => resetSection('transform', '缩放与位置')}
            resetDisabled={disabled}
          >
            <div className="control-with-field">
            <CommitSlider
              value={clip.scale * 100}
              min={10}
              max={400}
              step={1}
              ariaLabel="画面缩放"
              disabled={disabled}
              onPreview={(value) => preview({ scale: value / 100 })}
              onCommit={(value) => commitScale(value / 100)}
              format={(value) => `${round(value, 0)}%`}
            />
            <CommitNumber
              value={round(clip.scale * 100, 0)}
              min={10}
              max={400}
              step={1}
              unit="%"
              ariaLabel="画面缩放百分比"
              disabled={disabled}
              onPreview={(value) => preview({ scale: value / 100 })}
              onCommit={(value) => commitScale(value / 100)}
            />
            <KeyframeButton prop="scale" clip={clip} />
          </div>
          <div className="inline-actions">
            <button
              type="button"
              className="button mini"
              disabled={disabled}
              onClick={() => {
                fitSelected()
                clearPreview()
              }}
            >
              <Icon name="fit" size={14} />
              适应
            </button>
            <button
              type="button"
              className="button mini"
              disabled={disabled}
              onClick={() => {
                fillSelected()
                clearPreview()
              }}
            >
              <Icon name="fill" size={14} />
              填充
            </button>
            <button
              type="button"
              className="button mini ghost-mini"
              disabled={disabled}
              onClick={() => {
                resetPosition()
                clearPreview()
              }}
            >
              位置复位
            </button>
          </div>
          <div className="position-grid">
            <label>
              <span>水平偏移</span>
              <CommitNumber
                value={round(clip.position.x * 100, 1)}
                min={-200}
                max={200}
                step={1}
                unit="%"
                ariaLabel="水平偏移"
                disabled={disabled}
                onPreview={(value) =>
                  preview({ position: { x: value / 100, y: clip.position.y } })
                }
                onCommit={(value) => commitPosition(value, clip.position.y * 100)}
              />
              <KeyframeButton prop="position.x" clip={clip} />
            </label>
            <label>
              <span>垂直偏移</span>
              <CommitNumber
                value={round(clip.position.y * 100, 1)}
                min={-200}
                max={200}
                step={1}
                unit="%"
                ariaLabel="垂直偏移"
                disabled={disabled}
                onPreview={(value) =>
                  preview({ position: { x: clip.position.x, y: value / 100 } })
                }
                onCommit={(value) => commitPosition(clip.position.x * 100, value)}
              />
              <KeyframeButton prop="position.y" clip={clip} />
            </label>
          </div>
          </PanelSection>
        )}

        {/* 「合成」分组：整体搬自原「合成」tab（标题 / hint / 折叠键 / 重置 / 控件顺序均未改） */}
        {tab === 'picture' && (
          <PanelSection
            title="合成"
            hint={`不透明度 ${Math.round(clipOpacity(clip) * 100)}%`}
            collapsed={isCollapsed('compositing')}
            onToggle={() => toggleSection('compositing')}
            onReset={() => resetSection('compositing', '合成')}
            resetDisabled={disabled}
          >
            <ClipCompositingSection
              clip={clip}
              bare
              // 不透明度同样走可动画入口：有关键帧时改关键帧，否则改基础值。
              onOpacity={(value) => setAnimatableValue('opacity', value)}
              onBlendMode={(mode) => setClipBlendMode(clip.id, mode)}
              onPreviewOpacity={(value) => preview({ opacity: value })}
            />
          </PanelSection>
        )}

        {tab === 'picture' && (
          <PanelSection
            title="画面裁剪"
            hint={`${Math.round(clip.crop.w * 100)}% × ${Math.round(clip.crop.h * 100)}%`}
            collapsed={isCollapsed('crop')}
            onToggle={() => toggleSection('crop')}
            onReset={() => resetSection('crop', '画面裁剪')}
            resetDisabled={disabled}
          >
            <button
              type="button"
              className="button crop-entry"
              disabled={disabled || isOverlay}
              title={isOverlay ? '叠加片段暂不支持裁剪，可调整缩放和位置' : '进入裁剪模式'}
              onClick={beginCrop}
            >
              <Icon name="crop" size={16} />
              {isCropping ? '正在裁剪…' : '进入裁剪模式'}
              <span className="crop-entry-arrow">↗</span>
            </button>
            <p className="control-note">
              裁剪框相对原始画面，确认后才写入撤销历史。
            </p>
          </PanelSection>
        )}

        {tab === 'picture' && (
          <section className="panel-section attribute-actions">
            <div className="inline-actions">
              <button
                type="button"
                className="button mini"
                disabled={disabled}
                onClick={() => copyVisualAttributes(clip.id)}
                title="把该片段的旋转 / 镜像 / 裁剪 / 缩放 / 位置 / 不透明度 / 混合模式复制到属性剪贴板"
              >
                复制画面属性
              </button>
              <button
                type="button"
                className="button mini"
                disabled={disabled || !canPasteVisual}
                onClick={() => pasteVisualAttributes(pasteTargets)}
                title={canPasteVisual ? '粘贴到当前选中的片段' : '先复制一个片段的属性'}
              >
                粘贴画面属性
              </button>
            </div>
          </section>
        )}

        {tab === 'audio' &&
          (clip.type === 'freeze' ? (
            <section className="panel-section">
              <div className="section-title">
                <span>音频</span>
              </div>
              <p className="control-note">定格片段是静帧，没有音量与淡入淡出。</p>
            </section>
          ) : (
            <PanelSection
              title="音频"
              hint={`音量 ${Math.round(clipVolume(clip) * 100)}%`}
              collapsed={isCollapsed('audio')}
              onToggle={() => toggleSection('audio')}
              onReset={() => resetSection('audio', '音频')}
              resetDisabled={disabled}
            >
              <ClipAudioSection
                clip={clip}
                bare
                onCommit={(patch, label) => setClipAudio(clip.id, patch, label)}
                onPreview={(patch) => preview(patch)}
                onDetachAudio={() => detachAudio(clip.id)}
                detachDisabled={disabled}
              />
            </PanelSection>
          ))}

        {tab === 'audio' && clip.type !== 'freeze' && (
          <section className="panel-section attribute-actions">
            <div className="inline-actions">
              <button
                type="button"
                className="button mini"
                disabled={disabled}
                onClick={() => copyAudioAttributes(clip.id)}
                title="把该片段的音量 / 淡入 / 淡出复制到属性剪贴板"
              >
                复制音频属性
              </button>
              <button
                type="button"
                className="button mini"
                disabled={disabled || !canPasteAudio}
                onClick={() => pasteAudioAttributes(pasteTargets)}
                title={canPasteAudio ? '粘贴到当前选中的片段' : '先复制一个片段的属性'}
              >
                粘贴音频属性
              </button>
            </div>
          </section>
        )}

        {tab === 'speed' && canChangeClipSpeed(clip) && (
          <PanelSection
            title="变速"
            hint={`${Number(clipSpeedValue(clip).toFixed(2))}x`}
            collapsed={isCollapsed('speed')}
            onToggle={() => toggleSection('speed')}
            onReset={() => resetSection('speed', '变速')}
            resetDisabled={disabled}
          >
            <ClipSpeedSection
              clip={clip}
              bare
              onPreview={(value) =>
                setPreviewPatch({ clipId: clip.id, patch: { speed: value } })
              }
              onChange={(speed, keepPitch) => {
                // 提交会走命令并触发 sync()，那里会自动清掉 previewPatch。
                setClipSpeed(clip.id, speed, keepPitch)
              }}
            />
          </PanelSection>
        )}

        {tab === 'speed' && !canChangeClipSpeed(clip) && (
          <section className="panel-section">
            <p className="control-note">定格片段不支持变速。</p>
          </section>
        )}

        {tab === 'transition' && (
          <section className="panel-section transition-section">
            <ClipTransitionSection
              clip={clip}
              next={nextTransitionClip}
              disabled={disabled}
              onSet={(type, duration) => setTransition(clip.id, type, duration)}
              onClear={() => setTransition(clip.id, null)}
              onCloseGap={() => {
                if (nextTransitionClip) closeGapBefore(nextTransitionClip.id)
              }}
              onApplyAll={() => {
                const template = clipTransitionOut(clip)
                applyTransitionToAll(
                  template?.type ?? 'fade',
                  template?.duration ?? 0.4,
                )
              }}
              canApplyAll={project.clips.length > 1 && !isOverlay}
              unavailableReason={isOverlay ? '转场只作用于主轨片段' : undefined}
            />
          </section>
        )}

        {tab === 'color' && (
          <section className="panel-section color-section">
            <ClipColorSection
              clip={clip}
              disabled={disabled}
              clipboard={colorClipboard}
              onPreview={(color) => preview({ color })}
              onChange={(color) => {
                setClipColor(clip.id, color)
                clearPreview()
              }}
              onReset={() => {
                setClipColor(clip.id, {
                  brightness: 0,
                  contrast: 0,
                  saturation: 0,
                  temperature: 0,
                })
                clearPreview()
              }}
              onApplyAll={() => {
                applyColorToAll(clipColor(clip))
                clearPreview()
              }}
              onCopy={() => copyClipColor(clip.id)}
              onPaste={() => {
                pasteClipColor(clip.id)
                clearPreview()
              }}
            />
          </section>
        )}

        <section className="panel-section panel-danger">
          <button
            type="button"
            className="button delete-clip"
            disabled={isCropping}
            onClick={deleteSelectedClip}
          >
            <Icon name="trash" size={16} />
            删除片段
            <kbd>Delete</kbd>
          </button>
          <p className="control-note">删除后可用 Ctrl/⌘ + Z 恢复。</p>
        </section>
      </div>

      <div className="panel-foot">
        <Icon name="info" size={13} />
        所有操作均非破坏性，可随时撤销。
      </div>
    </aside>
  )
}