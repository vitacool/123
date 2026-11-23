import type { ChromaKey } from './chromaKey'
/** A ratio preset shown in the top bar. `original` follows the source media. */
export type AspectRatioPreset = 'original' | '16:9' | '9:16' | '1:1' | '4:3' | '3:4'

export type ExportResolution = '480p' | '720p' | '1080p' | '4K'

export type ExportFps = 24 | 30 | 60

/** 响度标准化目标：关闭 / 短视频平台（-14 LUFS） / 广播（-23 LUFS）。 */
export type ExportLoudness = 'off' | 'platform' | 'broadcast'

export interface ExportQuality {
  resolution: ExportResolution
  fps: ExportFps
  /** 缺省 `off`（旧草稿/工程没有该字段时按 off 处理）。 */
  loudness?: ExportLoudness
}

/** Normalised crop rectangle. Values are fractions of the source frame (0…1). */
export interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

/** Position offset measured in fractions of the project canvas. (0, 0) is centred. */
export interface Point {
  x: number
  y: number
}

/** 混合模式：与 Canvas globalCompositeOperation / FFmpeg blend 一一对应。 */
export type BlendMode = 'normal' | 'screen' | 'multiply' | 'overlay' | 'lighten' | 'darken'

/** 转场类型：与 FFmpeg xfade 的 transition 名称一一对应。 */
export type TransitionType =
  // 基础
  | 'fade'
  | 'fadeblack'
  | 'fadewhite'
  | 'fadegrays'
  // 擦除（硬边）
  | 'wipeleft'
  | 'wiperight'
  | 'wipeup'
  | 'wipedown'
  // 柔边擦除
  | 'smoothleft'
  | 'smoothright'
  | 'smoothup'
  | 'smoothdown'
  // 滑动
  | 'slideleft'
  | 'slideright'
  | 'slideup'
  | 'slidedown'
  // 形状
  | 'circleopen'
  | 'circleclose'
  | 'circlecrop'
  | 'rectcrop'
  | 'vertopen'
  | 'vertclose'
  | 'horzopen'
  | 'horzclose'
  | 'radial'
  // 特效
  | 'dissolve'
  | 'pixelize'
  | 'hblur'
  | 'zoomin'
  | 'squeezeh'
  | 'squeezev'

/** 片段尾部的转场（作用在「本片段 → 下一片段」交界）。 */
export interface ClipTransition {
  type: TransitionType
  duration: number
}

/**
 * 画布背景：片段画面未铺满画布时填充的区域。
 * - `black` 黑场（默认，与历史行为一致）
 * - `color` 纯色
 * - `blur` 用该片段自身画面放大填充并高斯模糊
 * - `image` 用一张图片填充
 */
export interface CanvasBackground {
  type: 'black' | 'color' | 'blur' | 'image'
  color?: string
  blurAmount?: number
  imageUrl?: string
}

/** 蒙版形状：矩形 / 椭圆 / 线性（一刀切）/ 镜面（条带）。 */
export type MaskShape = 'rect' | 'ellipse' | 'linear' | 'mirror'

/**
 * 片段形状蒙版（阶段 A：静态，不支持关键帧）。
 *
 * 坐标定义在「裁切 + 翻转之后、旋转与缩放之前」的画面里，
 * x/y/width/height 是画面宽高的比例（0..1），因此跟随片段一起变换且与分辨率无关。
 * linear 不使用 width/height；mirror 只用 height 作为条带宽度。
 */
export interface ClipMask {
  shape: MaskShape
  x: number
  y: number
  width: number
  height: number
  /** 旋转角度（度）。 */
  rotation: number
  /** 仅 rect：圆角 0..1。 */
  roundness?: number
  /** 羽化 0..1，按蒙版短边换算成像素。 */
  feather: number
  invert: boolean
}

/**
 * 分段变速的一段：`at` 是「源区间内的相对位置」（0..1，首段固定 0），
 * `speed` 是这一段的播放倍率（0.1–10）。段内常速、段间硬切换。
 */
export interface SpeedSegment {
  at: number
  speed: number
}

