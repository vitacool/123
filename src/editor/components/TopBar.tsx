import { ASPECT_PRESETS } from '../core/constants'
import { getProjectEnd } from '../core/timeline'
import { useEditorStore } from '../store/EditorProvider'
import { Icon } from './Icon'

interface TopBarProps {
  onCancel?: () => void
  /** 「工程」菜单：宿主回调拿到按钮的矩形，菜单由 EditorShell 在根节点渲染。 */
  onProjectMenu?: (anchor: { left: number; bottom: number }) => void
}

export function TopBar({ onCancel, onProjectMenu }: TopBarProps) {
  const project = useEditorStore((state) => state.project)
  const source = useEditorStore((state) => state.source)
  const setAspectRatio = useEditorStore((state) => state.setAspectRatio)
  const openExportDialog = useEditorStore((state) => state.openExportDialog)
  const cropSession = useEditorStore((state) => state.cropSession)
  const totalDuration = getProjectEnd(project)

  return (
    <header className="topbar">
      <div className="topbar-start">
        <button
          type="button"
          className="icon-button close-editor"
          aria-label="退出编辑器"
          title={onCancel ? '退出编辑器' : '宿主未提供取消回调'}
          disabled={!onCancel}
          onClick={onCancel}
        >
          <Icon name="close" size={17} />
        </button>
        <div className="brand" aria-label="帧刻 FrameCut">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className="brand-word">帧刻</span>
          <span className="brand-sub">FRAMECUT</span>
        </div>
        <span className="topbar-divider" />
        <span className="project-name" title={source?.name ?? '未命名项目'}>
          {source?.name ?? '未命名项目'}
        </span>
      </div>

      <div className="topbar-center">
        <label className={`ratio-control${!source ? ' is-disabled' : ''}`}>
          <span className="ratio-caption">画面比例</span>
          <span className="ratio-select">
            <select
              value={project.aspectRatio}
              disabled={!source}
              onChange={(event) =>
                setAspectRatio(event.target.value as (typeof ASPECT_PRESETS)[number]['id'])
              }
              aria-label="画面比例"
            >
              {ASPECT_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
            <Icon name="chevron" size={14} />
          </span>
        </label>
      </div>

      <div className="topbar-end">
        <span className="local-badge">
          <Icon name="spark" size={13} />
          本地处理
        </span>
        <button
          type="button"
          className="button ghost project-menu-button"
          aria-haspopup="menu"
          title="工程文件：导出 / 导入 .framecut.json"
          onClick={(event) => {
            if (!onProjectMenu) return
            const rect = event.currentTarget.getBoundingClientRect()
            onProjectMenu({ left: rect.left, bottom: rect.bottom })
          }}
        >
          <Icon name="note" size={16} />
          工程
        </button>
        <button
          type="button"
          className="button primary export-button"
          onClick={openExportDialog}
          disabled={totalDuration <= 0 || Boolean(cropSession)}
          title={totalDuration <= 0 ? '时间轴为空，无法导出' : '导出视频'}
        >
          <Icon name="export" size={17} />
          导出
        </button>
      </div>
    </header>
  )
}