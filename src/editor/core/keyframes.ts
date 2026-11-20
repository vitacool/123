import { clamp } from './timeline'
import { evalAnimation } from './animation'
import { clipOpacity } from './blend'
import {
  KEYFRAME_MIN_GAP,
  clampGroupDrag,
  clearPropertyKeyframes,
  findDuplicateProperty,
  keyframeAt,
  moveKeyframes,
  setEasingOnKeyframes,
  type KeyframeRef,
} from './keyframeEdit'
import type { AnimatableProperty, AnimationMap, Clip, Easing, Keyframe, Project } from './types'

/** 属性对应的片段基础值（新增关键帧时默认取当前生效值）。 */
export function propertyBaseValue(clip: Clip, prop: AnimatableProperty): number {
  switch (prop) {
    case 'position.x':
      return clip.position.x
    case 'position.y':
      return clip.position.y
    case 'scale':
      return clip.scale
    case 'rotation':
      return clip.rotation
    case 'opacity':
    default:
      return clipOpacity(clip)
  }
}

/** 当前动画在归一化时间 t 处的取值（没有关键帧时回落基础值）。 */
export function propertyValueAt(clip: Clip, prop: AnimatableProperty, t: number): number {
  return evalAnimation(clip.anim?.[prop], t, propertyBaseValue(clip, prop))
}

/** 在 ±1e-4 内视为同一时间点（归一化时间，1e-4 ≈ 30fps 下的 0.3 帧）。 */
const TIME_EPSILON = 1e-4

const sameTime = (a: number, b: number): boolean => Math.abs(a - b) <= TIME_EPSILON

/** 用新的关键帧列表替换某个属性的动画；空列表时移除该属性。 */
function withPropertyKeys(
  clip: Clip,
  prop: AnimatableProperty,
  keys: Keyframe[],
): Clip {
  const anim = { ...(clip.anim ?? {}) }
  if (keys.length === 0) delete anim[prop]
  else anim[prop] = keys
  const hasAny = Object.keys(anim).length > 0
  if (!hasAny) {
    const { anim: _omit, ...rest } = clip
    return rest as Clip
  }
  return { ...clip, anim }
}

/** 添加 / 替换某个时间点的关键帧。 */
export function setKeyframeInProject(
  project: Project,
  clipId: string,
  prop: AnimatableProperty,
  t: number,
  value: number,
  ease: Easing = 'linear',
): Project | null {
  const location = findClipAnywhere(project, clipId)
  if (!location) return null
  const clip = location.clip
  const time = clamp(t, 0, 1)
  const keys = [...(clip.anim?.[prop] ?? [])]
  const index = keys.findIndex((key) => sameTime(key.t, time))
  const next: Keyframe = { t: time, value, ease }
  if (index >= 0) keys[index] = next
  else keys.push(next)
  keys.sort((a, b) => a.t - b.t)
  const updated = withPropertyKeys(clip, prop, keys)
  return replaceClip(project, location, updated)
}

/** 删除某个时间点的关键帧。 */
export function removeKeyframeInProject(
  project: Project,
  clipId: string,
  prop: AnimatableProperty,
  t: number,
): Project | null {
  const location = findClipAnywhere(project, clipId)
  if (!location) return null
  const clip = location.clip
  const keys = clip.anim?.[prop] ?? []
  const time = clamp(t, 0, 1)
  const next = keys.filter((key) => !sameTime(key.t, time))
  if (next.length === keys.length) return null
  const updated = withPropertyKeys(clip, prop, next)
  return replaceClip(project, location, updated)
}

interface ClipLocation {
  clip: Clip
  trackId: string | null
}

function findClipAnywhere(project: Project, clipId: string): ClipLocation | null {
  const main = project.clips.find((clip) => clip.id === clipId)
  if (main) return { clip: main, trackId: null }
  for (const track of project.overlayTracks ?? []) {
    const clip = track.clips.find((item) => item.id === clipId)
    if (clip) return { clip, trackId: track.id }
  }
  return null
}