export interface Clip {
  id: string
  sourceUrl: string
  /**
   * In/out points in the source video. For a freeze clip these values also
   * encode the visible duration (`sourceEnd - sourceStart`) while
   * `freezeFrameTime` holds the actual frozen source frame.
   */
  sourceStart: number
  sourceEnd: number
  /**
   * `image` 是静帧片段：`sourceStart..sourceEnd` 只编码时长（不表示可跳转的源时间），
   * 可任意拉伸而不受素材真实时长限制。
   */
  type: 'video' | 'freeze' | 'image'
  rotation: number
  flipH: boolean
  flipV: boolean
  crop: CropRect
  scale: number
  position: Point
  /**
   * Optional extension: empty space before this clip, in seconds. Non-destructive
   * edge trims use this to keep the trimmed material in the source range while
   * leaving a recoverable gap on the timeline.
   */
  gapBefore?: number
  /**
   * Optional extension to the requested clip schema. It keeps a freeze frame
   * stable after the freeze clip is split, when its source in/out points are
   * used for duration rather than for seeking.
   */
  freezeFrameTime?: number
  /** 片段音频增益 0–2，缺省 1（旧草稿无此字段视为 1）。 */
  volume?: number
  /** 淡入时长（秒），缺省 0。 */
  fadeIn?: number
  /** 淡出时长（秒），缺省 0。 */
  fadeOut?: number
  /** 播放倍率 0.1–10，缺省 1（旧草稿无此字段视为 1）。 */
  speed?: number
  /** 变速时是否保持音调，缺省 true。 */
  keepPitch?: boolean
  /** 不透明度 0–1，缺省 1（旧草稿无此字段视为 1）。 */
  opacity?: number
  /** 混合模式，缺省 normal。 */
  blendMode?: BlendMode
  /**
   * 分段变速（2–8 段，段内常速）：缺省表示用单一的 `speed`。
   * 时长 = Σ(段源长 / 段速)，见 core/speed.ts 的 segmentPlan。
   */
  speedSegments?: SpeedSegment[]
  /**
   * 平滑变速曲线（控制点，`at` 0..1、`speed` 0.1–10）。
   * 有曲线且没有显式 speedSegments 时，按 16 段采样成段表参与时长/导出/预览
   * （等价于「分段变速」的加密近似，不需要逐帧烘焙）。
   */
  speedCurve?: SpeedSegment[]
  /** 与下一片段之间的转场；缺省无转场。 */
  transitionOut?: ClipTransition
  /** 片段级背景覆盖；缺省沿用工程级 canvasBackground。 */
  background?: CanvasBackground
  /** 关键帧动画；缺省表示没有动画（旧草稿无此字段）。 */
  anim?: AnimationMap
  /** 形状蒙版；缺省表示没有蒙版（旧草稿无此字段）。阶段 A 为静态参数。 */
  mask?: ClipMask
  /** 色度抠像（阶段 B）；缺省表示不抠像（旧草稿无此字段）。 */
  chromaKey?: ChromaKey
  /**
   * 调色参数：四项各 -100…100，缺省 0（旧草稿读取时统一归一化为 0）。
   * 预览用 Canvas filter/叠加层，导出用 FFmpeg eq/colorbalance。
   */
  color?: {
    brightness?: number
    contrast?: number
    saturation?: number
    temperature?: number
  }
}

export interface Marker {
  id: string
  time: number
  color: string
  note: string
}

/** Shared state for every timeline track. */
export interface TrackState {
  /** False disables both picture and sound without deleting the material. */
  enabled: boolean
  /** True blocks editing; playback and export are unaffected. */
  locked: boolean
  /** Picture only. */
  hidden: boolean
  /** Sound only. */
  muted: boolean
  /** Audio solo; may be active on several tracks at once. */
  solo: boolean
}

/** A sequential video lane layered above the primary clip track. */
export interface OverlayTrack {
  id: string
  name: string
  muted: boolean
  hidden: boolean
  /** Optional for drafts created before track controls existed. */
  enabled?: boolean
  locked?: boolean
  solo?: boolean
  clips: Clip[]
}

export type MediaKind = 'video' | 'audio' | 'image'

