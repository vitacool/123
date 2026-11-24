import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ASSET_KIND_LABELS,
  ASSET_SORT_OPTIONS,
  ASSET_USAGE_OPTIONS,
  assetKindOf,
  countAssetKinds,
  countAssetReferences,
  matchesAssetName,
  filterAssetsByUsage,
  filterAssetsByFolder,
  listAssetFolders,
  reversedDependents,
  sortAssets,
  unusedAssets,
  type AssetKind,
  type AssetSortMode,
  type AssetUsageFilter,
} from '../core/assets'
import { formatPlayhead } from '../core/format'
import type { MediaAsset } from '../core/types'
import { regenerateThumbnail } from '../services/assetReader'
import { useEditorStore, useEditorStoreApi } from '../store/EditorProvider'
import { ContextMenu } from './ContextMenu'
import { Icon } from './Icon'
import { isEditorShortcut } from './keyboardScope'

interface MediaLibraryProps {
  onImport: () => void
}

export const MEDIA_DRAG_TYPE = 'application/x-framecut-asset'

interface PendingDelete {
  asset: MediaAsset
  count: number
  /** 由该素材倒放出来、仍依赖它的倒放素材数量（删除后无法恢复正放）。 */
  reversedDependents: number
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

export function MediaLibrary({ onImport }: MediaLibraryProps) {
  const assets = useEditorStore((state) => state.assets)
  const project = useEditorStore((state) => state.project)
  const store = useEditorStoreApi()
  const addAssetToTimeline = useEditorStore((state) => state.addAssetToTimeline)
  const removeAsset = useEditorStore((state) => state.removeAsset)
  const updateAssetThumbnail = useEditorStore((state) => state.updateAssetThumbnail)
  const renameAsset = useEditorStore((state) => state.renameAsset)
  const setAssetFolder = useEditorStore((state) => state.setAssetFolder)
  const notify = useEditorStore((state) => state.notify)
  const cleanupUnusedAssets = useEditorStore((state) => state.cleanupUnusedAssets)

  const counts = useMemo(() => countAssetKinds(assets), [assets])
  const [activeKind, setActiveKind] = useState<AssetKind>('video')
  const [query, setQuery] = useState('')
  const [sortMode, setSortMode] = useState<AssetSortMode>('added')
  const [usageFilter, setUsageFilter] = useState<AssetUsageFilter>('all')
  /** null = 全部文件夹；'' = 未分类；其余为文件夹名。 */
  const [folderFilter, setFolderFilter] = useState<string | null>(null)
  const [folderEditId, setFolderEditId] = useState<string | null>(null)
  const [folderDraft, setFolderDraft] = useState('')
  const [pending, setPending] = useState<PendingDelete | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; asset: MediaAsset } | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
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
      if (event.key !== '/') return
      // 统一守卫：必须在编辑器根节点内、且不是输入控件、且不带组合键。
      // 原来只判断了输入控件，嵌入宿主后会在宿主的任意位置抢走 "/"。
      if (!isEditorShortcut(event)) return
      event.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const visible = searching
    ? assets.filter((asset) => matchesAssetName(asset, keyword))
    : assets.filter((asset) => assetKindOf(asset) === activeKind)
  const sortedVisible = sortAssets(
    filterAssetsByUsage(
      filterAssetsByFolder(visible, folderFilter),
      project,
      usageFilter,
      assets,
    ),
    sortMode,
  )
  const filtering = usageFilter !== 'all' || folderFilter !== null

  const unused = unusedAssets(project, assets)

  /** 重新生成素材缩略图（导入截帧失败或草稿恢复后丢失时用）。 */
  const regenerateAssetThumbnail = async (asset: MediaAsset) => {
    const thumbnail = await regenerateThumbnail(asset)
    if (!thumbnail) {
      notify('缩略图生成失败（素材可能已失效或无法解码）', 'warning')
      return
    }
    updateAssetThumbnail(asset.id, thumbnail)
    notify('已重新生成缩略图', 'success')
  }

  /** 提交素材重命名（空名/未改名时静默取消）。 */
  const commitAssetRename = (asset: MediaAsset) => {
    const name = renameDraft.trim()
    if (name && name !== asset.name) renameAsset(asset.id, name)
    setRenamingId(null)
  }

  /** 提交素材文件夹（留空 = 移出文件夹）。 */
  const commitAssetFolder = (asset: MediaAsset) => {
    setAssetFolder(asset.id, folderDraft)
    setFolderEditId(null)
  }

  const requestDelete = (asset: MediaAsset) => {
    const count = countAssetReferences(project, asset)
    const dependents = reversedDependents(assets, asset).filter((item) => item.id !== asset.id)
    // 没有任何片段引用、也没有倒放素材依赖它 → 直接移除，不打扰。
    if (count === 0 && dependents.length === 0) {
      removeAsset(asset.id, { removeClips: false })
      return
    }
    setPending({ asset, count, reversedDependents: dependents.length })
  }

