import type {
  AspectRatioPreset,
  CaptionLink,
  CaptionStyle,
  CaptionWord,
  Project,
  TextAlign,
  TextClip,
  TextTrack,
  TextTrackKind,
} from './types'

export const TEXT_MIN_DURATION = 0.2

/** JianYing-style default caption outline. Width is a fraction of font size. */
export const CAPTION_STROKE_COLOR = '#000000'
export const CAPTION_STROKE_WIDTH = 0.06

/** 旧草稿没有阴影字段时的归一化默认值：关闭、无模糊、无偏移。 */
export const TEXT_SHADOW_DEFAULTS = {
  shadowColor: 'transparent',
  shadowBlur: 0,
  shadowOffsetX: 0,
  shadowOffsetY: 0,
} as const

/** 面板里打开阴影时使用的一套轻微右下阴影，按 fontSize 比例。 */
export const TEXT_SHADOW_ENABLED_DEFAULTS = {
  shadowColor: 'rgba(0, 0, 0, 0.55)',
  shadowBlur: 0.08,
  shadowOffsetX: 0.03,
  shadowOffsetY: 0.05,
} as const

/** Portrait canvases use a smaller caption so text stays proportionate. */
export function captionFontSize(aspectRatio: AspectRatioPreset): number {
  return aspectRatio === '9:16' || aspectRatio === '3:4' ? 0.042 : 0.055
}

export interface CaptionStylePreset {
  id: string
  label: string
  style: CaptionStyle
}

/** 剪映式字幕样式预设，点一下应用整条字幕轨。 */
export const CAPTION_STYLE_PRESETS: CaptionStylePreset[] = [
  {
    id: 'classic',
    label: '经典白字黑边',
    style: {
      color: '#ffffff',
      strokeColor: CAPTION_STROKE_COLOR,
      strokeWidth: CAPTION_STROKE_WIDTH,
      background: 'transparent',
      bold: false,
      x: 0.5,
      y: 0.86,
      align: 'center',
    },
  },
  {
    id: 'shadow',
    label: '白字黑边阴影',
    style: {
      color: '#ffffff',
      strokeColor: CAPTION_STROKE_COLOR,
      strokeWidth: CAPTION_STROKE_WIDTH,
      ...TEXT_SHADOW_ENABLED_DEFAULTS,
      background: 'transparent',
      bold: false,
      x: 0.5,
      y: 0.86,
      align: 'center',
    },
  },
  {
    id: 'yellow',
    label: '黄字黑边',
    style: {
      color: '#ffd23f',
      strokeColor: CAPTION_STROKE_COLOR,
      strokeWidth: CAPTION_STROKE_WIDTH,
      background: 'transparent',
      bold: false,
      x: 0.5,
      y: 0.86,
      align: 'center',
    },
  },
  {
    id: 'black-bg',
    label: '黑底白字',
    style: {
      color: '#ffffff',
      strokeColor: CAPTION_STROKE_COLOR,
      strokeWidth: 0,
      background: 'rgba(0, 0, 0, 0.6)',
      bold: false,
      x: 0.5,
      y: 0.86,
      align: 'center',
    },
  },
  {
    id: 'show',
    label: '综艺描边',
    style: {
      color: '#ffffff',
      strokeColor: '#ff5a4e',
      strokeWidth: 0.12,
      background: 'transparent',
      bold: true,
      x: 0.5,
      y: 0.86,
      align: 'center',
    },
  },
]

/** 从一条字幕上反推出字幕组样式（旧草稿没有 captionStyle 时的回退）。 */
export function deriveCaptionStyle(clip: TextClip): CaptionStyle {
  return {
    fontSize: clip.fontSize,
    color: clip.color,
    strokeColor: clip.strokeColor,
    strokeWidth: clip.strokeWidth,
    shadowColor: clip.shadowColor,
    shadowBlur: clip.shadowBlur,
    shadowOffsetX: clip.shadowOffsetX,
    shadowOffsetY: clip.shadowOffsetY,
    background: clip.background,
    x: clip.x,
    y: clip.y,
    align: clip.align,
    bold: clip.bold,
    fontFamily: clip.fontFamily,
  }
}

