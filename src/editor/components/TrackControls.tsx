import { useEffect, useRef, useState } from 'react'
import type { TrackFlag, TrackKind } from '../core/tracks'
import type { TrackState } from '../core/types'
import { useEditorStore } from '../store/EditorProvider'
import { ContextMenu } from './ContextMenu'
import { Icon } from './Icon'

interface TrackControlsProps {
  kind: TrackKind
  trackId: string | null
  name: string
  state: TrackState
  height: number
  /** Audio track is silenced by another track's solo. */
  suppressedBySolo?: boolean
  onRemove?: () => void
  /** 叠加轨层级调整：'up' = 更靠上层；已在边界时对应按钮置灰。 */
  canMoveUp?: boolean
  canMoveDown?: boolean
  onMoveUp?: () => void
  onMoveDown?: () => void
  /** 主轨行的封面入口。 */
  onOpenCover?: () => void
  /** 音频轨轨道级增益（0…2）；仅 kind==='audio' 时渲染。 */
  volume?: number
  /** 增益提交（松手 / 键盘结束 / 失焦时触发一次）。 */
  onVolumeChange?: (volume: number) => void
}

const titles: Record<TrackFlag, string> = {
  enabled: '停用整轨画面与声音（不删除素材）',
  locked: '锁定轨道素材，禁止编辑；播放不受影响',
  hidden: '隐藏本轨画面；声音不受影响',
  muted: '静音本轨声音；画面不受影响',
  solo: '独奏本轨声音；其他未独奏轨道自动静音',
}

/**
 * 轨道级音量。拖动时只改本地草稿，松手 / 键盘结束 / 失焦才提交一次，
 * 这样一次拖动只产生一步撤销（轨道音量此前没有常驻入口）。
 */
function TrackVolume({
  value,
  ariaLabel,
  onChange,
}: {
  value: number
  ariaLabel: string
  onChange: (value: number) => void
}) {
  const [draft, setDraft] = useState(value)
  const dirty = useRef(false)
  const interacting = useRef(false)
  useEffect(() => {
    if (!interacting.current) setDraft(value)
  }, [value])
  const commit = () => {
    if (!dirty.current) return
    dirty.current = false
    onChange(draft)
  }
  const percent = Math.round(draft * 100)
  return (
    <input
      type="range"
      className="track-volume"
      min={0}
      max={200}
      step={1}
      value={percent}
      aria-label={ariaLabel}
      title={`音量 ${percent}%`}
      onPointerDown={() => {
        interacting.current = true
      }}
      onChange={(event) => {
        dirty.current = true
        setDraft(Number(event.target.value) / 100)
      }}
      onPointerUp={() => {
        interacting.current = false
        commit()
      }}
      onKeyUp={() => {
        interacting.current = false
        commit()
      }}
      onBlur={() => {
        interacting.current = false
        commit()
      }}
    />
  )
}

