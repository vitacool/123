import { useEditorStore } from '../store/EditorProvider'
import { Icon } from './Icon'

/**
 * 「倒放」任务的进度条：显示当前分段进度与阶段文案，并提供取消按钮。
 * 取消在分段之间生效（每段约 2 秒），所以文案明确写出这一点，避免用户以为没反应。
 */
export function ReverseJobBanner() {
  const job = useEditorStore((state) => state.reverseJob)
  const cancelReverse = useEditorStore((state) => state.cancelReverse)
  if (!job) return null
  const progress = Math.max(0, Math.min(100, Number.isFinite(job.progress) ? job.progress : 0))
  return (
    <div className="reverse-job" role="status" aria-live="polite" aria-label="倒放进度">
      <span className="reverse-job-head">
        <Icon name="clock" size={14} />
        <strong>正在生成倒放素材</strong>
        <span className="reverse-job-name" title={job.assetName}>
          {job.assetName}
        </span>
      </span>
      <div
        className="reverse-job-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
      >
        <span style={{ width: `${Math.max(2, progress)}%` }} />
      </div>
      <span className="reverse-job-status">{job.status}</span>
      <button
        type="button"
        className="button mini reverse-job-cancel"
        onClick={cancelReverse}
        title="取消倒放（当前分段结束后停止，工程不会被改动）"
      >
        取消
      </button>
    </div>
  )
}