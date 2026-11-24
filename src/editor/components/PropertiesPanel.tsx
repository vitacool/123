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
import { MASK_DEFAULTS, MASK_SHAPES, normalizeMask, supportsMask } from '../core/mask'
import { CHROMA_KEY_DEFAULTS, normalizeChromaKey, type ChromaKey } from '../core/chromaKey'
import { useEditorStore } from '../store/EditorProvider'
import { CommitNumber } from './Toast'
import { CommitSlider } from './CommitSlider'
import { AudioPropertiesPanel } from './AudioPropertiesPanel'
import { ClipAudioSection } from './ClipAudioSection'
import {
  canChangeClipSpeed,
  clipSpeedValue,
  createFlatSpeedCurve,
  hasSpeedVariation,
  normalizeSpeedCurve,
  normalizeSpeedSegments,
} from '../core/speed'
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
import { SpeedCurveEditor } from './SpeedCurveEditor'
import { TextPropertiesPanel } from './TextPropertiesPanel'
import { CaptionListPanel } from './CaptionListPanel'
import { Icon } from './Icon'
import { AnimatedValueHint } from './AnimatedValueHint'
import { KeyframeButton } from './KeyframeButton'
import { KeyframeCurveButton } from './KeyframeCurveButton'
import { PanelSection } from './PanelSection'

/** 缺失素材重链时可接受的文件类型（与导入入口一致）。 */
const RELINK_ACCEPT =
  'video/*,audio/*,image/*,.mp4,.m4v,.mov,.webm,.mkv,.mp3,.wav,.m4a,.aac,.flac,.png,.jpg,.jpeg,.webp,.gif'

const round = (value: number, digits = 2): number => Number(value.toFixed(digits))

type PanelTab = 'picture' | 'audio' | 'transition' | 'color'

/** 「画面」内部的五个分类（子 tab）。 */
type PictureSubTab = 'basic' | 'crop' | 'mask' | 'chroma' | 'speed'

const PANEL_TABS: readonly { id: PanelTab; label: string }[] = [
  { id: 'picture', label: '画面' },
  { id: 'audio', label: '音频' },
  { id: 'transition', label: '转场' },
  { id: 'color', label: '调节' },
]

