import { useEffect, useRef } from 'react'
import { useEditorStore } from '../store/EditorProvider'
import { Icon } from './Icon'

/**
 * 封面设置浮层（小面板，不是完整弹窗）。
 * 入口：时间轴头部「封面」按钮 / 主轨轨道头图标 / 快捷键面板入口 / 时间轴封面块。
 * 关闭：完成按钮、Esc、点击空白处。
 */
export function CoverPanel() {
  const open = useEditorStore((state) => state.coverPanelOpen)
  const cover = useEditorStore((state) => state.project.cover)
  const playhead = useEditorStore((state) => state.playhead)
  const setCoverFromFrame = useEditorStore((state) => state.setCoverFromFrame)
  const setCoverFromImage = useEditorStore((state) => state.setCoverFromImage)
  const setCoverMode = useEditorStore((state) => state.setCoverMode)
  const clearCover = useEditorStore((state) => state.clearCover)
  const closeCoverPanel = useEditorStore((state) => state.closeCoverPanel)
  const fileRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeCoverPanel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, closeCoverPanel])

  if (!open) return null

  const source = cover?.source
  const sourceNote = !cover
    ? '还没有封面'
    : source?.kind === 'frame'
      ? `截取自画面 ${source.time.toFixed(2)}s`
      : source?.name
        ? `上传图片：${source.name}`
        : '上传图片'

  return (
    <>
      <div className="cover-popover-backdrop" role="presentation" onPointerDown={closeCoverPanel} />
      <div className="cover-popover" role="dialog" aria-label="封面设置" aria-modal="false">
        <div className="cover-popover-head">
          <h3>封面</h3>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭封面设置"
            title="关闭"
            onClick={closeCoverPanel}
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className="cover-popover-body">
          <div className="cover-preview">
            {cover ? (
              <img src={cover.dataUrl} alt="当前封面" />
            ) : (
              <div className="cover-preview-empty">
                暂无封面
                <br />
                可截取当前帧或上传图片
              </div>
            )}
          </div>

          <div className="cover-actions">
            <button
              type="button"
              className="button mini"
              onClick={() => setCoverFromFrame(playhead)}
              title={`用播放头 ${playhead.toFixed(2)}s 处的画面作为封面`}
            >
              <Icon name="camera" size={12} />
              截取当前帧
            </button>
            <button
              type="button"
              className="button mini"
              onClick={() => fileRef.current?.click()}
              title="上传 JPG / PNG / WebP 图片作为封面"
            >
              <Icon name="upload" size={12} />
              上传图片
            </button>

            <div className="cover-mode" role="radiogroup" aria-label="导出模式">
              <label>
                <input
                  type="radio"
                  name="cover-mode"
                  checked={(cover?.mode ?? 'separate') === 'separate'}
                  disabled={!cover}
                  onChange={() => setCoverMode('separate')}
                />
                单独封面图
              </label>
              <label>
                <input
                  type="radio"
                  name="cover-mode"
                  checked={cover?.mode === 'first-frame'}
                  disabled={!cover}
                  onChange={() => setCoverMode('first-frame')}
                />
                作为视频首帧
              </label>
            </div>

            <button
              type="button"
              className="button mini ghost-mini"
              disabled={!cover}
              onClick={() => clearCover()}
              title="移除封面（可撤销）"
            >
              <Icon name="trash" size={12} />
              移除封面
            </button>
          </div>
        </div>

        <div className="cover-popover-foot">
          <span className="cover-source-note">{sourceNote}</span>
          <button type="button" className="button" onClick={closeCoverPanel}>
            完成
          </button>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) setCoverFromImage(file)
          }}
        />
      </div>
    </>
  )
}