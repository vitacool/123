import type { TrackFlag, TrackKind } from '../core/tracks'
import type { TrackState } from '../core/types'
import { useEditorStore } from '../store/EditorProvider'
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
}

const titles: Record<TrackFlag, string> = {
  enabled: '停用整轨画面与声音（不删除素材）',
  locked: '锁定轨道素材，禁止编辑；播放不受影响',
  hidden: '隐藏本轨画面；声音不受影响',
  muted: '静音本轨声音；画面不受影响',
  solo: '独奏本轨声音；其他未独奏轨道自动静音',
}

export function TrackControls({
  kind,
  trackId,
  name,
  state,
  height,
  suppressedBySolo = false,
  onRemove,
}: TrackControlsProps) {
  const toggleTrackFlag = useEditorStore((store) => store.toggleTrackFlag)
  const audioOnly = kind === 'audio'
  const textOnly = kind === 'text'
  // 叠加轨现在也带声音（参与预览混音与导出 amix），只有文本轨没有独立音频。
  const noAudio = textOnly
  const toggle = (flag: TrackFlag) => toggleTrackFlag(kind, trackId, flag)

  return (
    <div className="track-controls-row" style={{ height }}>
      <span className="track-controls-name" title={name}>
        {name}
      </span>
      <div className="track-controls-buttons" role="group" aria-label={`${name}控制`}>
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
    </div>
  )
}