/** 「画面」内部的五个分类（顺序即展示顺序）。 */
const PICTURE_SUB_TABS: readonly { id: PictureSubTab; label: string }[] = [
  { id: 'basic', label: '基础' },
  { id: 'crop', label: '画面裁剪' },
  { id: 'mask', label: '蒙版' },
  { id: 'chroma', label: '抠像' },
  { id: 'speed', label: '变速' },
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
  const relinkMissingAsset = useEditorStore((state) => state.relinkMissingAsset)
  const relinkInputRef = useRef<HTMLInputElement | null>(null)
  const [relinking, setRelinking] = useState(false)
  const selectClip = useEditorStore((state) => state.selectClip)
  const setRotation = useEditorStore((state) => state.setRotation)
  const setAnimatableValue = useEditorStore((state) => state.setAnimatableValue)
  const toggleFlipH = useEditorStore((state) => state.toggleFlipH)
  const toggleFlipV = useEditorStore((state) => state.toggleFlipV)
  const fitSelected = useEditorStore((state) => state.fitSelected)
  const fillSelected = useEditorStore((state) => state.fillSelected)
  const resetPosition = useEditorStore((state) => state.resetPosition)
  const beginCrop = useEditorStore((state) => state.beginCrop)
  const setClipMask = useEditorStore((state) => state.setClipMask)
  const setClipChromaKey = useEditorStore((state) => state.setClipChromaKey)
  const setClipSpeedSegments = useEditorStore((state) => state.setClipSpeedSegments)
  const setClipSpeedCurve = useEditorStore((state) => state.setClipSpeedCurve)
  const copySpeedAttributes = useEditorStore((state) => state.copySpeedAttributes)
  const pasteSpeedAttributes = useEditorStore((state) => state.pasteSpeedAttributes)
  const previewMuteSegmentedSpeed =
    useEditorStore((state) => state.previewMuteSegmentedSpeed) ?? true
  const togglePreviewMuteSegmentedSpeed = useEditorStore(
    (state) => state.togglePreviewMuteSegmentedSpeed,
  )
  const resizeFreeze = useEditorStore((state) => state.resizeFreeze)
  const deleteSelectedClip = useEditorStore((state) => state.deleteSelectedClip)
  const reverseClip = useEditorStore((state) => state.reverseClip)
  const reverseJob = useEditorStore((state) => state.reverseJob)
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
  const canPasteSpeed = Boolean(
    attributeClipboard.speed && Object.keys(attributeClipboard.speed).length > 0,
  )
  const applyClipDefaults = useEditorStore((state) => state.applyClipDefaults)

  const location = findClipLocation(project, selectedClipId)

  // 这些状态在「无选区 / 多选 / 音频 / 文字片段」时也必须按同一次序调用，
  // 因此统一放在所有 early-return 之前。
  const [tab, setTab] = useState<PanelTab>('picture')
  /** 变速 Tab 的两种模式：常规（单一倍率）/ 曲线（分段 & 曲线）。 */
  const [speedMode, setSpeedMode] = useState<'normal' | 'curve'>('normal')
  /** 曲线模式下的子模式：曲线编辑器（默认）/ 分段编辑器。 */
  const [speedSub, setSpeedSub] = useState<'curve' | 'segments'>('curve')
  /** 「画面」当前选中的分类（子 tab）。 */
  const [pictureSub, setPictureSub] = useState<PictureSubTab>('basic')
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
  // 倒放只对 video 片段有意义：定格/图片是静帧，没有可反转的时间流。
  const reverseDisabled = disabled || clip.type === 'freeze' || clip.type === 'image' || Boolean(reverseJob)
  const reverseTitle = reverseJob
    ? '已有倒放任务在进行中'
    : clip.type === 'freeze' || clip.type === 'image'
      ? '定格 / 图片片段不支持倒放'
      : missingAsset
        ? '素材已移除，无法倒放'
        : '把该片段的源区间生成倒放素材（可作为新素材复用，可撤销）'
  // 转场作用在「本片段 → 下一片段」交界，叠加轨只在同一轨道内相邻。
  const nextTransitionClip = location.track
    ? (location.track.clips[location.track.clips.findIndex((item) => item.id === clip.id) + 1] ?? null)
    : (project.clips[project.clips.findIndex((item) => item.id === clip.id) + 1] ?? null)

  const preview = (patch: Partial<Clip>) => {
    setPreviewPatch({ clipId: clip.id, patch })
  }

  const clearPreview = () => setPreviewPatch(null)
  /** 蒙版：拖动时 previewPatch 实时预览，松手提交（一步撤销）。 */
  const commitMask = (patch: Partial<NonNullable<Clip['mask']>>) => {
    const base = clip.mask ?? { ...MASK_DEFAULTS }
    const next = normalizeMask({ ...base, ...patch })
    setClipMask(clip.id, next)
  }
  const previewMask = (patch: Partial<NonNullable<Clip['mask']>>) => {
    const base = clip.mask ?? { ...MASK_DEFAULTS }
    const next = normalizeMask({ ...base, ...patch })
    if (next) preview({ mask: next })
  }
  const maskSupported = supportsMask(clip.type)
  /**
   * 分段变速：默认「两段」= 前半原速、后半 2x；用户可以在下面调每段速度与段边界。
   * 拖动滑块时 previewPatch 实时预览，松手提交（一步撤销）。
   */
  const commitSpeedSegments = (next: { at: number; speed: number }[] | undefined) => {
    const normalized = next ? normalizeSpeedSegments(next) : undefined
    setClipSpeedSegments(clip.id, normalized)
  }
  const previewSpeedSegments = (next: { at: number; speed: number }[]) => {
    const normalized = normalizeSpeedSegments(next)
    if (normalized) preview({ speedSegments: normalized })
  }
  const speedSegments = normalizeSpeedSegments(clip.speedSegments) ?? null
  /**
   * 平滑曲线：控制点直接写 speedCurve，并清掉 speedSegments（两者互斥）。
   * 拖动控制点时 previewPatch 实时预览，松手提交（一步撤销）。
   */
  const speedCurve = normalizeSpeedCurve(clip.speedCurve) ?? null
  const commitSpeedCurve = (next: { at: number; speed: number }[] | undefined) => {
    setClipSpeedCurve(clip.id, next ? normalizeSpeedCurve(next) : undefined)
  }
  const previewSpeedCurve = (next: { at: number; speed: number }[]) => {
    const normalized = normalizeSpeedCurve(next)
    if (normalized) preview({ speedCurve: normalized, speedSegments: undefined })
  }
  /** 抠像：拖动时 previewPatch 实时预览，松手提交（一步撤销）。 */
  const commitChromaKey = (patch: Partial<ChromaKey>) => {
    const base = clip.chromaKey ?? { ...CHROMA_KEY_DEFAULTS }
    const next = normalizeChromaKey({ ...base, ...patch })
    setClipChromaKey(clip.id, next)
  }
  const previewChromaKey = (patch: Partial<ChromaKey>) => {
    const base = clip.chromaKey ?? { ...CHROMA_KEY_DEFAULTS }
    const next = normalizeChromaKey({ ...base, ...patch })
    if (next) preview({ chromaKey: next })
  }

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
              该片段的素材不在本机。重新选择同一个文件即可恢复预览与编辑；
              片段本身（入出点、关键帧、音量）会原样保留。
            </p>
            <div className="inline-actions">
              <button
                type="button"
                className="button mini"
                disabled={relinking}
                onClick={() => relinkInputRef.current?.click()}
              >
                {relinking ? '正在读取素材…' : '重新链接素材…'}
              </button>
            </div>
            <input
              ref={relinkInputRef}
              type="file"
              accept={RELINK_ACCEPT}
              hidden
              onChange={async (event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (!file) return
                setRelinking(true)
                try {
                  await relinkMissingAsset(clip.sourceUrl, file)
                } finally {
                  setRelinking(false)
                }
              }}
            />
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

        {tab === 'picture' && (
          <div className="picture-subtabs" role="tablist" aria-label="画面分类">
            {PICTURE_SUB_TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={pictureSub === item.id}
                className={`picture-subtab${pictureSub === item.id ? ' is-active' : ''}`}
                onClick={() => setPictureSub(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}

        {tab === 'picture' && pictureSub === 'basic' && clip.type === 'freeze' && (
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

        {tab === 'picture' && pictureSub === 'basic' && (
          <div className="panel-group" role="group" aria-label="基础">
            <p className="panel-group-title">基础</p>
            <p className="panel-group-hint">位置大小 · 合成 · 镜像 · 旋转</p>
        {tab === 'picture' && pictureSub === 'basic' && (
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
        {tab === 'picture' && pictureSub === 'basic' && (
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
            <KeyframeCurveButton prop="rotation" clip={clip} />
              <KeyframeButton prop="rotation" clip={clip} />
              <AnimatedValueHint prop="rotation" clip={clip} />
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

        {tab === 'picture' && pictureSub === 'basic' && (
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

        {tab === 'picture' && pictureSub === 'basic' && (
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
            <KeyframeCurveButton prop="scale" clip={clip} />
              <KeyframeButton prop="scale" clip={clip} />
              <AnimatedValueHint prop="scale" clip={clip} />
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
          <div className="position-grid is-keyframed">
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
              <span className="position-keyframe-group">
                <KeyframeCurveButton prop="position.x" clip={clip} />
                <KeyframeButton prop="position.x" clip={clip} />
              </span>
              <AnimatedValueHint prop="position.x" clip={clip} />
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
              <span className="position-keyframe-group">
                <KeyframeCurveButton prop="position.y" clip={clip} />
                <KeyframeButton prop="position.y" clip={clip} />
              </span>
              <AnimatedValueHint prop="position.y" clip={clip} />
            </label>
          </div>
          </PanelSection>
        )}
          </div>
        )}

        {/* 「合成」分组：整体搬自原「合成」tab（标题 / hint / 折叠键 / 重置 / 控件顺序均未改） */}

        {tab === 'picture' && pictureSub === 'crop' && (
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
              disabled={disabled}
              title="进入裁剪模式"
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
        {tab === 'picture' && pictureSub === 'mask' && (
          <PanelSection
            title="蒙版"
            hint={
              clip.mask
                ? MASK_SHAPES.find((item) => item.value === clip.mask!.shape)?.label
                : '无'
            }
            collapsed={isCollapsed('mask')}
            onToggle={() => toggleSection('mask')}
            onReset={() => setClipMask(clip.id, undefined)}
            resetDisabled={disabled || !clip.mask}
          >
            {!maskSupported ? (
              <p className="control-note">文字片段暂不支持蒙版。</p>
            ) : (
              <>
                <div className="mask-shape-row" role="radiogroup" aria-label="蒙版形状">
                  {[{ value: '' as const, label: '无' }, ...MASK_SHAPES].map((item) => {
                    const active = item.value === '' ? !clip.mask : clip.mask?.shape === item.value
                    return (
                      <button
                        key={item.value || 'none'}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={`button mini mask-shape${active ? ' is-active' : ''}`}
                        disabled={disabled}
                        title={item.value === '' ? '不使用蒙版' : item.label}
                        onClick={() => {
                          if (item.value === '') {
                            setClipMask(clip.id, undefined)
                            return
                          }
                          commitMask({ shape: item.value })
                        }}
                      >
                        {item.label}
                      </button>
                    )
                  })}
                </div>
                {clip.mask && (
                  <>
                    <div className="mask-geometry">
                      <label>
                        <span>水平</span>
                        <CommitNumber
                          value={round(clip.mask.x * 100, 1)}
                          min={0}
                          max={100}
                          step={1}
                          unit="%"
                          ariaLabel="蒙版水平位置"
                          disabled={disabled}
                          onPreview={(value) => previewMask({ x: value / 100 })}
                          onCommit={(value) => commitMask({ x: value / 100 })}
                        />
                      </label>
                      <label>
                        <span>垂直</span>
                        <CommitNumber
                          value={round(clip.mask.y * 100, 1)}
                          min={0}
                          max={100}
                          step={1}
                          unit="%"
                          ariaLabel="蒙版垂直位置"
                          disabled={disabled}
                          onPreview={(value) => previewMask({ y: value / 100 })}
                          onCommit={(value) => commitMask({ y: value / 100 })}
                        />
                      </label>
                      {clip.mask.shape !== 'linear' && (
                        <>
                          <label>
                            <span>宽度</span>
                            <CommitNumber
                              value={round(clip.mask.width * 100, 1)}
                              min={1}
                              max={100}
                              step={1}
                              unit="%"
                              ariaLabel="蒙版宽度"
                              disabled={disabled}
                              onPreview={(value) => previewMask({ width: value / 100 })}
                              onCommit={(value) => commitMask({ width: value / 100 })}
                            />
                          </label>
                          <label>
                            <span>高度</span>
                            <CommitNumber
                              value={round(clip.mask.height * 100, 1)}
                              min={1}
                              max={100}
                              step={1}
                              unit="%"
                              ariaLabel="蒙版高度"
                              disabled={disabled}
                              onPreview={(value) => previewMask({ height: value / 100 })}
                              onCommit={(value) => commitMask({ height: value / 100 })}
                            />
                          </label>
                        </>
                      )}
                      <label>
                        <span>旋转</span>
                        <CommitNumber
                          value={Math.round(clip.mask.rotation)}
                          min={0}
                          max={360}
                          step={1}
                          unit="°"
                          ariaLabel="蒙版旋转"
                          disabled={disabled}
                          onPreview={(value) => previewMask({ rotation: value })}
                          onCommit={(value) => commitMask({ rotation: value })}
                        />
                      </label>
                    </div>
                    <div className="control-with-field">
                      <span className="section-hint">羽化</span>
                      <CommitSlider
                        value={Math.round(clip.mask.feather * 100)}
                        min={0}
                        max={100}
                        step={1}
                        ariaLabel="蒙版羽化"
                        disabled={disabled}
                        onPreview={(value) => previewMask({ feather: value / 100 })}
                        onCommit={(value) => commitMask({ feather: value / 100 })}
                      />
                    </div>
                    {clip.mask.shape === 'rect' && (
                      <div className="control-with-field">
                        <span className="section-hint">圆角</span>
                        <CommitSlider
                          value={Math.round((clip.mask.roundness ?? 0) * 100)}
                          min={0}
                          max={100}
                          step={1}
                          ariaLabel="蒙版圆角"
                          disabled={disabled}
                          onPreview={(value) => previewMask({ roundness: value / 100 })}
                          onCommit={(value) => commitMask({ roundness: value / 100 })}
                        />
                      </div>
                    )}
                    <label className="control-toggle">
                      <input
                        type="checkbox"
                        checked={clip.mask.invert}
                        disabled={disabled}
                        onChange={(event) => commitMask({ invert: event.target.checked })}
                      />
                      反向（只保留形状外）
                    </label>
                    <p className="control-note">
                      蒙版随片段一起缩放、旋转、移动；羽化按蒙版短边换算，与分辨率无关。
                    </p>
                  </>
                )}
              </>
            )}
          </PanelSection>
        )}
        {tab === 'picture' && pictureSub === 'chroma' && (
          <PanelSection
            title="抠像"
            hint={clip.chromaKey ? clip.chromaKey.color.toUpperCase() : '关'}
            collapsed={isCollapsed('chroma')}
            onToggle={() => toggleSection('chroma')}
            onReset={() => setClipChromaKey(clip.id, undefined)}
            resetDisabled={disabled || !clip.chromaKey}
          >
            {!maskSupported ? (
              <p className="control-note">文字片段暂不支持抠像。</p>
            ) : (
              <>
                <label className="control-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(clip.chromaKey)}
                    disabled={disabled}
                    onChange={(event) => {
                      if (event.target.checked) {
                        // 第一次开启：默认纯绿幕（自动四角取样在预览侧实现，见报告）
                        commitChromaKey({})
                      } else {
                        setClipChromaKey(clip.id, undefined)
                      }
                    }}
                  />
                  开启色度抠像
                </label>
                {clip.chromaKey && (
                  <>
                    <div className="control-with-field">
                      <span className="section-hint">幕布颜色</span>
                      <input
                        type="color"
                        aria-label="抠像颜色"
                        value={clip.chromaKey.color}
                        disabled={disabled}
                        onChange={(event) => commitChromaKey({ color: event.target.value })}
                      />
                    </div>
                    <div className="control-with-field">
                      <span className="section-hint">强度</span>
                      <CommitSlider
                        value={Math.round(clip.chromaKey.similarity * 1000) / 10}
                        min={1}
                        max={50}
                        step={0.1}
                        ariaLabel="抠像强度"
                        disabled={disabled}
                        onPreview={(value) => previewChromaKey({ similarity: value / 100 })}
                        onCommit={(value) => commitChromaKey({ similarity: value / 100 })}
                      />
                    </div>
                    <div className="control-with-field">
                      <span className="section-hint">边缘柔和</span>
                      <CommitSlider
                        value={Math.round(clip.chromaKey.blend * 1000) / 10}
                        min={0}
                        max={50}
                        step={0.1}
                        ariaLabel="抠像边缘柔和"
                        disabled={disabled}
                        onPreview={(value) => previewChromaKey({ blend: value / 100 })}
                        onCommit={(value) => commitChromaKey({ blend: value / 100 })}
                      />
                    </div>
                    <div className="control-with-field">
                      <span className="section-hint">去溢色</span>
                      <CommitSlider
                        value={Math.round(clip.chromaKey.spill * 100)}
                        min={0}
                        max={100}
                        step={1}
                        ariaLabel="去溢色强度"
                        disabled={disabled}
                        onPreview={(value) => previewChromaKey({ spill: value / 100 })}
                        onCommit={(value) => commitChromaKey({ spill: value / 100 })}
                      />
                    </div>
                    {!isOverlay && (
                      <p className="control-note">
                        抠掉的区域会显示画布背景，建议放在叠加轨上。
                      </p>
                    )}
                    <p className="control-note">
                      与导出的 chromakey / despill 使用同一套 FFmpeg 公式。
                    </p>
                  </>
                )}
              </>
            )}
          </PanelSection>
        )}

        {tab === 'picture' && pictureSub === 'basic' && (
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
              <button
                type="button"
                className="button mini"
                disabled={reverseDisabled}
                onClick={() => reverseClip(clip.id)}
                title={reverseTitle}
              >
                倒放
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

        {tab === 'picture' && pictureSub === 'speed' && canChangeClipSpeed(clip) && (
          <>
            <div className="speed-mode-switch" role="radiogroup" aria-label="变速模式">
              <button
                type="button"
                role="radio"
                aria-checked={speedMode === 'normal'}
                className={`button mini${speedMode === 'normal' ? ' is-active' : ''}`}
                onClick={() => setSpeedMode('normal')}
              >
                常规变速
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={speedMode === 'curve'}
                className={`button mini${speedMode === 'curve' ? ' is-active' : ''}`}
                onClick={() => setSpeedMode('curve')}
              >
                曲线变速
              </button>
            </div>
            {speedMode === 'normal' ? (
          <>
          <PanelSection
            title="常规变速"
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
          </>
            ) : (
          <>
          <div className="speed-sub-switch" role="radiogroup" aria-label="曲线变速子模式">
            <button
              type="button"
              role="radio"
              aria-checked={speedSub === 'curve'}
              className={`button mini${speedSub === 'curve' ? ' is-active' : ''}`}
              onClick={() => setSpeedSub('curve')}
            >
              曲线
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={speedSub === 'segments'}
              className={`button mini${speedSub === 'segments' ? ' is-active' : ''}`}
              onClick={() => setSpeedSub('segments')}
            >
              分段
            </button>
          </div>
          <label className="control-toggle">
            <input
              type="checkbox"
              checked={previewMuteSegmentedSpeed}
              onChange={() => togglePreviewMuteSegmentedSpeed()}
            />
            预览时静音变速片段（导出仍保留保音高的声音）
          </label>
          {previewMuteSegmentedSpeed && hasSpeedVariation(clip) && (
            <p className="control-note">
              该片段是分段/曲线变速：浏览器无法用单一播放速率正确预览，所以预览静音；
              导出会按段变速并保持音高。取消勾选可试听（节奏可能与成片不一致）。
            </p>
          )}
          {speedSub === 'curve' ? (
            <>
              <PanelSection
                title="速度曲线"
                hint={speedCurve ? `${speedCurve.length} 个控制点` : '无'}
                collapsed={isCollapsed('speedCurve')}
                onToggle={() => toggleSection('speedCurve')}
                onReset={() => setClipSpeedCurve(clip.id, undefined)}
                resetDisabled={disabled || !speedCurve}
              >
                {speedCurve ? (
                  <>
                    <SpeedCurveEditor
                      curve={speedCurve}
                      disabled={disabled}
                      onPreview={previewSpeedCurve}
                      onCommit={commitSpeedCurve}
                    />
                    <p className="control-note">
                      横轴 = 片段进度、纵轴 = 倍率（0.1–10x，对数刻度）。拖动控制点时实时预览，
                      松手提交为一步撤销；曲线与分段互斥，提交曲线会清掉已有分段。
                    </p>
                  </>
                ) : (
                  <>
                    <p className="control-note">
                      用 3–5 个控制点描述整段速度：往上 = 加速、往下 = 慢放。两端点只调速度，中间点还能左右挪。
                    </p>
                    {speedSegments && (
                      <p className="control-note">
                        该片段当前用的是「分段」变速（{speedSegments.length} 段）：启用曲线会清掉它，
                        想保留分段请切到上面的「分段」。
                      </p>
                    )}
                    <button
                      type="button"
                      className="button mini"
                      disabled={disabled}
                      title="创建 3 个控制点的平坦曲线，之后拖动调形"
                      onClick={() => commitSpeedCurve(createFlatSpeedCurve(clipSpeedValue(clip)))}
                    >
                      启用曲线变速
                    </button>
                  </>
                )}
              </PanelSection>
              <section className="panel-section attribute-actions">
                <div className="inline-actions">
                  <button
                    type="button"
                    className="button mini"
                    disabled={disabled}
                    onClick={() => copySpeedAttributes(clip.id)}
                    title="把该片段的倍率 / 分段 / 曲线复制到变速剪贴板"
                  >
                    复制变速属性
                  </button>
                  <button
                    type="button"
                    className="button mini"
                    disabled={disabled || !canPasteSpeed}
                    onClick={() => pasteSpeedAttributes(pasteTargets)}
                    title={
                      canPasteSpeed
                        ? '粘贴到当前选中的片段（定格 / 图片片段会跳过）'
                        : '先复制一个片段的变速属性'
                    }
                  >
                    粘贴变速属性
                  </button>
                </div>
              </section>
            </>
          ) : (
          <>
          <PanelSection
            title="变速分段"
            hint={speedSegments ? `${speedSegments.length} 段` : '无'}
            collapsed={isCollapsed('speedSegments')}
            onToggle={() => toggleSection('speedSegments')}
            onReset={() => setClipSpeedSegments(clip.id, undefined)}
            resetDisabled={disabled || !speedSegments}
          >
            {!speedSegments ? (
              <>
                <p className="control-note">
                  把片段拆成「前半原速 + 后半 2 倍速」，之后可以逐段调整速度与分界点。
                </p>
                <button
                  type="button"
                  className="button mini"
                  disabled={disabled}
                  title="创建两段变速（前后各 1 段）"
                  onClick={() =>
                    commitSpeedSegments([
                      { at: 0, speed: 1 },
                      { at: 0.5, speed: 2 },
                    ])
                  }
                >
                  拆成两段
                </button>
              </>
            ) : (
              <>
                {speedSegments.map((segment: { at: number; speed: number }, index: number) => {
                  const boundary = index > 0 ? Math.round(segment.at * 100) : null
                  return (
                    <div className="speed-segment" key={`speed-seg-${index}`}>
                      <span className="speed-segment-label">第 {index + 1} 段</span>
                      {boundary !== null && (
                        <div className="control-with-field">
                          <span className="section-hint">起点</span>
                          <CommitSlider
                            value={boundary}
                            min={5}
                            max={95}
                            step={1}
                            ariaLabel={`第 ${index + 1} 段起点（百分比）`}
                            disabled={disabled}
                            format={(value) => `${Math.round(value)}%`}
                            onPreview={(value) => {
                              const next = speedSegments.map((item: { at: number; speed: number }, itemIndex: number) =>
                                itemIndex === index ? { ...item, at: value / 100 } : item,
                              )
                              previewSpeedSegments(next)
                            }}
                            onCommit={(value) => {
                              const next = speedSegments.map((item: { at: number; speed: number }, itemIndex: number) =>
                                itemIndex === index ? { ...item, at: value / 100 } : item,
                              )
                              commitSpeedSegments(next)
                            }}
                          />
                        </div>
                      )}
                      <div className="control-with-field">
                        <span className="section-hint">速度</span>
                        <CommitSlider
                          value={Math.round(segment.speed * 100) / 100}
                          min={0.1}
                          max={10}
                          step={0.05}
                          ariaLabel={`第 ${index + 1} 段速度`}
                          disabled={disabled}
                          format={(value) => `${Number(value.toFixed(2))}x`}
                          onPreview={(value) =>
                            previewSpeedSegments(
                              speedSegments.map((item: { at: number; speed: number }, itemIndex: number) =>
                                itemIndex === index ? { ...item, speed: value } : item,
                              ),
                            )
                          }
                          onCommit={(value) =>
                            commitSpeedSegments(
                              speedSegments.map((item: { at: number; speed: number }, itemIndex: number) =>
                                itemIndex === index ? { ...item, speed: value } : item,
                              ),
                            )
                          }
                        />
                      </div>
                    </div>
                  )
                })}
                <div className="inline-actions">
                  <button
                    type="button"
                    className="button mini"
                    disabled={disabled || speedSegments.length >= 8}
                    title="在末尾追加一段（上限 8 段）"
                    onClick={() => {
                      const last = speedSegments[speedSegments.length - 1]
                      const nextAt = Math.min(0.95, last.at + (1 - last.at) / 2)
                      commitSpeedSegments([
                        ...speedSegments,
                        { at: nextAt, speed: last.speed },
                      ])
                    }}
                  >
                    追加一段
                  </button>
                  <button
                    type="button"
                    className="button mini"
                    disabled={disabled || speedSegments.length <= 2}
                    title="删除最后一段（最少 2 段）"
                    onClick={() => commitSpeedSegments(speedSegments.slice(0, -1))}
                  >
                    删除末段
                  </button>
                </div>
                <p className="control-note">
                  段内常速、段间硬切换。导出按段变速（音频保音高）；预览按段切换播放速率。
                </p>
              </>
            )}
          </PanelSection>
          </>
            )}
            </>
          )}
          </>
        )}

        {tab === 'picture' && pictureSub === 'speed' && !canChangeClipSpeed(clip) && (
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