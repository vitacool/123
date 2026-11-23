import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_PROJECT_NAME,
  formatProjectUpdatedAt,
  normalizeProjectName,
  PROJECT_LIMIT,
  type DraftProjectRecord,
} from '../core/projectLibrary'
import { Icon } from './Icon'

export interface ProjectLibraryProps {
  records: DraftProjectRecord[]
  loading: boolean
  /** 打开某个项目。 */
  onOpen: (record: DraftProjectRecord) => void
  /** 删除某个项目（二次确认由调用方负责）。 */
  onDelete: (record: DraftProjectRecord) => void
  /** 重命名某个项目。 */
  onRename: (record: DraftProjectRecord, name: string) => void
  /** 新建空项目。 */
  onCreate: () => void
  /** 直接导入素材（等同于空状态里的「导入视频」）。 */
  onImport: () => void
  /** 关闭面板回到编辑器（当前已有一个打开的项目时才显示关闭按钮）。 */
  onDismiss?: () => void
  /**
   * 是否已达项目数量上限。
   *
   * 到达上限后「新建项目」不会成功（保存会被拒，用户剪的东西刷新就丢），
   * 所以这里直接把入口拦住并说明原因，而不是等用户点进去剪完才发现。
   */
  limitReached?: boolean
}

/**
 * 「最近项目」列表：空状态（还没加载素材）时的入口。
 *
 * 只负责展示与交互，数据读写全部由宿主（VideoEditor）通过回调完成，
 * 这样项目状态（当前 id / 名字）始终只在一个地方维护。
 */
export function ProjectLibrary({
  records,
  loading,
  onOpen,
  onDelete,
  onRename,
  onCreate,
  onImport,
  onDismiss,
  limitReached = false,
}: ProjectLibraryProps) {
  /** 正在重命名的项目 id 与草稿值。 */
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing?.id])

  const commitRename = (record: DraftProjectRecord) => {
    if (!editing || editing.id !== record.id) return
    const next = normalizeProjectName(editing.value)
    setEditing(null)
    if (next !== record.name) onRename(record, next)
  }

  return (
    <section className="project-library" aria-label="最近项目">
      <div className="project-library-card" role="dialog" aria-modal="false">
        <header className="project-library-head">
          <div>
            <p className="panel-eyebrow">PROJECTS · 本地草稿</p>
            <h2>最近项目</h2>
            <p className="project-library-sub">
              草稿保存在这台电脑的浏览器里（IndexedDB），最多 {PROJECT_LIMIT} 个。
            </p>
          </div>
          {onDismiss && (
            <button
              type="button"
              className="icon-button"
              aria-label="关闭项目列表"
              title="关闭项目列表"
              onClick={onDismiss}
            >
              <Icon name="close" size={16} />
            </button>
          )}
        </header>

        <div className="project-library-actions">
          <button
            type="button"
            className="button primary"
            onClick={onCreate}
            disabled={limitReached}
            title={
              limitReached
                ? `已有 ${PROJECT_LIMIT} 个项目（上限）：先在下面删掉一个旧项目，再新建`
                : '新建一个空项目'
            }
          >
            <Icon name="plus" size={15} />
            新建项目
          </button>
          <button type="button" className="button ghost" onClick={onImport}>
            <Icon name="upload" size={15} />
            导入视频
          </button>
        </div>

        {limitReached && (
          <p className="project-library-limit" role="status">
            已达上限（{PROJECT_LIMIT} 个，当前 {records.length} 个）：新建的项目
            <strong>不会被保存</strong>，请先删除一个旧项目。
          </p>
        )}

        {loading && records.length === 0 ? (
          <p className="project-library-empty">正在读取本地草稿…</p>
        ) : records.length === 0 ? (
          <div className="project-library-empty">
            <span className="project-library-empty-icon">
              <Icon name="film" size={20} />
            </span>
            <strong>还没有项目</strong>
            <span>新建一个项目，或直接导入视频开始剪辑。</span>
          </div>
        ) : (
          <ul className="project-library-list">
            {records.map((record) => {
              const isEditing = editing?.id === record.id
              return (
                <li
                  key={record.id}
                  className={`project-card${isEditing ? ' is-editing' : ''}`}
                  data-project-id={record.id}
                >
                  <button
                    type="button"
                    className="project-card-thumb"
                    onClick={() => onOpen(record)}
                    title={`打开「${record.name}」`}
                    aria-label={`打开「${record.name}」`}
                  >
                    {record.thumbnail ? (
                      <img src={record.thumbnail} alt="" />
                    ) : (
                      <Icon name="film" size={18} />
                    )}
                  </button>
                  <div className="project-card-copy">
                    {isEditing ? (
                      <input
                        ref={inputRef}
                        className="project-card-input"
                        value={editing!.value}
                        maxLength={64}
                        aria-label="项目名"
                        onChange={(event) =>
                          setEditing({ id: record.id, value: event.target.value })
                        }
                        onKeyDown={(event) => {
                          event.stopPropagation()
                          if (event.key === 'Enter') commitRename(record)
                          if (event.key === 'Escape') setEditing(null)
                        }}
                        onBlur={() => commitRename(record)}
                      />
                    ) : (
                      <button
                        type="button"
                        className="project-card-name"
                        onClick={() => onOpen(record)}
                        title={`打开「${record.name}」`}
                      >
                        {record.name || DEFAULT_PROJECT_NAME}
                      </button>
                    )}
                    <small>{formatProjectUpdatedAt(record.updatedAt)}</small>
                  </div>
                  <span className="project-card-tools">
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`重命名「${record.name}」`}
                      title="重命名"
                      onClick={() => setEditing({ id: record.id, value: record.name })}
                    >
                      <Icon name="text" size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-button project-card-delete"
                      aria-label={`删除「${record.name}」`}
                      title="删除项目（不可恢复）"
                      onClick={() => onDelete(record)}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}