export function TrackControls({
  kind,
  trackId,
  name,
  state,
  height,
  suppressedBySolo = false,
  onRemove,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onOpenCover,
  volume,
  onVolumeChange,
}: TrackControlsProps) {
  const toggleTrackFlag = useEditorStore((store) => store.toggleTrackFlag)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const audioOnly = kind === 'audio'
  const textOnly = kind === 'text'
  // 叠加轨现在也带声音（参与预览混音与导出 amix），只有文本轨没有独立音频。
  const noAudio = textOnly
  const toggle = (flag: TrackFlag) => toggleTrackFlag(kind, trackId, flag)
  // 叠加轨 / 音频轨 / 文字轨都可以调整顺序（主轨固定不动）。
  const reorderable = kind !== 'main' && Boolean(onMoveUp && onMoveDown)

  return (
    <div
      className={`track-controls-row${reorderable ? ' is-reorderable' : ''}`}
      style={{ height }}
      onKeyDown={(event) => {
        if (!event.altKey) return
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        if (!onMoveUp || !onMoveDown) return
        event.preventDefault()
        if (event.key === 'ArrowUp') onMoveUp()
        else onMoveDown()
      }}
      onContextMenu={
        reorderable
          ? (event) => {
              event.preventDefault()
              event.stopPropagation()
              setMenu({ x: event.clientX, y: event.clientY })
            }
          : undefined
      }
    >
      <div className="track-controls-main">
        <span className="track-controls-name" title={name}>
          {name}
        </span>
        {audioOnly && onVolumeChange && (
          <TrackVolume
            value={volume ?? 1}
            ariaLabel={`${name}音量`}
            onChange={onVolumeChange}
          />
        )}
      </div>
      <div className="track-controls-buttons" role="group" aria-label={`${name}控制`}>
        {reorderable && (
          <span className="track-move-stack" role="group" aria-label={`${name}层级`}>
            {/* 原先这里有个「拖动调整顺序」握把，但 TrackGutter 从未传 onDragStart，
                按下去只有按下态、没有任何效果 —— 容易让人以为编辑器卡住了。
                真正的排序入口是下面的 ↑/↓（也支持 Alt+↑/↓），这里不再放死控件。 */}
            <button
              type="button"
              className="track-control track-move"
              aria-label={`${name}上移一层`}
              title={canMoveUp ? '上移一层（更靠上层）' : '已是最上层'}
              disabled={!canMoveUp}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onMoveUp}
            >
              <Icon name="chevron" size={10} className="track-move-icon is-up" />
            </button>
            <button
              type="button"
              className="track-control track-move"
              aria-label={`${name}下移一层`}
              title={canMoveDown ? '下移一层（更靠下层）' : '已是最下层'}
              disabled={!canMoveDown}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onMoveDown}
            >
              <Icon name="chevron" size={10} className="track-move-icon is-down" />
            </button>
          </span>
        )}
        {onOpenCover && (
          <button
            type="button"
            className="track-control"
            aria-label="封面设置"
            title="封面：截取当前帧 / 上传图片 / 导出方式"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onOpenCover}
          >
            <Icon name="camera" size={12} />
          </button>
        )}
        <button
          type="button"
          className={`track-control${state.enabled ? '' : ' is-off'}`}
          aria-label={state.enabled ? '停用轨道' : '启用轨道'}
          aria-pressed={state.enabled}
          title={`启用开关：${titles.enabled}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => toggle('enabled')}
        >
          <Icon name="power" size={12} />
        </button>
        <button
          type="button"
          className={`track-control${state.locked ? ' is-locked' : ''}`}
          aria-label={state.locked ? '解锁轨道' : '锁定轨道'}
          aria-pressed={state.locked}
          title={`锁定：${titles.locked}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => toggle('locked')}
        >
          <Icon name="lock" size={12} />
        </button>
        <button
          type="button"
          className={`track-control${state.hidden ? ' is-off' : ''}`}
          aria-label={audioOnly ? '音频轨没有画面' : state.hidden ? '显示画面' : '隐藏画面'}
          aria-pressed={audioOnly ? undefined : !state.hidden}
          title={audioOnly ? '音频轨没有画面，眼睛不可用' : `显示：${titles.hidden}`}
          disabled={audioOnly}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => toggle('hidden')}
        >
          <Icon name={state.hidden ? 'eyeOff' : 'eye'} size={12} />
        </button>
        <button
          type="button"
          className={`track-control${state.muted ? ' is-off' : ''}${
            suppressedBySolo ? ' is-suppressed' : ''
          }`}
          aria-label={textOnly ? '该轨道暂无独立音频' : state.muted ? '取消静音' : '静音'}
          aria-pressed={noAudio ? undefined : !state.muted}
          title={
            noAudio
              ? '该轨道暂无独立音频，静音不可用'
              : suppressedBySolo
                ? '其他轨道正在独奏，本轨被自动静音'
                : `静音：${titles.muted}`
          }
          disabled={noAudio}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => toggle('muted')}
        >
          <Icon name={state.muted ? 'volumeOff' : 'volume'} size={12} />
        </button>
        <button
          type="button"
          className={`track-control track-solo${state.solo ? ' is-on' : ''}`}
          aria-label={textOnly ? '该轨道暂无独立音频' : state.solo ? '关闭独奏' : '独奏'}
          aria-pressed={noAudio ? undefined : state.solo}
          title={noAudio ? '该轨道暂无独立音频，独奏不可用' : `独奏 S：${titles.solo}`}
          disabled={noAudio}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => toggle('solo')}
        >
          S
        </button>
        {onRemove && (
          <button
            type="button"
            className="track-remove"
            aria-label={`删除${name}`}
            title="删除整条轨道（可撤销；锁定状态也可删除轨道）"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onRemove}
          >
            <Icon name="close" size={11} />
          </button>
        )}
      </div>
      {menu && reorderable && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          ariaLabel={`${name}层级`}
          onClose={() => setMenu(null)}
          items={[
            {
              label: '上移一层',
              disabled: !canMoveUp,
              reason: '已是最上层',
              onSelect: () => onMoveUp?.(),
            },
            {
              label: '下移一层',
              disabled: !canMoveDown,
              reason: '已是最下层',
              onSelect: () => onMoveDown?.(),
            },
          ]}
        />
      )}
    </div>
  )
}