export const HISTORY_LIMIT = 100

/** Boundaries are treated as "no operation" for destructive edits. */
export const CLIP_EDGE_EPSILON = 0.001
/** A split may not create a piece shorter than this. */
export const MIN_CLIP_DURATION = 0.05

export const FREEZE_DEFAULT_DURATION = 3
export const FREEZE_MIN_DURATION = 0.5
export const FREEZE_MAX_DURATION = 10

export const SCALE_MIN = 0.1
export const SCALE_MAX = 4
export const ROTATION_MIN = -180
export const ROTATION_MAX = 180

export const MAX_RECOMMENDED_FILE_BYTES = 500 * 1024 * 1024
export const LARGE_FILE_WARNING_BYTES = 300 * 1024 * 1024

export const TIMELINE_MIN_ZOOM = 24
export const TIMELINE_MAX_ZOOM = 320
export const TIMELINE_DEFAULT_ZOOM = 92

/** Primary video track plus up to 7 overlay video tracks. */
export const MAX_VIDEO_TRACKS = 8
export const MAX_OVERLAY_TRACKS = MAX_VIDEO_TRACKS - 1

export const CROP_PRESETS = [
  { id: 'free', label: '自由' },
  { id: 'original', label: '原始' },
  { id: '16:9', label: '16:9' },
  { id: '9:16', label: '9:16' },
  { id: '1:1', label: '1:1' },
  { id: '4:3', label: '4:3' },
  { id: '3:4', label: '3:4' },
] as const

export type CropPresetId = (typeof CROP_PRESETS)[number]['id']

export const ASPECT_PRESETS: { id: import('./types').AspectRatioPreset; label: string }[] = [
  { id: 'original', label: '原始' },
  { id: '16:9', label: '16:9' },
  { id: '9:16', label: '9:16' },
  { id: '1:1', label: '1:1' },
  { id: '4:3', label: '4:3' },
  { id: '3:4', label: '3:4' },
]

export const MARKER_COLORS = [
  '#e4573d',
  '#f2a63b',
  '#6f9d82',
  '#5b84b1',
  '#9b7bb5',
  '#4a4744',
] as const

export const EMPTY_PROJECT_ASPECT = 16 / 9