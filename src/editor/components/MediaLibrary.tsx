import { useEffect, useRef, useState } from 'react'
import { countAssetReferences, unusedAssets } from '../core/assets'
import { formatPlayhead } from '../core/format'
import type { MediaAsset } from '../core/types'
import { useEditorStore } from '../store/EditorProvider'
import { ContextMenu } from './ContextMenu'
import { Icon } from './Icon'

interface MediaLibraryProps {
  onImport: () => void
  onNewProject: () => void
  onImportSubtitles: () => void
  onAutoCaption: () => void
  onCanvasBackground: () => void
}

export const MEDIA_DRAG_TYPE = 'application/x-framecut-asset'

interface PendingDelete {
  asset: MediaAsset
  count: number
}

export function MediaLibrary({
  onImport,
  onNewProject,
  onImportSubtitles,
  onAutoCaption,
  onCanvasBackground,
}: MediaLibraryProps) {
  const assets = useEditorStore((state) => state.assets)
  const project = useEditorStore((state) => state.project)
  const playhead = useEditorStore((state) => state.playhead)
  const addAssetToTimeline = useEditorStore((state) => state.addAssetToTimeline)
  const removeAsset = useEditorStore((state) => state.removeAsset)
  const cleanupUnusedAssets = useEditorStore((state) => state.cleanupUnusedAssets)

  const [pending, setPending] = useState<PendingDelete | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; asset: MediaAsset } | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)

  // 确认浮层打开后把焦点放到「取消」上：危险操作不做默认。
  useEffect(() => {
    if (pending) cancelRef.current?.focus()
  }, [pending])

  useEffect(() => {
    if (!pending) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setPending(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [pending])

  const unused = unusedAssets(project, assets)

  /** 删除入口：未被引用直接删，被引用则弹确认。 */
  const requestDelete = (asset: MediaAsset) => {
    const count = countAssetReferences(project, asset)
    if (count === 0) {
      removeAsset(asset.id, { removeClips: false })
      return
    }
    setPending({ asset, count })
  }

  return (
    <aside className="media-library" aria-label="素材库">
      <div className="media-library-head">
        <div>
          <span className="media-library-kicker">素材库</span>
          <span className="media-library-count">{assets.length} 个素材</span>
        </div>
        <button
          type="button"
          className="button mini ghost-mini media-cleanup"
          disabled={unused.length === 0}
          onClick={() => cleanupUnusedAssets()}
          title={
            unused.length === 0
              ? '没有被闲置的素材'
              : `删除 ${unused.length} 个未被任何片段使用的素材`
          }
        >
          <Icon name="trash" size={12} />
          清理未使用{unused.length > 0 ? `（${unused.length}）` : ''}
        </button>
      </div>
      <div className="media-library-actions">
        <button
          type="button"
          className="button mini media-action"
          onClick={onImport}
          title="导入本地视频或音频"
        >
          <Icon name="upload" size={13} />
          导入素材
        </button>
        <button
          type="button"
          className="button mini media-action"
          onClick={onAutoCaption}
          title="用本地 Whisper 识别主轨语音并生成字幕"
        >
          <Icon name="spark" size={13} />
          智能字幕
        </button>
        <button
          type="button"
          className="button mini media-action"
          onClick={onImportSubtitles}
          title="导入 SRT / VTT 字幕"
        >
          <Icon name="text" size={13} />
          导入字幕
        </button>
        <button
          type="button"
          className="button mini media-action"
          onClick={onCanvasBackground}
          title="设置画布背景（黑场 / 纯色 / 模糊填充 / 图片）"
        >
          <Icon name="fill" size={13} />
          背景
        </button>
        <button
          type="button"
          className="button mini media-action"
          onClick={onNewProject}
          title="清除草稿并新建项目"
        >
          <Icon name="plus" size={13} />
          新建项目
        </button>
      </div>

      <div className="media-library-list">
        {assets.length === 0 && (
          <button type="button" className="media-library-empty" onClick={onImport}>
            <span className="media-library-empty-icon">
              <Icon name="film" size={19} />
            </span>
            导入视频素材
            <small>点击或拖到时间轴</small>
          </button>
        )}
        {assets.map((asset) => {
          const audio = asset.kind === 'audio'
          const references = countAssetReferences(project, asset)
          return (
            // 外层不再是 button：卡片本体保持 <button>，右上角叠加独立的删除按钮。
            <div
              key={asset.id}
              className="media-card-wrap"
              onContextMenu={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setMenu({ x: event.clientX, y: event.clientY, asset })
              }}
            >
              <button
                type="button"
                className={`media-card${audio ? ' is-audio' : ''}`}
                draggable
                data-asset-id={asset.id}
                title={
                  audio
                    ? `点击添加到音频轨；拖到音频轨\n${asset.name}`
                    : `点击添加到播放头；拖到主轨或叠加轨\n${asset.name}`
                }
                onClick={() => addAssetToTimeline(asset.id, null, playhead)}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'copy'
                  event.dataTransfer.setData(MEDIA_DRAG_TYPE, asset.id)
                  event.dataTransfer.setData('text/plain', asset.name)
                }}
              >
                <span
                  className="media-card-thumb"
                  style={
                    !audio && asset.thumbnail
                      ? { backgroundImage: `url("${asset.thumbnail}")` }
                      : undefined
                  }
                >
                  {audio ? (
                    <Icon name="music" size={18} />
                  ) : (
                    !asset.thumbnail && <Icon name="film" size={18} />
                  )}
                  <span className="media-card-duration">
                    {formatPlayhead(asset.duration, 30)}
                  </span>
                </span>
                <span className="media-card-copy">
                  <strong>{asset.name}</strong>
                  <small>
                    {audio ? '音频' : `${asset.width}×${asset.height}`}
                    {references > 0 ? ` · 引用 ${references}` : ' · 未使用'}
                  </small>
                </span>
              </button>
              <button
                type="button"
                className="media-card-delete"
                aria-label={`删除素材 ${asset.name}`}
                title={
                  references > 0
                    ? `删除素材（被 ${references} 个片段引用）`
                    : '删除素材'
                }
                onClick={(event) => {
                  event.stopPropagation()
                  requestDelete(asset)
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          )
        })}
      </div>
      <p className="media-library-foot">点击添加到播放头 · 拖到任意轨道</p>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          ariaLabel="素材操作"
          onClose={() => setMenu(null)}
          items={[
            {
              label: '删除素材',
              danger: true,
              onSelect: () => requestDelete(menu.asset),
            },
          ]}
        />
      )}

      {pending && (
        <div
          className="media-confirm-backdrop"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setPending(null)
          }}
        >
          <div
            className="media-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-label="删除素材"
            aria-describedby="media-confirm-desc"
          >
            <h3>删除素材「{pending.asset.name}」</h3>
            <p id="media-confirm-desc">该素材被 {pending.count} 个片段引用</p>
            <p className="media-confirm-hint">
              「仅从素材库移除」会保留时间轴片段，但显示为「素材已移除」；缓存中的素材文件会被删除，
              撤销只恢复时间轴状态，需要重新导入文件。
            </p>
            <div className="media-confirm-actions">
              <button
                ref={cancelRef}
                type="button"
                className="button ghost"
                onClick={() => setPending(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="button ghost"
                onClick={() => {
                  removeAsset(pending.asset.id, { removeClips: false })
                  setPending(null)
                }}
              >
                仅从素材库移除（片段变空白）
              </button>
              <button
                type="button"
                className="button ghost is-danger"
                onClick={() => {
                  removeAsset(pending.asset.id, { removeClips: true })
                  setPending(null)
                }}
              >
                删除素材及关联片段
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}