/** 字幕轨的生效组样式：没有 captionStyle 时从第一条字幕反推。 */
export function captionStyleForTrack(track: TextTrack): CaptionStyle | undefined {
  if (track.captionStyle) return track.captionStyle
  const first = track.clips[0]
  return first ? deriveCaptionStyle(first) : undefined
}

/**
 * 字幕样式取值顺序：clip.styleOverride（单条覆盖）> track.captionStyle（组样式）
 * > clip 自身的字段（默认值）。预览与导出共用这一份合并逻辑。
 */
export function resolveCaptionStyle(
  clip: TextClip,
  captionStyle?: CaptionStyle | null,
): TextClip {
  const override = clip.styleOverride
  const group = captionStyle
  return {
    ...clip,
    fontSize: override?.fontSize ?? group?.fontSize ?? clip.fontSize,
    color: override?.color ?? group?.color ?? clip.color,
    strokeColor: override?.strokeColor ?? group?.strokeColor ?? clip.strokeColor,
    strokeWidth: override?.strokeWidth ?? group?.strokeWidth ?? clip.strokeWidth,
    shadowColor: override?.shadowColor ?? group?.shadowColor ?? clip.shadowColor,
    shadowBlur: override?.shadowBlur ?? group?.shadowBlur ?? clip.shadowBlur,
    shadowOffsetX: override?.shadowOffsetX ?? group?.shadowOffsetX ?? clip.shadowOffsetX,
    shadowOffsetY: override?.shadowOffsetY ?? group?.shadowOffsetY ?? clip.shadowOffsetY,
    background: override?.background ?? group?.background ?? clip.background,
    x: override?.x ?? group?.x ?? clip.x,
    y: override?.y ?? group?.y ?? clip.y,
    align: override?.align ?? group?.align ?? clip.align,
    bold: override?.bold ?? group?.bold ?? clip.bold,
    fontFamily: override?.fontFamily ?? group?.fontFamily ?? clip.fontFamily,
  }
}

export interface TextClipLocation {
  track: TextTrack
  clip: TextClip
  index: number
}

export interface SubtitleCue {
  start: number
  end: number
  text: string
}

export function textClipDuration(clip: TextClip): number {
  return Math.max(0, clip.end - clip.start)
}

export function textProjectEnd(project: Project): number {
  let end = 0
  for (const track of project.textTracks ?? []) {
    for (const clip of track.clips) end = Math.max(end, clip.end)
  }
  return end
}

export interface TextActionAvailability {
  canSplit: boolean
  canTrimLeft: boolean
  canTrimRight: boolean
}

export function getTextActionAvailability(
  project: Project,
  clipId: string | null,
  playhead: number,
): TextActionAvailability {
  const location = findTextClipLocation(project, clipId)
  if (!location) {
    return { canSplit: false, canTrimLeft: false, canTrimRight: false }
  }
  const inside =
    playhead > location.clip.start + TEXT_MIN_DURATION &&
    playhead < location.clip.end - TEXT_MIN_DURATION
  return { canSplit: inside, canTrimLeft: inside, canTrimRight: inside }
}

export function findTextClipLocation(
  project: Project,
  id: string | null,
): TextClipLocation | null {
  if (!id) return null
  for (const track of project.textTracks ?? []) {
    const index = track.clips.findIndex((clip) => clip.id === id)
    if (index >= 0) return { track, clip: track.clips[index], index }
  }
  return null
}

export function createTextTrack(
  project: Project,
  trackId: string,
  kind?: TextTrackKind,
): { project: Project; track: TextTrack } {
  const tracks = project.textTracks ?? []
  const track: TextTrack = {
    id: trackId,
    name: `文本轨 ${tracks.length + 1}`,
    muted: false,
    hidden: false,
    enabled: true,
    locked: false,
    solo: false,
    clips: [],
  }
  if (kind) track.kind = kind
  return { project: { ...project, textTracks: [...tracks, track] }, track }
}

