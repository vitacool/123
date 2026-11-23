import { Icon } from './Icon'
import { ASSET_KIND_LABELS } from '../core/assets'
import type { DraftAssetKind } from '../core/draft'

/**
 * 导入工程时的「缺失素材」对话框。
 *
 * 为什么不是一个接一个弹系统文件框：逐个 `input.click()` 依赖用户手势，读文件/转码
 * 一旦超过浏览器 ~5s 的瞬时激活窗口，之后的选择框会被静默拦截，导入永久挂起。
 * 这里把缺失素材一次性列出来，由用户点击某一行的「选择文件」触发（自带手势），
 * 也支持一次多选后按文件名自动匹配。
 */

export interface MissingAssetRow {
  id: string
  name: string
  /** 素材类型（缺省按视频处理）。 */
  kind?: DraftAssetKind
  /** 原始时长（秒）；0/未知时不显示。 */
  duration?: number
  /** 工程里有多少条片段引用它。 */
  references: number
  /** 已选择的本地文件名；未选择时为 undefined。 */
  pickedName?: string
  /** 用户已明确跳过这一项。 */
  skipped: boolean
}

export interface MissingAssetsDialogProps {
  rows: MissingAssetRow[]
  /** 仍未决定（既没选文件也没跳过）的数量。 */
  pending: number
  /** 用户点击某一行的「选择文件」（自带手势，触发系统选择框）。 */
  onPick: (id: string) => void
  /** 一次多选：按文件名自动匹配所有待选素材。 */
  onPickMany: () => void
  onSkip: (id: string) => void
  onSkipAll: () => void
  /** 打开工程（未决定的按跳过处理）。 */
  onConfirm: () => void
  /** 放弃导入，当前工程保持不变。 */
  onCancel: () => void
}

function formatDuration(seconds: number | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return ''
  const total = Math.round(seconds)
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return minutes > 0 ? `${minutes}:${String(rest).padStart(2, '0')}` : `${rest} 秒`
}

function statusLabel(row: MissingAssetRow): string {
  if (row.pickedName) return `已选择：${row.pickedName}`
  if (row.skipped) return '已跳过（片段以占位显示）'
  return '待选择'
}

export function MissingAssetsDialog({
  rows,
  pending,
  onPick,
  onPickMany,
  onSkip,
  onSkipAll,
  onConfirm,
  onCancel,
}: MissingAssetsDialogProps) {
  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="export-dialog project-missing-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="缺失素材"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
        }}
      >
        <div className="export-head">
          <div>
            <p className="panel-eyebrow">PROJECT · 缺失素材</p>
            <h2>缺失素材（{rows.length} 个）</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="取消导入"
            title="取消导入（Esc）"
            onClick={onCancel}
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="export-body project-missing-body">
          <p className="project-missing-hint">
            这些素材在工程里被引用，但本机没有原文件。为每一项选择文件，或直接跳过：
            跳过的片段会以「素材已移除」占位显示（预览跳过、导出为背景），工程其它部分不受影响。
          </p>
          <ul className="project-missing-list">
            {rows.map((row) => {
              const kind = row.kind ?? 'video'
              const duration = formatDuration(row.duration)
              return (
                <li
                  key={row.id}
                  className={`project-missing-row${row.skipped ? ' is-skipped' : ''}${
                    row.pickedName ? ' is-picked' : ''
                  }`}
                  data-missing-asset-id={row.id}
                >
                  <div className="project-missing-info">
                    <strong className="project-missing-name">{row.name}</strong>
                    <span className="project-missing-meta">
                      {ASSET_KIND_LABELS[kind]}
                      {duration ? ` · ${duration}` : ''} · 引用 {row.references} 个片段
                    </span>
                    <span className="project-missing-status">{statusLabel(row)}</span>
                  </div>
                  <div className="project-missing-actions">
                    <button
                      type="button"
                      className="button mini ghost-mini"
                      data-action="pick"
                      aria-label={`为素材「${row.name}」选择文件`}
                      onClick={() => onPick(row.id)}
                    >
                      选择文件
                    </button>
                    {row.skipped ? (
                      <button
                        type="button"
                        className="button mini ghost-mini"
                        data-action="unskip"
                        onClick={() => onPick(row.id)}
                      >
                        重新选择
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="button mini ghost-mini"
                        data-action="skip"
                        aria-label={`跳过素材「${row.name}」`}
                        onClick={() => onSkip(row.id)}
                      >
                        跳过
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
          <p className="project-missing-hint">
            提示：点「一次多选」可以同时选择多个文件，按文件名（忽略扩展名、大小写）自动匹配；
            匹配不上的文件会被忽略。
          </p>
        </div>

        <div className="export-actions project-missing-actions">
          <button type="button" className="button ghost" onClick={onCancel}>
            取消导入
          </button>
          <span className="project-missing-spacer" />
          <button type="button" className="button ghost" onClick={onPickMany}>
            一次多选…
          </button>
          <button type="button" className="button ghost" onClick={onSkipAll}>
            全部跳过并打开
          </button>
          <button type="button" className="button primary" onClick={onConfirm}>
            打开工程{pending > 0 ? `（还差 ${pending} 个）` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}