/** A sound clip placed at an absolute time on an audio track. */
export interface AudioClip {
  id: string
  sourceUrl: string
  sourceStart: number
  sourceEnd: number
  /** Absolute start on the project timeline, in seconds. */
  start: number
  /** Linear gain, 0…2. */
  volume: number
  fadeIn: number
  fadeOut: number
  /**
   * 音量关键帧；缺省表示静态音量（旧草稿无此字段）。
   * 本期只允许 `volume`，时间基准是该音频片段的本地归一化时间 0…1。
   */
  anim?: AnimationMap
}

export interface AudioTrack {
  id: string
  name: string
  muted: boolean
  hidden: boolean
  /** Optional for drafts created before track controls existed. */
  enabled?: boolean
  locked?: boolean
  solo?: boolean
  /** Track-level linear gain, 0…2. */
  volume: number
  clips: AudioClip[]
}

export type TextAlign = 'left' | 'center' | 'right'

/** Distinguishes smart-caption tracks from manually created text tracks. */
export type TextTrackKind = 'text' | 'caption'

/** Group style applied to every clip on a caption track. */
export interface CaptionStyle {
  fontSize?: number
  color?: string
  strokeColor?: string
  strokeWidth?: number
  /** 文字阴影颜色；未设置或 transparent 表示关闭。 */
  shadowColor?: string
  /** 阴影模糊半径，按 fontSize 的比例存储。 */
  shadowBlur?: number
  /** 阴影水平偏移，按 fontSize 的比例存储（可为负）。 */
  shadowOffsetX?: number
  /** 阴影垂直偏移，按 fontSize 的比例存储（可为负）。 */
  shadowOffsetY?: number
  background?: string
  x?: number
  y?: number
  align?: TextAlign
  bold?: boolean
  fontFamily?: string
}

/** A word-level timestamp inside a caption clip (timeline seconds). */
export interface CaptionWord {
  text: string
  start: number
  end: number
}

/** Link between a caption clip and the video/audio clip that produced it. */
export interface CaptionLink {
  clipId: string
  /** Stable media asset id; survives blob-URL remaps across reloads. */
  assetId?: string
  /** Mirror of the media URL (kept for prune/legacy); remapped on draft load. */
  sourceUrl?: string
  /** ORIGINAL source range; never narrowed by relink. */
  sourceStart: number
  sourceEnd: number
  /** Timeline padding beyond the source-mapped range (0.1s tail, min-duration…). */
  padStart: number
  padEnd: number
  /** True when the caption is currently fully outside its clip (recoverable). */
  linkHidden?: boolean
}

export interface TextClip {
  id: string
  text: string
  /** Absolute timeline start/end in seconds. */
  start: number
  end: number
  /** Centre position as fractions of the canvas. */
  x: number
  y: number
  /** Font size as a fraction of canvas height. */
  fontSize: number
  /**
   * 缩放倍数，作用在 fontSize 之上；缺省 1（旧草稿无此字段）。
   * 与 fontSize 分开，便于独立做缩放关键帧而不改字号基线。
   */
  scale?: number
  /** 不透明度 0–1；缺省 1（旧草稿无此字段）。 */
  opacity?: number
  color: string
  /** CSS colour; transparent means no backdrop. */
  background: string
  align: TextAlign
  bold: boolean
  fontFamily?: string
  /** Optional outline; width is a fraction of font size. */
  strokeColor?: string
  strokeWidth?: number
  /** 文字阴影颜色；未设置或 transparent 表示关闭。 */
  shadowColor?: string
  /** 阴影模糊半径，按 fontSize 的比例存储。 */
  shadowBlur?: number
  /** 阴影水平偏移，按 fontSize 的比例存储（可为负）。 */
  shadowOffsetX?: number
  /** 阴影垂直偏移，按 fontSize 的比例存储（可为负）。 */
  shadowOffsetY?: number
  /** Per-clip override that ranks above the track's group style. */
  styleOverride?: CaptionStyle
  /** Word-level timestamps used for accurate Enter-splitting. */
  words?: CaptionWord[]
  /** When set, the caption follows the linked clip through edits. */
  link?: CaptionLink
  /**
   * 文本关键帧：position.x / position.y / scale / opacity。
   * 时间基准是该文本片段自身的 start/end（归一化 0…1）；link 只改 start/end，
   * 不会重写关键帧，因此不需要也不应该再按 link 源区间重映射。
   */
  anim?: AnimationMap
  /** True once the user manually changed this caption's text (re-align keeps it). */
  edited?: boolean
}

