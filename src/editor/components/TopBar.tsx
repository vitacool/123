import { useEffect, useRef, useState } from 'react'
import { ASPECT_PRESETS } from '../core/constants'
import { DEFAULT_PROJECT_NAME, normalizeProjectName } from '../core/projectLibrary'
import { toggleTheme, type FrameCutTheme, type ResolvedTheme } from '../core/theme'
import { getProjectEnd } from '../core/timeline'
import { useEditorStore } from '../store/EditorProvider'
import { Icon } from './Icon'

interface TopBarProps {
  onCancel?: () => void
  /** 「工程」菜单：宿主回调拿到按钮的矩形，菜单由 EditorShell 在根节点渲染。 */
  onProjectMenu?: (anchor: { left: number; bottom: number }) => void
  /** 「导出当前帧」：把播放头所在画面存成 PNG（快捷键 Ctrl/⌘+Shift+S）。 */
  onCaptureFrame?: () => void
  /** 当前项目名（默认取主素材名）；传了才显示可编辑的项目名。 */
  projectName?: string
  /** 重命名当前项目。 */
  onRenameProject?: (name: string) => void
  /** 打开「最近项目」列表（仅本地多草稿模式）。 */
  onOpenProjects?: () => void
  /** 新建空项目（不清掉其它项目）。 */
  onNewProject?: () => void
  /** 当前实际生效的主题（system 已解析）。 */
  theme: ResolvedTheme
  /** 主题偏好（light / dark / system）。 */
  themePreference: FrameCutTheme
  /** 选择主题偏好。 */
  onSelectTheme: (theme: FrameCutTheme) => void
}

export function TopBar({
  onCancel,
  onProjectMenu,
  onCaptureFrame,
  projectName,
  onRenameProject,
  onOpenProjects,
  onNewProject,
  theme,
  themePreference,
  onSelectTheme,
}: TopBarProps) {
  const project = useEditorStore((state) => state.project)
  const source = useEditorStore((state) => state.source)
  const setAspectRatio = useEditorStore((state) => state.setAspectRatio)
  const openExportDialog = useEditorStore((state) => state.openExportDialog)
  const cropSession = useEditorStore((state) => state.cropSession)
  const totalDuration = getProjectEnd(project)
  /** 项目名内联编辑：draft 为 null 表示没在编辑。 */
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  // 未提供项目名时退回「主素材名」，保持旧版显示。
  const displayName = projectName ?? source?.name ?? DEFAULT_PROJECT_NAME
  const canRename = Boolean(onRenameProject)

  const commitName = () => {
    if (nameDraft === null) return
    const next = normalizeProjectName(nameDraft)
    setNameDraft(null)
    onRenameProject?.(next)
  }

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
        {nameDraft === null ? (
          <button
            type="button"
            className={`project-name${canRename ? ' is-editable' : ''}`}
            title={canRename ? `${displayName}（点击重命名）` : displayName}
            disabled={!canRename}
            onClick={() => {
              if (!canRename) return
              setNameDraft(displayName)
              // 等输入框挂载后再聚焦。
              window.setTimeout(() => nameInputRef.current?.select(), 0)
            }}
          >
            {displayName}
          </button>
        ) : (
          <input
            ref={nameInputRef}
            className="project-name-input"
            value={nameDraft}
            maxLength={64}
            autoFocus
            aria-label="项目名"
            onChange={(event) => setNameDraft(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Enter') commitName()
              if (event.key === 'Escape') setNameDraft(null)
            }}
          />
        )}
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
        <ThemeSwitch
          theme={theme}
          preference={themePreference}
          onSelect={onSelectTheme}
        />
        {onOpenProjects && (
          <button
            type="button"
            className="button ghost projects-button"
            onClick={onOpenProjects}
            title="打开最近项目列表"
          >
            <Icon name="film" size={16} />
            项目
          </button>
        )}
        {onNewProject && (
          <button
            type="button"
            className="button ghost new-project-button"
            onClick={onNewProject}
            title="新建空项目（不会删除其它项目）"
          >
            <Icon name="plus" size={16} />
            新建项目
          </button>
        )}
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
          className="button ghost frame-export-button"
          onClick={onCaptureFrame}
          disabled={!onCaptureFrame || totalDuration <= 0 || Boolean(cropSession)}
          aria-label="导出当前帧为 PNG"
          title={
            totalDuration <= 0
              ? '时间轴为空，无法导出画面'
              : '把播放头所在画面存成 PNG · Ctrl/⌘ Shift S'
          }
        >
          <Icon name="camera" size={16} />
          导出帧
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
/** 主题选项：按钮本体切 light/dark，下拉里可选「跟随系统」。 */
const THEME_CHOICES: { id: FrameCutTheme; label: string }[] = [
  { id: 'system', label: '跟随系统' },
  { id: 'light', label: '亮色' },
  { id: 'dark', label: '暗色' },
]

function ThemeSwitch({
  theme,
  preference,
  onSelect,
}: {
  theme: ResolvedTheme
  preference: FrameCutTheme
  onSelect: (theme: FrameCutTheme) => void
}) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement | null>(null)

  // 点空白 / Esc 关闭下拉。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (wrapperRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  const next = toggleTheme(theme)
  const toggleLabel =
    theme === 'dark' ? '当前为暗色主题，点击切换到亮色' : '当前为亮色主题，点击切换到暗色'
  const preferenceLabel =
    preference === 'system' ? '跟随系统' : preference === 'dark' ? '暗色' : '亮色'

  return (
    <div className="theme-switch" ref={wrapperRef}>
      <button
        type="button"
        className="icon-button theme-toggle"
        aria-label={toggleLabel}
        title={`${toggleLabel}（当前：${preferenceLabel}）`}
        onClick={() => onSelect(next)}
      >
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
      </button>
      <button
        type="button"
        className="theme-caret"
        aria-label="主题选项"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`主题：${preferenceLabel}（选择跟随系统 / 亮色 / 暗色）`}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="chevron" size={12} />
      </button>
      {open && (
        <div className="theme-menu" role="menu" aria-label="主题">
          {THEME_CHOICES.map((choice) => (
            <button
              key={choice.id}
              type="button"
              role="menuitemradio"
              aria-checked={preference === choice.id}
              className={`theme-menu-item${preference === choice.id ? ' is-active' : ''}`}
              onClick={() => {
                setOpen(false)
                onSelect(choice.id)
              }}
            >
              <span>{choice.label}</span>
              {preference === choice.id && <Icon name="check" size={13} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