export function addTextTrackToProject(
  project: Project,
  trackId: string,
  kind?: TextTrackKind,
): Project {
  return createTextTrack(project, trackId, kind).project
}


export function removeTextTrackFromProject(project: Project, trackId: string): Project | null {
  const tracks = project.textTracks ?? []
  if (!tracks.some((track) => track.id === trackId)) return null
  return { ...project, textTracks: tracks.filter((track) => track.id !== trackId) }
}

export function updateTextTrackInProject(
  project: Project,
  trackId: string,
  update: Partial<Pick<TextTrack, 'name' | 'muted' | 'hidden' | 'enabled' | 'locked' | 'solo'>>,
): Project | null {
  const tracks = project.textTracks ?? []
  if (!tracks.some((track) => track.id === trackId)) return null
  return {
    ...project,
    textTracks: tracks.map((track) =>
      track.id === trackId ? { ...track, ...update } : track,
    ),
  }
}

/** Applies a group style to a caption track and clears all per-clip overrides. */
export function updateCaptionStyleInProject(
  project: Project,
  trackId: string,
  captionStyle: CaptionStyle,
): Project | null {
  const tracks = project.textTracks ?? []
  const track = tracks.find((item) => item.id === trackId)
  if (!track) return null
  return {
    ...project,
    textTracks: tracks.map((item) =>
      item.id === trackId
        ? {
            ...item,
            captionStyle: { ...captionStyle },
            clips: item.clips.map((clip) => {
              if (!clip.styleOverride) return clip
              return { ...clip, styleOverride: undefined }
            }),
          }
        : item,
    ),
  }
}

/** Writes a per-clip style override on one caption clip. */
export function updateCaptionClipStyleInProject(
  project: Project,
  trackId: string,
  clipId: string,
  styleOverride: CaptionStyle,
): Project | null {
  const tracks = project.textTracks ?? []
  const track = tracks.find((item) => item.id === trackId)
  if (!track || !track.clips.some((clip) => clip.id === clipId)) return null
  return {
    ...project,
    textTracks: tracks.map((item) =>
      item.id === trackId
        ? {
            ...item,
            clips: sortTextClips(
              item.clips.map((clip) =>
                clip.id === clipId ? { ...clip, styleOverride: { ...styleOverride } } : clip,
              ),
            ),
          }
        : item,
    ),
  }
}

function sortTextClips(clips: TextClip[]): TextClip[] {
  return [...clips].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))
}

export function addTextClipToProject(
  project: Project,
  trackId: string,
  clip: TextClip,
): Project | null {
  const tracks = project.textTracks ?? []
  let target = tracks.find((track) => track.id === trackId)
  let nextTracks = tracks
  if (!target) {
    const created = createTextTrack(project, trackId)
    target = created.track
    nextTracks = created.project.textTracks ?? []
  }
  return {
    ...project,
    textTracks: nextTracks.map((track) =>
      track.id === trackId
        ? { ...track, clips: sortTextClips([...track.clips, clip]) }
        : track,
    ),
  }
}

export function updateTextClipInProject(
  project: Project,
  trackId: string,
  clipId: string,
  update: Partial<Omit<TextClip, 'id'>>,
): Project | null {
  const tracks = project.textTracks ?? []
  const track = tracks.find((item) => item.id === trackId)
  if (!track || !track.clips.some((clip) => clip.id === clipId)) return null
  // 修复 A·3：任何改写 start/end 的路径都视为“手动改时间”，解除联动。
  const changesTime = update.start !== undefined || update.end !== undefined
  return {
    ...project,
    textTracks: tracks.map((item) =>
      item.id === trackId
        ? {
            ...item,
            clips: sortTextClips(
              item.clips.map((clip) => {
                if (clip.id !== clipId) return clip
                const next = { ...clip, ...update }
                if (changesTime && clip.link) {
                  next.link = undefined
                  next.words = undefined
                }
                return next
              }),
            ),
          }
        : item,
    ),
  }
}

