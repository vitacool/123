import type { EditorState } from '../editorStore'
import type { StoreGet, StoreInternals, StoreSet } from '../internal'
import { EXPORT_RANGE_MIN_DURATION, clampExportRange, exportRangeDuration } from '../../core/exportRange'
import { clamp, getProjectEnd } from '../../core/timeline'
import { formatClock } from '../../core/format'


/** export slice：导出区间与导出对话框 */
export type ExportSlice = Pick<EditorState, 'exportRange' | 'exportDialogOpen' | 'setExportInPoint' | 'setExportOutPoint' | 'setExportRangeEdge' | 'clearExportRange' | 'openExportDialog' | 'closeExportDialog'>

export function createExportSlice(ctx: {
  get: StoreGet
  set: StoreSet
  internals: StoreInternals
}): ExportSlice {
  const { get, set, internals } = ctx
  void internals
  return {
    exportRange: null,
    exportDialogOpen: false,
    setExportInPoint: (time) => {
      const state = get()
      const total = Math.max(0, getProjectEnd(state.project))
      const start = clamp(time ?? state.playhead, 0, total)
      // 还没有区间时另一端取工程终点；已有区间时另一端保持不变。
      const end = state.exportRange?.end ?? total
      const next = clampExportRange({ start, end }, total)
      if (!next) {
        state.notify('入点必须比出点早至少 0.1 秒', 'warning')
        return
      }
      set({ exportRange: next })
      state.notify(
        `导出范围 ${formatClock(next.start)} – ${formatClock(next.end)}（${exportRangeDuration(next).toFixed(1)} 秒）`,
        'success',
      )
    },
    setExportOutPoint: (time) => {
      const state = get()
      const total = Math.max(0, getProjectEnd(state.project))
      const end = clamp(time ?? state.playhead, 0, total)
      // 还没有区间时另一端取工程起点；已有区间时另一端保持不变。
      const start = state.exportRange?.start ?? 0
      const next = clampExportRange({ start, end }, total)
      if (!next) {
        state.notify('出点必须比入点晚至少 0.1 秒', 'warning')
        return
      }
      set({ exportRange: next })
      state.notify(
        `导出范围 ${formatClock(next.start)} – ${formatClock(next.end)}（${exportRangeDuration(next).toFixed(1)} 秒）`,
        'success',
      )
    },
    setExportRangeEdge: (edge, time) => {
      const state = get()
      const range = state.exportRange
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
      const clamped = clampExportRange(next, total)
      if (!clamped) return
      if (clamped.start === range.start && clamped.end === range.end) return
      set({ exportRange: clamped })
    },
    clearExportRange: () => {
      const state = get()
      if (!state.exportRange) return
      set({ exportRange: null })
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
