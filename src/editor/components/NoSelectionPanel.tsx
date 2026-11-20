import { useState } from 'react'
import { useEditorStore } from '../store/EditorProvider'
import { Icon, type IconName } from './Icon'

interface HintRow {
  icon: IconName
  title: string
  detail: string
}

const HINTS: HintRow[] = [
  { icon: 'mouse', title: '点击片段选中', detail: '单击只选中，不移动播放头' },
  { icon: 'trimLeft', title: '拖动边缘裁剪', detail: '左右边缘可裁掉或拉回素材' },
  { icon: 'film', title: '拖动片段换轨道', detail: '拖到叠加轨即可做成画中画' },
]

const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: 'Ctrl/⌘ + B', label: '在播放头处分割片段' },
  { keys: 'Q / W', label: '左裁 / 右裁（保留可恢复空隙）' },
  { keys: 'Delete', label: '删除选中片段' },
  { keys: 'Space', label: '播放 / 暂停' },
  { keys: '← / →', label: '逐帧后退 / 前进' },
  { keys: 'Shift + Z', label: '时间轴适应窗口' },
]

/**
 * 右栏未选中任何片段时的空态。
 * 它替代了原先「借用未选中态展示画布背景」的做法——背景入口已移到素材库，
 * 这样右栏宽度恒定（306px），不会因为选择与否让预览区来回跳。
 */
export function NoSelectionPanel() {
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const openCoverPanel = useEditorStore((state) => state.openCoverPanel)

  return (
    <aside className="properties-panel is-empty" aria-label="属性面板（未选中片段）">
      <div className="panel-head">
        <div>
          <p className="panel-eyebrow">属性</p>
          <h2>未选中片段</h2>
        </div>
      </div>

      <div className="panel-scroll">
        <div className="no-selection-card">
          <p className="no-selection-lead">
            选中时间线上的片段，在这里调整画面、音频和速度
          </p>

          <ul className="no-selection-hints">
            {HINTS.map((hint) => (
              <li key={hint.title}>
                <span className="no-selection-icon" aria-hidden="true">
                  <Icon name={hint.icon} size={14} />
                </span>
                <span className="no-selection-copy">
                  <strong>{hint.title}</strong>
                  <small>{hint.detail}</small>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <section className="panel-section">
          <button
            type="button"
            className="no-selection-shortcuts-toggle"
            aria-expanded={shortcutsOpen}
            onClick={() => setShortcutsOpen((open) => !open)}
          >
            <span>快捷键</span>
            <span className={`no-selection-chevron${shortcutsOpen ? ' is-open' : ''}`} aria-hidden="true">
              <Icon name="chevron" size={13} />
            </span>
          </button>
          {shortcutsOpen && (
            <ul className="no-selection-shortcuts">
              {SHORTCUTS.map((item) => (
                <li key={item.keys}>
                  <kbd>{item.keys}</kbd>
                  <span>{item.label}</span>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="button mini ghost-mini no-selection-cover"
            onClick={openCoverPanel}
            title="封面：截取当前帧 / 上传图片 / 选择导出方式"
          >
            <Icon name="camera" size={12} />
            封面设置
          </button>
        </section>
      </div>
    </aside>
  )
}