export function removeTextClipFromProject(
  project: Project,
  trackId: string,
  clipId: string,
): Project | null {
  const tracks = project.textTracks ?? []
  const track = tracks.find((item) => item.id === trackId)
  if (!track || !track.clips.some((clip) => clip.id === clipId)) return null
  return {
    ...project,
    textTracks: tracks.map((item) =>
      item.id === trackId
        ? { ...item, clips: item.clips.filter((clip) => clip.id !== clipId) }
        : item,
    ),
  }
}

export function moveTextClipInProject(
  project: Project,
  trackId: string,
  clipId: string,
  start: number,
): Project | null {
  const location = findTextClipLocation(project, clipId)
  if (!location || location.track.id !== trackId) return null
  const nextStart = Math.max(0, start)
  if (Math.abs(nextStart - location.clip.start) < 0.0001) return null
  const update: Partial<Omit<TextClip, 'id'>> = {
    start: nextStart,
    end: nextStart + textClipDuration(location.clip),
  }
  // 手动拖动过时间的字幕转成普通字幕，不再联动。
  if (location.clip.link) {
    update.link = undefined
    update.words = undefined
  }
  return updateTextClipInProject(project, trackId, clipId, update)
}

export function resizeTextClipInProject(
  project: Project,
  trackId: string,
  clipId: string,
  edge: 'left' | 'right',
  delta: number,
): Project | null {
  const location = findTextClipLocation(project, clipId)
  if (!location || location.track.id !== trackId) return null
  const clip = location.clip
  if (edge === 'left') {
    const nextStart = Math.max(0, Math.min(clip.end - TEXT_MIN_DURATION, clip.start + delta))
    if (Math.abs(nextStart - clip.start) < 0.0001) return null
    return updateTextClipInProject(project, trackId, clipId, { start: nextStart })
  }
  const nextEnd = Math.max(clip.start + TEXT_MIN_DURATION, clip.end + delta)
  if (Math.abs(nextEnd - clip.end) < 0.0001) return null
  return updateTextClipInProject(project, trackId, clipId, { end: nextEnd })
}

export function trimTextClipAt(
  project: Project,
  trackId: string,
  clipId: string,
  time: number,
  edge: 'left' | 'right',
): Project | null {
  const location = findTextClipLocation(project, clipId)
  if (!location || location.track.id !== trackId) return null
  const clip = location.clip
  if (time <= clip.start + TEXT_MIN_DURATION || time >= clip.end - TEXT_MIN_DURATION) {
    return null
  }
  return updateTextClipInProject(
    project,
    trackId,
    clipId,
    edge === 'left' ? { start: time } : { end: time },
  )
}

export function splitTextClipInProject(
  project: Project,
  trackId: string,
  clipId: string,
  time: number,
  rightId: string,
): Project | null {
  const location = findTextClipLocation(project, clipId)
  if (!location || location.track.id !== trackId) return null
  const clip = location.clip
  if (time <= clip.start + TEXT_MIN_DURATION || time >= clip.end - TEXT_MIN_DURATION) {
    return null
  }
  const left: TextClip = { ...clip, end: time }
  const right: TextClip = { ...clip, id: rightId, start: time }
  // 修复 A·3：分割时解除联动；words 按切点拆给左右两半。
  left.link = undefined
  right.link = undefined
  if (clip.words && clip.words.length > 0) {
    left.words = clip.words.filter((word) => word.start < time)
    right.words = clip.words.filter((word) => word.start >= time)
  }
  const clips = [...location.track.clips]
  clips.splice(location.index, 1, left, right)
  return {
    ...project,
    textTracks: (project.textTracks ?? []).map((track) =>
      track.id === trackId ? { ...track, clips: sortTextClips(clips) } : track,
    ),
  }
}

