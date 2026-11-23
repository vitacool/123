import type { EditorState } from '../editorStore'
import type { StoreGet, StoreInternals, StoreSet } from '../internal'
import { DEFAULT_PROJECT_NAME, normalizeProjectName, projectThumbnail } from '../../core/projectLibrary'
import { createEmptyProject } from '../../core/operations'
import { TIMELINE_MAX_ZOOM, TIMELINE_MIN_ZOOM } from '../../core/constants'
import { clampExportRange } from '../../core/exportRange'
import { clamp, getProjectEnd } from '../../core/timeline'
import {
  reportDraftSaveFailure,
  saveProjectRecord,
  toDraftSnapshot,
} from '../../services/draftStore'


/** persistence slice：项目身份、草稿恢复与项目生命周期 */
export type PersistenceSlice = Pick<EditorState, 'projectId' | 'projectName' | 'projectNameEdited' | 'renameProject' | 'adoptProject' | 'flushProjectSave' | 'hydrateDraft' | 'clearSource'>

export function createPersistenceSlice(ctx: {
  get: StoreGet
  set: StoreSet
  internals: StoreInternals
}): PersistenceSlice {
  const { get, set, internals } = ctx
  /** 换/关项目时：重置历史、停掉倒放、强制回收待回收素材。 */
  const { reconcilePendingAssets, cancelReverseForProjectSwap } = internals
  return {
    projectId: null,
    projectName: DEFAULT_PROJECT_NAME,
    projectNameEdited: false,
    hydrateDraft: (draft) => {
      cancelReverseForProjectSwap()
      internals.resetHistory(draft.project)
      const firstAudio = draft.project.audioTracks?.[0]?.clips[0]?.id ?? null
      const firstSelection = draft.project.clips[0]?.id ?? firstAudio
      set({
        project: draft.project,
        assets: draft.assets,
        source: draft.source,
        selectedClipId: firstSelection,
        // 切项目必须重置多选集合（否则复制/删除会读到上一个项目的失效 id）。
        selectedIds: firstSelection ? [firstSelection] : [],
        playhead: clamp(
          draft.playhead,
          0,
          Math.max(0, getProjectEnd(draft.project)),
        ),
        isPlaying: false,
        timelineZoom: clamp(
          draft.timelineZoom,
          TIMELINE_MIN_ZOOM,
          TIMELINE_MAX_ZOOM,
        ),
        timelineSettings: {
          mainTrackMagnet: draft.timelineSettings.mainTrackMagnet,
          autoSnap: draft.timelineSettings.autoSnap,
          linkage: draft.timelineSettings.linkage,
          previewAxis: draft.timelineSettings.previewAxis,
        },
        captionFollow: draft.timelineSettings.captionFollow ?? true,
        // 旧草稿没有 exportRange：按「导出全部」处理，越界区间夹回有效范围。
        exportRange: clampExportRange(
          draft.timelineSettings.exportRange ?? null,
          Math.max(0, getProjectEnd(draft.project)),
        ),
        cropSession: null,
        previewPatch: null,
        markerEditorId: null,
        exportDialogOpen: false,
        lastAction: '',
        toast: null,
        asrWordsBySource: null,
      })
      // 换到了另一个项目：旧工程的历史栈刚被 reset，待回收素材已不可能被撤销带回。
      reconcilePendingAssets({ force: true })
    },
    clearSource: () => {
      cancelReverseForProjectSwap()
      const empty = createEmptyProject()
      internals.resetHistory(empty)
      set({
        source: null,
        assets: [],
        project: empty,
        // 空会话没有项目身份：首次导入素材时再分配。
        projectId: null,
        projectName: DEFAULT_PROJECT_NAME,
        projectNameEdited: false,
        selectedClipId: null,
        selectedIds: [],
        playhead: 0,
        isPlaying: false,
        exportRange: null,
        cropSession: null,
        previewPatch: null,
        markerEditorId: null,
        exportDialogOpen: false,
        lastAction: '',
        toast: null,
        asrWordsBySource: null,
      })
      // 关闭当前项目（清空会话）：历史栈已 reset，待回收素材一律立即回收。
      reconcilePendingAssets({ force: true })
    },
    renameProject: (name) => {
      const next = normalizeProjectName(name)
      const state = get()
      if (state.projectName === next && state.projectNameEdited) return
      set({ projectName: next, projectNameEdited: true })
    },
    adoptProject: (id, name) => {
      // 切项目前先把当前项目落盘，避免「切换发生在自动保存防抖窗口内」丢编辑。
      get().flushProjectSave()
      set({
        projectId: id,
        projectName: normalizeProjectName(name),
        projectNameEdited: true,
      })
      // 接管新项目：旧工程的历史即将被 hydrateDraft 重置，待回收素材按「关闭」处理。
      reconcilePendingAssets({ force: true })
    },
    flushProjectSave: () => {
      const state = get()
      const id = state.projectId
      // 没有项目身份（从未有内容的新会话）不落盘，避免列表里出现空项目。
      if (!id) return
      const snapshot = toDraftSnapshot(state)
      const record = {
        id,
        name: state.projectName,
        updatedAt: Date.now(),
        thumbnail: projectThumbnail(snapshot),
        snapshot,
      }
      void saveProjectRecord(record).catch(() => reportDraftSaveFailure(state.notify))
    },
  }
}
