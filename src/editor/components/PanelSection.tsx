import { useId, type ReactNode } from 'react'
import { Icon } from './Icon'

interface PanelSectionProps {
  title: string
  hint?: ReactNode
  collapsed: boolean
  onToggle: () => void
  onReset?: () => void
  resetDisabled?: boolean
  tone?: 'default' | 'danger' | 'accent'
  children: ReactNode
}

/**
 * 属性面板里每个分组的外壳：可折叠标题 + 「恢复默认值」按钮。
 * 折叠状态由父级受控（切换 tab、切换片段后仍保持各自记忆）。
 */
export function PanelSection({
  title,
  hint,
  collapsed,
  onToggle,
  onReset,
  resetDisabled,
  tone = 'default',
  children,
}: PanelSectionProps) {
  const bodyId = useId()
  const toneClass =
    tone === 'danger' ? ' panel-danger' : tone === 'accent' ? ' accent-section' : ''
  return (
    <section className={`panel-section${toneClass}`}>
      <div className="section-title">
        <button
          type="button"
          className="section-toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <span className={`section-chevron${collapsed ? '' : ' is-open'}`} aria-hidden="true">
            <Icon name="chevron" size={12} />
          </span>
          <span>{title}</span>
        </button>
        <span className="section-title-end">
          {hint !== undefined && <span className="section-hint">{hint}</span>}
          {onReset && (
            <button
              type="button"
              className="icon-button section-reset"
              title={`重置${title}`}
              aria-label={`重置${title}`}
              disabled={resetDisabled}
              onClick={onReset}
            >
              <Icon name="reset" size={13} />
            </button>
          )}
        </span>
      </div>
      {!collapsed && <div id={bodyId}>{children}</div>}
    </section>
  )
}