function parseSubtitleTime(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(value.trim())
  if (!match) return null
  const [, hours, minutes, seconds, fraction] = match
  return (
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(fraction.padEnd(3, '0')) / 1000
  )
}

/** Parses SRT or WebVTT into plain cues. */
export function parseSubtitleText(input: string): SubtitleCue[] {
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const blocks = text.split(/\n{2,}/)
  const cues: SubtitleCue[] = []
  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim().length > 0)
    if (lines.length === 0) continue
    const timelineIndex = lines.findIndex((line) => line.includes('-->'))
    if (timelineIndex < 0) continue
    const [startRaw, endRaw] = lines[timelineIndex].split('-->')
    const start = parseSubtitleTime(startRaw)
    const end = parseSubtitleTime((endRaw ?? '').trim().split(/\s+/)[0] ?? '')
    if (start === null || end === null || end <= start) continue
    const content = lines
      .slice(timelineIndex + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .trim()
    if (!content) continue
    cues.push({ start, end, text: content })
  }
  return cues
}

export function cueToTextClip(
  cue: SubtitleCue,
  id: string,
  overrides: Partial<Omit<TextClip, 'id' | 'text' | 'start' | 'end'>> = {},
): TextClip {
  return {
    id,
    text: cue.text,
    start: cue.start,
    end: Math.max(cue.start + TEXT_MIN_DURATION, cue.end),
    x: 0.5,
    y: 0.86,
    fontSize: 0.055,
    color: '#ffffff',
    background: 'transparent',
    align: 'center',
    bold: true,
    ...overrides,
  }
}

/**
 * Builds a smart-caption clip in the JianYing default style: white text with a
 * black outline, no bold, transparent background and bottom-centre placement.
 * Font size adapts to the project aspect ratio.
 */
export function cueToCaptionClip(
  cue: SubtitleCue & { words?: CaptionWord[]; link?: CaptionLink },
  id: string,
  aspectRatio: AspectRatioPreset,
): TextClip {
  const clip: TextClip = {
    id,
    text: cue.text,
    start: cue.start,
    end: Math.max(cue.start + TEXT_MIN_DURATION, cue.end),
    x: 0.5,
    y: 0.86,
    fontSize: captionFontSize(aspectRatio),
    color: '#ffffff',
    background: 'transparent',
    align: 'center',
    bold: false,
    strokeColor: CAPTION_STROKE_COLOR,
    strokeWidth: CAPTION_STROKE_WIDTH,
  }
  if (cue.words) clip.words = cue.words
  if (cue.link) clip.link = cue.link
  return clip
}

