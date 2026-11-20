import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ASSET_KIND_LABELS,
  assetKindOf,
  countAssetKinds,
  countAssetReferences,
  matchesAssetName,
  unusedAssets,
  type AssetKind,
} from '../core/assets'
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

const KIND_TABS: readonly AssetKind[] = ['video', 'image', 'audio']

/** 把名称里命中搜索词的部分包成 <mark>（大小写不敏感，保留原大小写）。 */
function highlightName(name: string, query: string) {
  const keyword = query.trim()
  if (keyword.length === 0) return name
  const lowerName = name.toLowerCase()
  const lowerKeyword = keyword.toLowerCase()
  const at = lowerName.indexOf(lowerKeyword)
  if (at < 0) return name
  return (
    <>
      {name.slice(0, at)}
      <mark className="media-card-mark">{name.slice(at, at + keyword.length)}</mark>
      {name.slice(at + keyword.length)}
    </>
  )
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

  const counts = useMemo(() => countAssetKinds(assets), [assets])
  const [activeKind, setActiveKind] = useState<AssetKind>('video')
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<PendingDelete | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; asset: MediaAsset } | null>(null)
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  const keyword = query.trim()
  const searching = keyword.length > 0

  // 默认「视频」；若视频为空而其它分类非空，自动落到第一个非空分类。
  useEffect(() => {
    if (counts.video > 0) return
    const fallback = KIND_TABS.find((kind) => counts[kind] > 0)
    if (!fallback) return
    setActiveKind((current) => (counts[current] > 0 ? current : fallback))
  }, [counts])

  // 确认浮层焦点 / Esc
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

  // 全局 `/` 聚焦搜索框（不在输入框内时）。项目原本没有占用该键。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
      event.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const visible = searching
    ? assets.filter((asset) => matchesAssetName(asset, keyword))
    : assets.filter((asset) => assetKindOf(asset) === activeKind)

  const unused = unusedAssets(project, assets)

  const requestDelete = (asset: MediaAsset) => {
    const count = countAssetReferences(project, asset)
    if (count === 0) {
      removeAsset(asset.id, { removeClips: false })
      return
    }
    setPending({ asset, count })
  }

  const clearSearch = () => {
    setQuery('')
    searchRef.current?.focus()
  }

  const renderCard = (asset: MediaAsset) => {
    const kind = assetKindOf(asset)
    const audio = kind === 'audio'
    const references = countAssetReferences(project, asset)
    return (
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
          data-asset-kind={kind}
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
            {searching && (
              <span className={`media-kind-badge is-${kind}`}>{ASSET_KIND_LABELS[kind]}</span>
            )}
            <span className="media-card-duration">{formatPlayhead(asset.duration, 30)}</span>
          </span>
          <span className="media-card-copy">
            <strong>{highlightName(asset.name, keyword)}</strong>
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
          title={references > 0 ? `删除素材（被 ${references} 个片段引用）` : '删除素材'}
          onClick={(event) => {
            event.stopPropagation()
            requestDelete(asset)
          }}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
    )
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
          清理{unused.length > 0 ? `（${unused.length}）` : ''}
        </button>
      </div>

      <button type="button" className="button media-import" onClick={onImport} title="导入本地视频、图片或音频">
        <Icon name="upload" size={13} />
        导入素材
      </button>

      <button
        type="button"
        className="button mini media-more"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          setMoreMenu({ x: rect.left, y: rect.bottom + 4 })
        }}
        aria-haspopup="menu"
        title="智能字幕 / 导入字幕 / 背景 / 新建项目"
      >
        <Icon name="plus" size={12} />
        更多
      </button>

      <div
        className={`properties-tabs is-compact media-tabs${searching ? ' is-dimmed' : ''}`}
        role="tablist"
        aria-label="素材分类"
      >
        {KIND_TABS.map((kind) => (
          <button
            key={kind}
            type="button"
            role="tab"
            aria-selected={!searching && activeKind === kind}
            className={`properties-tab${!searching && activeKind === kind ? ' is-active' : ''}`}
            disabled={searching}
            title={searching ? '搜索中：结果跨全部分类' : `只看${ASSET_KIND_LABELS[kind]}`}
            onClick={() => setActiveKind(kind)}
          >
            {ASSET_KIND_LABELS[kind]} {counts[kind]}
          </button>
        ))}
      </div>

      <div className="media-search">
        <Icon name="zoom" size={12} />
        <input
          ref={searchRef}
          type="search"
          className="media-search-input"
          placeholder="搜索素材名"
          value={query}
          aria-label="搜索素材"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            if (query.length > 0) setQuery('')
            else event.currentTarget.blur()
          }}
        />
        {query.length > 0 && (
          <button
            type="button"
            className="media-search-clear"
            aria-label="清除搜索"
            title="清除搜索"
            onClick={clearSearch}
          >
            <Icon name="close" size={11} />
          </button>
        )}
      </div>

      {searching && (
        <p className="media-search-status">
          搜索「{keyword}」· 找到 {visible.length} 个素材（全部分类）
        </p>
      )}

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

        {assets.length > 0 && searching && visible.length === 0 && (
          <div className="media-search-empty">
            <p>没有找到包含「{keyword}」的素材</p>
            <button type="button" className="button mini ghost-mini" onClick={clearSearch}>
              清除搜索
            </button>
          </div>
        )}

        {assets.length > 0 && !searching && visible.length === 0 && (
          <div className="media-kind-empty">
            <p>该分类暂无素材</p>
            <small>点上方「导入素材」添加</small>
          </div>
        )}

        {visible.map(renderCard)}
      </div>

      <p className="media-library-foot">点击添加到播放头 · 拖到任意轨道</p>

      {moreMenu && (
        <ContextMenu
          x={moreMenu.x}
          y={moreMenu.y}
          ariaLabel="更多操作"
          onClose={() => setMoreMenu(null)}
          items={[
            { label: '智能字幕', onSelect: onAutoCaption },
            { label: '导入字幕', onSelect: onImportSubtitles },
            { label: '背景', onSelect: onCanvasBackground },
            { label: '新建项目', danger: true, onSelect: onNewProject },
          ]}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          ariaLabel="素材操作"
          onClose={() => setMenu(null)}
          items={[{ label: '删除素材', danger: true, onSelect: () => requestDelete(menu.asset) }]}
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
              <button ref={cancelRef} type="button" className="button ghost" onClick={() => setPending(null)}>
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