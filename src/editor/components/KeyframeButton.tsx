import { useMemo } from 'react'
import { findAnimationTarget } from '../core/animationTargets'
import type { AnimatableProperty, AnimationMap } from '../core/types'
import { useEditorStore } from '../store/EditorProvider'

/**
 * 属性行右侧的关键帧按钮：
 * - 空心菱形：该属性无关键帧
 * - 半实心：有关键帧但播放头处没有
 * - 实心：播放头处正好有关键帧
 * 点击在当前播放头处添加 / 删除关键帧（走命令，1 步撤销）。
 *
 * 只依赖 id + anim，因此视频片段、音频片段、文本片段共用同一个组件。
 */
export function KeyframeButton({
  prop,
  clip,
}: {
  prop: AnimatableProperty
  clip: { id: string; anim?: AnimationMap }
}) {
  const project = useEditorStore((state) => state.project)
  const playhead = useEditorStore((state) => state.playhead)
  const toggleKeyframe = useEditorStore((state) => state.toggleKeyframe)

  const keys = clip.anim?.[prop] ?? []
  const t = useMemo(() => {
    const target = findAnimationTarget(project, clip.id)
    if (!target) return 0
    const duration = target.duration
    if (duration <= 0) return 0
    const local = Math.max(0, playhead - target.start)
    return Math.min(1, local / duration)
  }, [project, clip.id, playhead])

  const atPlayhead = keys.some((key) => Math.abs(key.t - t) <= 1e-4)
  const state = keys.length === 0 ? 'empty' : atPlayhead ? 'at' : 'any'
  const count = keys.length

  return (
    <span className="keyframe-row">
      <button
        type="button"
        className={`keyframe-button${state === 'at' ? ' is-at' : state === 'any' ? ' is-any' : ''}`}
        aria-label={
          state === 'at'
            ? '删除当前时间的关键帧'
            : '在当前时间添加关键帧'
        }
        aria-pressed={state === 'at'}
        title={
          state === 'at'
            ? '删除当前时间的关键帧'
            : state === 'any'
              ? '在当前时间添加关键帧（该属性已有动画）'
              : '在当前时间添加关键帧，开始做动画'
        }
        onClick={() => toggleKeyframe(prop)}
      >
        <span className="keyframe-diamond" aria-hidden="true" />
      </button>
      {count > 0 && <span className="keyframe-count">{count} 帧</span>}
    </span>
  )
}