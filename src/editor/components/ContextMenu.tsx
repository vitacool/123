import { useEffect } from 'react'
import { useFloatingPosition } from './floating'

export interface ContextMenuItem {
  label: string
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  /** disabled 时在右侧用小字说明原因（如「播放头不在片段内」）。 */
  reason?: string
  /** 在这一项上方画一条分隔线（用于分组）。 */
  separator?: boolean
  onSelect: () => void
}

export interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  /** 请求关闭（点空白 / Esc / 滚动 / 窗口变化 / 选中某项后由宿主收起）。 */
  onClose: () => void
  ariaLabel?: string
}

/**
 * 受控的右键菜单浮层：只负责定位、翻转避让视口与关闭时机，
 * 具体菜单项与动作由宿主（Timeline）组装。
 */
export function ContextMenu({ x, y, items, onClose, ariaLabel = '片段操作' }: ContextMenuProps) {
  // 定位与「关键帧缓动/曲线」浮层共用同一套视口避让逻辑（components/floating.ts）。
  const floating = useFloatingPosition(x, y)
  const menuRef = floating.ref
  const pos = floating.style

  // 打开时把焦点交给菜单容器，Esc / 方向键立刻可用。
  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true })
  }, [])

  // 点空白处关闭：pointerdown 用捕获阶段，避免被内部元素的 stopPropagation 吞掉。
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      onClose()
    }
    window.addEventListener('pointerdown', handlePointerDown, true)
    return () => window.removeEventListener('pointerdown', handlePointerDown, true)
  }, [onClose])

  // Esc 关闭 + 上下键在可用项间移动。
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const buttons = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>(
          '.context-menu-item:not(:disabled)',
        ) ?? [],
      )
      if (buttons.length === 0) return
      event.preventDefault()
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next =
        current < 0
          ? event.key === 'ArrowDown'
            ? 0
            : buttons.length - 1
          : (current + step + buttons.length) % buttons.length
      buttons[next].focus({ preventScroll: true })
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [onClose])

  // 滚动（时间轴横向/纵向滚动都算）与窗口尺寸变化时关闭，避免菜单跟内容错位。
  useEffect(() => {
    const handleClose = () => onClose()
    window.addEventListener('scroll', handleClose, true)
    window.addEventListener('resize', handleClose)
    window.addEventListener('blur', handleClose)
    return () => {
      window.removeEventListener('scroll', handleClose, true)
      window.removeEventListener('resize', handleClose)
      window.removeEventListener('blur', handleClose)
    }
  }, [onClose])

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: pos.left, top: pos.top }}
      role="menu"
      aria-label={ariaLabel}
      tabIndex={-1}
      onContextMenu={(event) => {
        // 在菜单上再次右键不应弹出浏览器原生菜单
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      {items.map((item, index) => (
        <div key={`${item.label}-${index}`} className="context-menu-row">
          {item.separator && <span className="context-menu-sep" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className={`context-menu-item${item.danger ? ' is-danger' : ''}`}
            disabled={item.disabled}
            title={item.disabled ? item.reason : item.shortcut}
            onClick={() => {
              if (item.disabled) return
              onClose()
              item.onSelect()
            }}
          >
            <span className="context-menu-label">{item.label}</span>
            {item.disabled
              ? item.reason && <span className="context-menu-reason">{item.reason}</span>
              : item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
          </button>
        </div>
      ))}
    </div>
  )
}