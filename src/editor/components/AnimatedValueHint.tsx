import { useMemo } from 'react'
import { evalAnimation } from '../core/animation'
import { propertyBaseValue } from '../core/keyframes'
import { findClipLocation } from '../core/timeline'
import { ANIMATABLE_LABELS } from './keyframeLabels'
import type { AnimatableProperty, Clip } from '../core/types'
import { useEditorStore } from '../store/EditorProvider'

/** 数值格式化：位置用百分比、旋转用度、缩放用百分比、不透明度用百分比。 */
export function formatAnimatedValue(prop: AnimatableProperty, value: number): string {
  switch (prop) {
    case 'position.x':
    case 'position.y':
      return `${Math.round(value * 100)}%`
    case 'scale':
      return `${Math.round(value * 100)}%`
    case 'rotation':
      return `${Math.round(value)}°`
    case 'opacity':
    default:
      return `${Math.round(value * 100)}%`
  }
}

/**
 * 有动画时在数值旁提示「当前动画值（基础值）」。
 * 否则用户会疑惑：数值框显示的是基础值，但画面按动画走，为什么拖动没反应。
 */
export function AnimatedValueHint({ prop, clip }: { prop: AnimatableProperty; clip: Clip }) {
  const project = useEditorStore((state) => state.project)
  const playhead = useEditorStore((state) => state.playhead)
  const keys = clip.anim?.[prop] ?? []

  const info = useMemo(() => {
    if (keys.length === 0) return null
    const location = findClipLocation(project, clip.id)
    if (!location) return null
    const duration = location.segment.duration
    const local = Math.max(0, playhead - location.segment.start)
    const t = duration > 0 ? Math.min(1, local / duration) : 0
    return {
      current: evalAnimation(keys, t, propertyBaseValue(clip, prop)),
      base: propertyBaseValue(clip, prop),
    }
  }, [keys, project, clip, prop, playhead])

  if (!info) return null
  return (
    <span
      className="kf-animated-base"
      title={`${ANIMATABLE_LABELS[prop]}：当前动画值 ${formatAnimatedValue(prop, info.current)}，基础值 ${formatAnimatedValue(prop, info.base)}`}
    >
      {formatAnimatedValue(prop, info.current)}（基础 {formatAnimatedValue(prop, info.base)}）
    </span>
  )
}