export interface TextTrack {
  id: string
  name: string
  muted: boolean
  hidden: boolean
  enabled?: boolean
  locked?: boolean
  solo?: boolean
  /** Smart-caption tracks are `caption`; anything else (or missing) is `text`. */
  kind?: TextTrackKind
  /** Group style inherited by every caption clip on this track. */
  captionStyle?: CaptionStyle
  clips: TextClip[]
}

export interface Project {
  aspectRatio: AspectRatioPreset
  clips: Clip[]
  /** Optional overlay video tracks ordered bottom-to-top. */
  overlayTracks?: OverlayTrack[]
  /** Optional audio tracks, mixed under the video audio. */
  audioTracks?: AudioTrack[]
  /** Optional text/subtitle tracks rendered over the video. */
  textTracks?: TextTrack[]
  /** Primary video track controls; omitted means all defaults. */
  mainTrack?: Partial<TrackState>
  markers: Marker[]
  exportQuality: ExportQuality
  /** 画布背景；缺省为黑场（旧草稿无此字段）。 */
  canvasBackground?: CanvasBackground
  /** 封面（时间轴左侧独立块，不参与片段时长计算）；缺省无封面。 */
  cover?: ProjectCover
}

/** 封面来源：从素材某时刻截帧，或用户上传的图片。 */
export type CoverSource =
  | { kind: 'frame'; assetId?: string; time: number }
  | { kind: 'image'; name?: string }

/** 封面的导出行为：单独产出封面图，或作为视频首帧。 */
export type CoverMode = 'separate' | 'first-frame'

export interface ProjectCover {
  /** 封面图。dataURL（便于直接进草稿与工程文件，避免 blob URL 失效）。 */
  dataUrl: string
  /** 来源描述，仅用于 UI 显示。 */
  source: CoverSource
  /** 导出行为。 */
  mode: CoverMode
}

export interface SourceInfo {
  url: string
  name: string
  size: number
  duration: number
  width: number
  height: number
  /** Defaults to `video`. Audio assets have no visual dimensions. */
  kind?: MediaKind
  file?: File
  thumbnail?: string
  hasAudio?: boolean
}

/** A video in the project media library. `url` matches `Clip.sourceUrl`. */
export interface MediaAsset extends SourceInfo {
  id: string
  /**
   * 「倒放」生成的新素材会记录来源区间，便于同一片段同一区间重复倒放时复用，
   * 以及刷新草稿后仍能识别。缺省表示普通导入素材（旧数据同样没有该字段）。
   */
  reversedFrom?: ReverseAssetOrigin
}

/**
 * 倒放素材的来源记录：原素材（id 稳定；url 仅用于旧数据兜底）与源区间。
 * 区间用原始素材时间（秒）。
 */
export interface ReverseAssetOrigin {
  assetId?: string
  sourceUrl?: string
  start: number
  end: number
}

export interface TimelineSegment {
  clip: Clip
  index: number
  start: number
  end: number
  duration: number
}

export interface ActionAvailability {
  canSplit: boolean
  canTrimLeft: boolean
  canTrimRight: boolean
  canFreeze: boolean
  hasSelection: boolean
}
/** 可做关键帧动画的视觉属性。 */
export type AnimatableProperty =
  | 'position.x'
  | 'position.y'
  | 'scale'
  | 'rotation'
  | 'opacity'
  /** 音频增益 0…2；Clip（视频片段自身音轨）与 AudioClip 共用。 */
  | 'volume'

/** 关键帧缓动。 */
export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold'

/** 单个关键帧：时间（片段本地，0…1 归一化）+ 值 + 到下一帧的缓动。 */
export interface Keyframe {
  /** 片段本地归一化时间 0…1（0 = 片段起点，1 = 片段终点），变速/裁剪时按比例重映射。 */
  t: number
  value: number
  ease: Easing
}

/** 一个片段上的动画：按属性分组的关键帧列表。 */
export type AnimationMap = Partial<Record<AnimatableProperty, Keyframe[]>>