/** Serialises cues to standard SRT. */
export function serializeSrt(cues: readonly { start: number; end: number; text: string }[]): string {
  const pad = (value: number, width: number): string => String(value).padStart(width, '0')
  const timestamp = (seconds: number): string => {
    const totalMs = Math.max(0, Math.round(seconds * 1000))
    const hours = Math.floor(totalMs / 3_600_000)
    const minutes = Math.floor((totalMs % 3_600_000) / 60_000)
    const secs = Math.floor((totalMs % 60_000) / 1000)
    const ms = totalMs % 1000
    return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)},${pad(ms, 3)}`
  }
  return cues
    .map((cue, index) => {
      const body = cue.text.replace(/\r\n?/g, '\n').trim()
      return `${index + 1}\n${timestamp(cue.start)} --> ${timestamp(cue.end)}\n${body}\n`
    })
    .join('\n')
}

/** Creates (or replaces onto) a caption-kind track and adds the given clips. */
export function addCaptionTrackWithClips(
  project: Project,
  trackId: string,
  clips: TextClip[],
  trackName: string,
): Project {
  let next = addTextTrackToProject(project, trackId, 'caption')
  next = updateTextTrackInProject(next, trackId, { name: trackName }) ?? next
  for (const clip of clips) {
    next = addTextClipToProject(next, trackId, clip) ?? next
  }
  return next
}

/**
 * 把某条字幕轨的 clips 整体替换，但保留该轨的 id/name/captionStyle 与开关状态。
 * 若轨道不存在则新建一条 caption 轨。
 */
export function setCaptionTrackClips(
  project: Project,
  trackId: string,
  clips: TextClip[],
): Project {
  const tracks = project.textTracks ?? []
  const existing = tracks.find((track) => track.id === trackId)
  if (existing) {
    return {
      ...project,
      textTracks: tracks.map((track) =>
        track.id === trackId ? { ...track, clips: sortTextClips(clips) } : track,
      ),
    }
  }
  return addCaptionTrackWithClips(project, trackId, clips, '智能字幕')
}

/** 在一条字幕轨内全部替换文字（一个 command）。 */
export function replaceTextInTrack(
  project: Project,
  trackId: string,
  find: string,
  replace: string,
): Project | null {
  if (!find) return null
  const tracks = project.textTracks ?? []
  const track = tracks.find((item) => item.id === trackId)
  if (!track) return null
  let changed = false
  let clips = track.clips
  clips = track.clips.map((clip) => {
    if (!clip.text.includes(find)) return clip
    changed = true
    return {
      ...clip,
      text: clip.text.split(find).join(replace),
      words: undefined,
      edited: true,
    }
  })
  if (!changed) return null
  return {
    ...project,
    textTracks: tracks.map((item) => (item.id === trackId ? { ...item, clips } : item)),
  }
}

export function defaultTextAlign(): TextAlign {
  return 'center'
}

/** 把一条字幕从光标处拆成左右两条，写入项目。 */
export function splitTextCaptionInProject(
  project: Project,
  trackId: string,
  clipId: string,
  parts: {
    leftText: string
    rightText: string
    leftStart: number
    leftEnd: number
    rightStart: number
    rightEnd: number
    leftWords?: CaptionWord[]
    rightWords?: CaptionWord[]
  },
  rightId: string,
): Project | null {
  const location = findTextClipLocation(project, clipId)
  if (!location || location.track.id !== trackId) return null
  const clip = location.clip
  const left: TextClip = { ...clip, end: parts.leftEnd, text: parts.leftText }
  const right: TextClip = { ...clip, id: rightId, start: parts.rightStart, end: parts.rightEnd, text: parts.rightText }
  if (parts.leftWords) left.words = parts.leftWords
  if (parts.rightWords) right.words = parts.rightWords
  // 拆句后不再联动（时间已被人工改写）。
  left.link = undefined
  right.link = undefined
  const clips = [...location.track.clips]
  clips.splice(location.index, 1, left, right)
  return {
    ...project,
    textTracks: (project.textTracks ?? []).map((track) =>
      track.id === trackId ? { ...track, clips: sortTextClips(clips) } : track,
    ),
  }
}

/** 把一条字幕合并到上一条。 */
export function mergeTextCaptionWithPrevious(
  project: Project,
  trackId: string,
  clipId: string,
): Project | null {
  const tracks = project.textTracks ?? []
  const track = tracks.find((item) => item.id === trackId)
  if (!track) return null
  const index = track.clips.findIndex((clip) => clip.id === clipId)
  if (index <= 0) return null
  const clip = track.clips[index]
  const previous = track.clips[index - 1]
  const merged: TextClip = {
    ...previous,
    end: clip.end,
    text: previous.text + clip.text,
    words:
      previous.words && clip.words ? [...previous.words, ...clip.words] : undefined,
    link: undefined,
    // 任一条被手改过，合并结果都视为“手改过”，避免重新对齐时丢文字。
    edited: previous.edited || clip.edited,
  }
  return {
    ...project,
    textTracks: tracks.map((item) =>
      item.id === trackId
        ? {
            ...item,
            clips: sortTextClips([
              ...item.clips.slice(0, index - 1),
              merged,
              ...item.clips.slice(index + 1),
            ]),
          }
        : item,
    ),
  }
}