function replaceClip(project: Project, location: ClipLocation, updated: Clip): Project {
  if (location.trackId === null) {
    return {
      ...project,
      clips: project.clips.map((clip) => (clip.id === updated.id ? updated : clip)),
    }
  }
  return {
    ...project,
    overlayTracks: (project.overlayTracks ?? []).map((track) =>
      track.id === location.trackId
        ? { ...track, clips: track.clips.map((clip) => (clip.id === updated.id ? updated : clip)) }
        : track,
    ),
  }
}
/** 片段所有属性上的关键帧时间点（去重排序），用于时间轴刻度。 */
export function animationFrameTimes(clip: Pick<Clip, 'anim'>): number[] {
  const anim = clip.anim
  if (!anim) return []
  const times = new Set<number>()
  for (const keys of Object.values(anim)) {
    for (const key of keys ?? []) times.add(Math.round(key.t * 1e6) / 1e6)
  }
  return [...times].sort((a, b) => a - b)
}

/** 多选整体平移关键帧；夹取后若有同属性重复则返回 null（调用方 Toast 并放弃）。 */
export function moveKeyframesInProject(
  project: Project,
  clipId: string,
  selected: readonly KeyframeRef[],
  delta: number,
): Project | null {
  const location = findClipAnywhere(project, clipId)
  if (!location || !location.clip.anim) return null
  const clamped = clampGroupDrag(location.clip.anim, selected, delta)
  if (Math.abs(clamped) < 1e-9) return null
  const moved = moveKeyframes(location.clip.anim, selected, clamped)
  if (!moved) return null
  if (findDuplicateProperty(moved)) return null
  const updated = withAnimValue(location.clip, moved)
  return replaceClip(project, location, updated)
}

/** 批量设置选中关键帧的缓动。 */
export function setKeyframeEasingInProject(
  project: Project,
  clipId: string,
  selected: readonly KeyframeRef[],
  ease: Easing,
): Project | null {
  const location = findClipAnywhere(project, clipId)
  if (!location || !location.clip.anim) return null
  const next = setEasingOnKeyframes(location.clip.anim, selected, ease)
  if (!next) return null
  let changed = false
  for (const ref of selected) {
    const before = keyframeAt(location.clip.anim, ref.prop, ref.t)
    if (before && before.ease !== ease) changed = true
  }
  if (!changed) return null
  return replaceClip(project, location, withAnimValue(location.clip, next))
}

/** 清空某个属性的全部关键帧。 */
export function clearPropertyKeyframesInProject(
  project: Project,
  clipId: string,
  prop: AnimatableProperty,
): Project | null {
  const location = findClipAnywhere(project, clipId)
  if (!location || !location.clip.anim?.[prop]) return null
  const next = clearPropertyKeyframes(location.clip.anim, prop)
  return replaceClip(project, location, withAnimValue(location.clip, next))
}

/** 把 anim 写回片段；undefined 表示移除该字段。 */
function withAnimValue(clip: Clip, anim: AnimationMap | undefined): Clip {
  if (anim && Object.keys(anim).length > 0) return { ...clip, anim }
  if (!('anim' in clip)) return clip
  const { anim: _omit, ...rest } = clip
  return rest as Clip
}

/** 批量删除关键帧（一次命令，1 步撤销）。 */
export function removeKeyframesInProject(
  project: Project,
  clipId: string,
  refs: readonly KeyframeRef[],
): Project | null {
  const location = findClipAnywhere(project, clipId)
  if (!location || !location.clip.anim) return null
  let current = location.clip
  let removed = 0
  for (const ref of refs) {
    const keys = current.anim?.[ref.prop]
    if (!keys) continue
    const next = keys.filter((key) => Math.abs(key.t - ref.t) >= KEYFRAME_MIN_GAP / 2)
    if (next.length === keys.length) continue
    removed += keys.length - next.length
    current = withAnimValue(current, next.length > 0 ? { ...current.anim, [ref.prop]: next } : clearPropertyKeyframes(current.anim, ref.prop))
  }
  if (removed === 0) return null
  return replaceClip(project, location, current)
}
