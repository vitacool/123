import type { EditorState } from '../editorStore'
import type { StoreGet, StoreInternals, StoreSet } from '../internal'
import { EXPORT_RANGE_MIN_DURATION, clampExportRange, exportRangeDuration } from '../../core/exportRange'
import { clamp, getProjectEnd } from '../../core/timeline'
import { formatClock } from '../../core/format'


/** export slice：导出区间与导出对话框 */
export type ExportSlice = Pick<EditorState, 'exportRange' | 'exportRangeRaw' | 'exportDialogOpen' | 'setExportInPoint' | 'setExportOutPoint' | 'setExportRangeEdge' | 'clearExportRange' | 'openExportDialog' | 'closeExportDialog'>

export function createExportSlice(ctx: {
  get: StoreGet
  set: StoreSet
  internals: StoreInternals
}): ExportSlice {
  const { get, set, internals } = ctx
  void internals
  /**
   * 应用一组新的原始区间：`raw` 是用户点出来的真实入/出点（不做破坏性夹取），
   * `exportRange` 是「按当前工程长度夹过」的结果（界面/导出都只看它）。
   *
   * 为什么要分两份：工程变短（删掉尾部片段）会把区间夹短，而区间是会话态、不进撤销栈，
   * 撤销把工程还原之后夹短的值就再也回不来了 —— 用户以为还在导那一段，实际导了整条。
   * 保留 raw 后，只要工程变长回来，`sync()` 会自然重新推出完整的区间。
   */
  const applyRange = (
    raw: { start: number; end: number },
    total: number,
  ): { start: number; end: number } | null => {
    const clamped = clampExportRange(raw, total)
    if (!clamped) return null
    set({ exportRangeRaw: raw, exportRange: clamped })
    return clamped
  }
  return {
    exportRange: null,
    exportRangeRaw: null,
    exportDialogOpen: false,
    setExportInPoint: (time) => {
      const state = get()
      const total = Math.max(0, getProjectEnd(state.project))
      const start = clamp(time ?? state.playhead, 0, total)
      // 另一端优先取「未被夹短的原始值」；没有就用当前值 / 工程终点。
      const end = state.exportRangeRaw?.end ?? state.exportRange?.end ?? total
      const next = applyRange({ start, end }, total)
      if (!next) {
        state.notify('入点必须比出点早至少 0.1 秒', 'warning')
        return
      }
      state.notify(
        `导出范围 ${formatClock(next.start)} – ${formatClock(next.end)}（${exportRangeDuration(next).toFixed(1)} 秒）`,
        'success',
      )
    },
    setExportOutPoint: (time) => {
      const state = get()
      const total = Math.max(0, getProjectEnd(state.project))
      const end = clamp(time ?? state.playhead, 0, total)
      const start = state.exportRangeRaw?.start ?? state.exportRange?.start ?? 0
      const next = applyRange({ start, end }, total)
      if (!next) {
        state.notify('出点必须比入点晚至少 0.1 秒', 'warning')
        return
      }
      state.notify(
        `导出范围 ${formatClock(next.start)} – ${formatClock(next.end)}（${exportRangeDuration(next).toFixed(1)} 秒）`,
        'success',
      )
    },
    setExportRangeEdge: (edge, time) => {
      const state = get()
      const range = state.exportRangeRaw ?? state.exportRange
      if (!range) return
      const total = Math.max(0, getProjectEnd(state.project))
      const next =
        edge === 'start'
          ? {
              start: clamp(
                time,
                0,
                Math.max(0, range.end - EXPORT_RANGE_MIN_DURATION),
              ),
              end: range.end,
            }
          : {
              start: range.start,
              end: clamp(
                time,
                Math.min(total, range.start + EXPORT_RANGE_MIN_DURATION),
                total,
              ),
            }
      const clamped = applyRange(next, total)
      if (!clamped) return
    },
    clearExportRange: () => {
      const state = get()
      if (!state.exportRange && !state.exportRangeRaw) return
      set({ exportRange: null, exportRangeRaw: null })
      state.notify('已清除导出范围，导出整条时间轴', 'info')
    },
    openExportDialog: () => {
      set({
        exportDialogOpen: true,
        isPlaying: false,
        cropSession: null,
        previewPatch: null,
        markerEditorId: null,
      })
    },
    closeExportDialog: () => {
      if (get().exportDialogOpen) set({ exportDialogOpen: false })
    },
  }
}
