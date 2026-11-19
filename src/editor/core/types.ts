/** A ratio preset shown in the top bar. `original` follows the source media. */
export type AspectRatioPreset = 'original' | '16:9' | '9:16' | '1:1' | '4:3' | '3:4'

export type ExportResolution = '480p' | '720p' | '1080p' | '4K'

export type ExportFps = 24 | 30 | 60

export interface ExportQuality {
  resolution: ExportResolution
  fps: ExportFps
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
export type TransitionType = 'fade' | 'fadeblack' | 'wipeleft' | 'slideleft' | 'circleopen'

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
  /** 与下一片段之间的转场；缺省无转场。 */
  transitionOut?: ClipTransition
  /** 片段级背景覆盖；缺省沿用工程级 canvasBackground。 */
  background?: CanvasBackground
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
  color: string
  /** CSS colour; transparent means no backdrop. */
  background: string
  align: TextAlign
  bold: boolean
  fontFamily?: string
  /** Optional outline; width is a fraction of font size. */
  strokeColor?: string
  strokeWidth?: number
  /** Per-clip override that ranks above the track's group style. */
  styleOverride?: CaptionStyle
  /** Word-level timestamps used for accurate Enter-splitting. */
  words?: CaptionWord[]
  /** When set, the caption follows the linked clip through edits. */
  link?: CaptionLink
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