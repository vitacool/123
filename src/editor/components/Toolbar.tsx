import { getProjectEnd, getActionAvailability, findClipLocation } from '../core/timeline'
import { clipTimelineDuration } from '../core/clipTime'
import { findAudioClipLocation, getAudioActionAvailability } from '../core/audio'
import { findTextClipLocation, getTextActionAvailability } from '../core/text'
import { isAudioLocked, isTextLocked } from '../core/tracks'
import { useEditorStore } from '../store/EditorProvider'
import { Icon, type IconName } from './Icon'

interface ToolProps {
  icon: IconName
  label: string
  tooltip: string
  shortcut?: string
  disabled?: boolean
  active?: boolean
  onClick: () => void
}

function Tool({ icon, label, tooltip, shortcut, disabled, active, onClick }: ToolProps) {
  return (
    <button
      type="button"
      className={`tool-button${active ? ' is-active' : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={shortcut ? `${tooltip}（${shortcut}）` : tooltip}
      aria-pressed={active === undefined ? undefined : active}
      title={shortcut ? `${tooltip} · ${shortcut}` : tooltip}
    >
      <Icon name={icon} size={18} />
      <span className="tool-label">{label}</span>
      <span className="tool-tooltip" role="tooltip">
        {tooltip}
        {shortcut && <kbd>{shortcut}</kbd>}
      </span>
    </button>
  )
}

export function Toolbar() {
  const project = useEditorStore((state) => state.project)
  const selectedClipId = useEditorStore((state) => state.selectedClipId)
  const playhead = useEditorStore((state) => state.playhead)
  const cropSession = useEditorStore((state) => state.cropSession)
  const splitAtPlayhead = useEditorStore((state) => state.splitAtPlayhead)
  const trimLeftAtPlayhead = useEditorStore((state) => state.trimLeftAtPlayhead)
  const trimRightAtPlayhead = useEditorStore((state) => state.trimRightAtPlayhead)
  const canUndo = useEditorStore((state) => state.canUndo)
  const canRedo = useEditorStore((state) => state.canRedo)
  const undo = useEditorStore((state) => state.undo)
  const redo = useEditorStore((state) => state.redo)
  const rotateSelected = useEditorStore((state) => state.rotateSelected)
  const insertFreeze = useEditorStore((state) => state.insertFreeze)
  const beginCrop = useEditorStore((state) => state.beginCrop)
  const toggleFlipH = useEditorStore((state) => state.toggleFlipH)
  const toggleFlipV = useEditorStore((state) => state.toggleFlipV)
  const addMarker = useEditorStore((state) => state.addMarker)
  const deleteSelectedClip = useEditorStore((state) => state.deleteSelectedClip)

  const segment = findClipLocation(project, selectedClipId)
  const availability = getActionAvailability(project, selectedClipId, playhead)
  const hasSelection = availability.hasSelection
  const audioLocation = findAudioClipLocation(project, selectedClipId)
  const audioSelected = Boolean(audioLocation && !isAudioLocked(audioLocation.track))
  const textLocation = findTextClipLocation(project, selectedClipId)
  const textSelected = Boolean(textLocation && !isTextLocked(textLocation.track))
  const textAvailability = getTextActionAvailability(project, selectedClipId, playhead)
  const audioAvailability = getAudioActionAvailability(project, selectedClipId, playhead)
  const total = getProjectEnd(project)
  const clip = segment?.clip ?? null
  const cropActive = Boolean(cropSession)

  // 工具栏最左的状态提示：无选中时引导操作，有选中时显示类型与时长。
  const selectionHint = (() => {
    if (cropActive) return '正在裁剪画面'
    if (segment) {
      const kind =
        segment.clip.type === 'freeze' ? '定格' : segment.clip.type === 'image' ? '图片' : '视频'
      return `${kind} ·${segment.segment.duration.toFixed(1)}s`
    }
    if (audioLocation) {
      return `音频 ·${clipTimelineDuration(audioLocation.clip).toFixed(1)}s`
    }
    if (textLocation) {
      return `字幕 ·${(textLocation.clip.end - textLocation.clip.start).toFixed(1)}s`
    }
    return '先在时间轴选一个片段'
  })()
  const hintIsEmpty = !segment && !audioLocation && !textLocation && !cropActive

  return (
    <div className="toolbar" role="toolbar" aria-label="编辑工具">
      <p
        className={`toolbar-hint${hintIsEmpty ? ' is-empty' : ''}`}
        aria-live="polite"
      >
        {selectionHint}
      </p>
      <div className="toolbar-group">
        <Tool
          icon="split"
          label="分割"
          tooltip="在播放头处分割片段"
          shortcut="Ctrl/⌘ B"
          disabled={cropActive || (audioSelected ? !audioAvailability.canSplit : textSelected ? !textAvailability.canSplit : !availability.canSplit)}
          onClick={splitAtPlayhead}
        />
        <Tool
          icon="trimLeft"
          label="左裁"
          tooltip="裁掉播放头左侧，保留可拖回的空隙"
          shortcut="Q"
          disabled={cropActive || (audioSelected ? !audioAvailability.canTrimLeft : textSelected ? !textAvailability.canTrimLeft : !availability.canTrimLeft)}
          onClick={trimLeftAtPlayhead}
        />
        <Tool
          icon="trimRight"
          label="右裁"
          tooltip="裁掉播放头右侧，保留可拖回的空隙"
          shortcut="W"
          disabled={cropActive || (audioSelected ? !audioAvailability.canTrimRight : textSelected ? !textAvailability.canTrimRight : !availability.canTrimRight)}
          onClick={trimRightAtPlayhead}
        />
      </div>

      <span className="toolbar-separator" />

      <div className="toolbar-group">
        <Tool
          icon="undo"
          label="撤销"
          tooltip="撤销上一步"
          shortcut="Ctrl+Z"
          disabled={!canUndo || cropActive}
          onClick={undo}
        />
        <Tool
          icon="redo"
          label="重做"
          tooltip="重做（恢复上一次撤销）"
          shortcut="Shift+Ctrl+Z"
          disabled={!canRedo || cropActive}
          onClick={redo}
        />
      </div>

      <span className="toolbar-separator" />

      <div className="toolbar-group">
        <Tool
          icon="rotateLeft"
          label="逆时针"
          tooltip="逆时针旋转 90°"
          disabled={!hasSelection || cropActive}
          onClick={() => rotateSelected(-90)}
        />
        <Tool
          icon="rotateRight"
          label="顺时针"
          tooltip="顺时针旋转 90°"
          disabled={!hasSelection || cropActive}
          onClick={() => rotateSelected(90)}
        />
      </div>

      <span className="toolbar-separator" />

      <div className="toolbar-group">
        <Tool
          icon="freeze"
          label="定格"
          tooltip="截取当前帧并插入 3 秒定格"
          disabled={!availability.canFreeze || cropActive}
          onClick={insertFreeze}
        />
        <Tool
          icon="crop"
          label="裁剪"
          tooltip="拖拽选择画面保留区域（主轨与叠加轨均支持）"
          active={cropActive}
          disabled={!hasSelection || cropActive}
          onClick={beginCrop}
        />
      </div>

      <span className="toolbar-separator" />

      <div className="toolbar-group">
        <Tool
          icon="flipH"
          label="水平镜像"
          tooltip="水平镜像画面"
          active={clip?.flipH}
          disabled={!hasSelection || cropActive}
          onClick={toggleFlipH}
        />
        <Tool
          icon="flipV"
          label="垂直镜像"
          tooltip="垂直镜像画面"
          active={clip?.flipV}
          disabled={!hasSelection || cropActive}
          onClick={toggleFlipV}
        />
      </div>

      <span className="toolbar-separator" />

      <div className="toolbar-group">
        <Tool
          icon="marker"
          label="标记"
          tooltip="在播放头处添加标记"
          shortcut="M"
          disabled={total <= 0 || cropActive}
          onClick={addMarker}
        />
        <Tool
          icon="trash"
          label="删除"
          tooltip="删除选中的片段"
          shortcut="Delete"
          disabled={!(hasSelection || audioSelected || textSelected) || cropActive}
          onClick={deleteSelectedClip}
        />
      </div>

      <div className="toolbar-end">
        <span className="toolbar-tip">
          <kbd>Space</kbd> 播放 / 暂停
        </span>
      </div>
    </div>
  )
}