  const clearSearch = () => {
    setQuery('')
    searchRef.current?.focus()
  }

  const clearFilters = () => {
    setUsageFilter('all')
    setFolderFilter(null)
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
              ? `点击添加到音频轨（没有时自动新建）；也可拖到某条音频轨\n${asset.name}`
              : `同一素材接在主轨末尾，其他素材自动新建叠加轨；也可拖到指定轨道\n${asset.name}`
          }
          onClick={() =>
            addAssetToTimeline(asset.id, {
              kind: 'auto',
              // 事件里读最新播放头：本组件不再订阅 playhead（播放时零重渲染）。
              time: store.getState().playhead,
            })
          }
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
              {asset.folder ? `${asset.folder} · ` : ''}
              {audio ? '音频' : `${asset.width}×${asset.height}`}
              {references > 0 ? ` · 引用 ${references}` : ' · 未使用'}
            </small>
          </span>
        </button>
        {renamingId === asset.id && (
          <input
            className="media-card-rename"
            value={renameDraft}
            autoFocus
            maxLength={200}
            aria-label={`重命名素材 ${asset.name}`}
            onChange={(event) => setRenameDraft(event.target.value)}
            onBlur={() => commitAssetRename(asset)}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Enter') {
                event.preventDefault()
                commitAssetRename(asset)
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setRenamingId(null)
              }
            }}
          />
        )}
        {folderEditId === asset.id && (
          <input
            className="media-card-rename"
            value={folderDraft}
            autoFocus
            maxLength={40}
            placeholder="文件夹名（留空=未分类）"
            aria-label={`设置素材文件夹 ${asset.name}`}
            onChange={(event) => setFolderDraft(event.target.value)}
            onBlur={() => commitAssetFolder(asset)}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Enter') {
                event.preventDefault()
                commitAssetFolder(asset)
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setFolderEditId(null)
              }
            }}
          />
        )}
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

      <div className="media-sort">
        <span>排序</span>
        <select
          value={sortMode}
          aria-label="素材排序"
          onChange={(event) => setSortMode(event.target.value as AssetSortMode)}
        >
          {ASSET_SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span>使用</span>
        <select
          value={usageFilter}
          aria-label="素材使用情况筛选"
          onChange={(event) => setUsageFilter(event.target.value as AssetUsageFilter)}
        >
          {ASSET_USAGE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span>文件夹</span>
        <select
          value={folderFilter ?? '*'}
          aria-label="素材文件夹筛选"
          onChange={(event) =>
            setFolderFilter(event.target.value === '*' ? null : event.target.value)
          }
        >
          <option value="*">全部</option>
          <option value="">未分类</option>
          {listAssetFolders(assets).map((folder) => (
            <option key={folder} value={folder}>
              {folder}
            </option>
          ))}
        </select>
      </div>

      {searching && (
        <p className="media-search-status">
          搜索「{keyword}」· 找到 {sortedVisible.length} 个素材
          {filtering ? '（已筛选）' : '（全部分类）'}
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

        {assets.length > 0 && !searching && counts[activeKind] === 0 && (
          <div className="media-kind-empty">
            <p>该分类暂无素材</p>
            <small>点上方「导入素材」添加</small>
          </div>
        )}

        {assets.length > 0 && visible.length > 0 && sortedVisible.length === 0 && (
          <div className="media-search-empty">
            <p>当前筛选没有素材</p>
            <button
              type="button"
              className="button mini ghost-mini"
              onClick={clearFilters}
            >
              清除筛选
            </button>
          </div>
        )}

        {sortedVisible.map(renderCard)}
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
              label: '重命名素材',
              onSelect: () => {
                setRenamingId(menu.asset.id)
                setRenameDraft(menu.asset.name)
                setFolderEditId(null)
              },
            },
            {
              label: '移动到文件夹…',
              onSelect: () => {
                setFolderEditId(menu.asset.id)
                setFolderDraft(menu.asset.folder ?? '')
                setRenamingId(null)
              },
            },
            ...(menu.asset.kind === 'audio'
              ? []
              : [
                  {
                    label: '重新生成缩略图',
                    onSelect: () => void regenerateAssetThumbnail(menu.asset),
                  },
                ]),
            { label: '删除素材', danger: true, onSelect: () => requestDelete(menu.asset) },
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
            <p id="media-confirm-desc">
              {pending.count > 0 ? `该素材被 ${pending.count} 个片段引用` : '该素材没有被片段引用'}
            </p>
            {pending.reversedDependents > 0 && (
              <p className="media-confirm-hint media-confirm-warning">
                有 {pending.reversedDependents} 个倒放素材来自该素材：删除后将无法把那些片段恢复正放。
              </p>
            )}
            <p className="media-confirm-hint">
              「仅从素材库移除」会保留时间轴片段，但显示为「素材已移除」；刷新后仍然保留，
              可用属性面板里的「重新链接素材」选回同一个文件恢复。
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