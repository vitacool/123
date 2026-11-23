import type { EditorCommand } from '../core/commands'
import type { Project } from '../core/types'
import { HistoryStack } from '../core/history'
import { assetsReferencedBy, isAssetReferenced } from '../core/assets'
import { relinkCaptions } from '../core/captionLink'
import { clampExportRange } from '../core/exportRange'
import { clamp, findClipLocation, getProjectEnd } from '../core/timeline'
import { findAudioClipLocation } from '../core/audio'
import { findTextClipLocation } from '../core/text'
import { primaryOf } from '../core/selection'
import { deleteMediaBlobIfUnreferenced } from '../services/draftStore'
import type { EditorState, PendingReclaimEntry } from './editorStore'

/**
 * store 的共享内核：所有 slice 共用的东西都放这里。
 *
 * 为什么单独抽出来：这些闭包（历史栈、命令执行、状态同步、素材回收）几乎每个
 * slice 的动作用到。如果让 slice 互相 import，很快就形成环；统一走内核，
 * slice 只依赖「内核 + 自己的状态」。
 *
 * 注意：这里**不做**任何语义改写——只是把原本在 createEditorStore 里的几个闭包
 * 原样搬出来（Step 1 要求「行为零变化」，由 945 个单测守住）。
 */

export type StoreGet = () => EditorState
export type StoreSet = (
  patch: Partial<EditorState> | ((state: EditorState) => Partial<EditorState>),
) => void

/**
 * store 里可见的历史摘要。
 *
 * 为什么不是直接放 `HistoryStack`：它是**可变对象**，引用永远不变，zustand 的选择器
 * 不会因为"栈长度变了"而重渲染。所以每次栈变动都整体替换这个摘要对象，
 * `canUndo / canRedo` 由里面的长度派生（见 selectCanUndo / selectCanRedo）。
 */
export interface HistoryState {
  /** 真正的栈（唯一真源）。 */
  readonly stack: HistoryStack
  readonly pastLength: number
  readonly futureLength: number
  /** 每次变动 +1，便于调试与订阅（也为将来做时间旅行留位置）。 */
  readonly version: number
}

export interface StoreInternals {
  /** 命令历史栈（唯一真源）。 */
  readonly history: HistoryStack
  /** 把历史栈给出的工程快照写进 store（派生选中 / 夹播放头 / 素材对账）。 */
  sync(project: Project, selection?: string | null): void
  /** 执行一条命令（磁吸夹紧 + 字幕联动 + 入历史 + 同步）。 */
  run(command: EditorCommand): boolean
  /** 撤销一步（同时发布历史摘要）；无步骤可撤销返回 null。 */
  undo(): import('../core/history').HistoryEntry | null
  /** 重做一步（同时发布历史摘要）。 */
  redo(): import('../core/history').HistoryEntry | null
  /** 重置历史（切/关项目）并发布摘要。 */
  resetHistory(project: Project): void
  /** 待回收素材的对账。 */
  reconcilePendingAssets(options?: { force?: boolean }): void
  /** 工程被整体替换时停掉进行中的倒放任务。 */
  cancelReverseForProjectSwap(): void
  /** 当前倒放任务的取消器（由 reverse 动作持有）。 */
  getReverseController(): AbortController | null
  setReverseController(controller: AbortController | null): void
}

// ---- clampMainTrackStart ----
export const clampMainTrackStart = (project: Project): Project => {
  if (project.clips.length === 0) return project
  const first = project.clips[0]
  if ((first.gapBefore ?? 0) <= 0.0001) return project
  return {
    ...project,
    clips: [{ ...first, gapBefore: 0 }, ...project.clips.slice(1)],
  }
}

export function createStoreInternals(
  get: StoreGet,
  set: StoreSet,
  /** 初始工程：创建时就确定，避免在 zustand 初始化回调里调用 get()（此时 state 还不存在）。 */
  initial: Project,
): StoreInternals {
  const history = new HistoryStack(initial)
  let reverseController: AbortController | null = null
  let historyVersion = 0

  /** 把历史栈的最新长度写进 store（整体替换摘要对象 → 选择器能感知变化）。 */
  const publishHistory = (): void => {
    historyVersion += 1
    set({
      history: {
        stack: history,
        pastLength: history.pastLength,
        futureLength: history.futureLength,
        version: historyVersion,
      },
    })
  }

  // ---- idAndReverse ----
    /** 判断某 id 是否仍存在于工程中（任意轨道、任意类型）。 */
  const idExists = (project: Project, id: string): boolean =>
    Boolean(
      findClipLocation(project, id) ||
        findAudioClipLocation(project, id) ||
        findTextClipLocation(project, id),
    )

  /** 工程被整体替换（新建 / 载入 / 恢复草稿）时，停掉进行中的倒放任务。 */
  const cancelReverseForProjectSwap = (): void => {
    reverseController?.abort()
    reverseController = null
    if (get().reverseJob) set({ reverseJob: null })
  }

  // ---- sync ----
  const sync = (project: Project, selection?: string | null): void => {
      /**
       * 这里**只**接受历史栈给的工程快照，绝不在这里改写它。
       *
       * 曾经这里按「主轨磁吸」把首段的 gap 夹成 0：撤销「主轨首段贴齐」之后，
       * 历史栈恢复到带空隙的 before 快照，sync 又把它夹回去 —— store.project 与
       * history.present 从此不一致（再撤销/重做会以不同的底稿计算，表现为「撤销失效」）。
       *
       * 磁吸的贴齐属于**编辑语义**，只应在命令执行链里做（见 run() 的 effectiveCommand，
       * 以及 toggleTimelineSetting 打开磁吸时执行的那条可撤销贴齐命令）。
       */
      const effective = project
      const total = getProjectEnd(effective)
      const current = get()
      // 多选：保留仍然存在的项；命令指定的 selection 覆盖为单选。
      const previousIds =
        current.selectedIds.length > 0
          ? current.selectedIds
          : current.selectedClipId
            ? [current.selectedClipId]
            : []
      let ids = previousIds.filter((id) => idExists(effective, id))
      if (selection !== undefined) {
        if (selection === null) ids = []
        else if (!ids.includes(selection)) ids = [selection]
      }
      const nextSelection = primaryOf(ids, current.selectedClipId)
      const playhead = clamp(current.playhead, 0, Math.max(0, total))
      // 工程变短后导出区间自动夹回有效范围（夹不动就视为未设置）。
      const exportRange = clampExportRange(current.exportRange, Math.max(0, total))
      set({
        project: effective,
        selectedIds: ids,
        selectedClipId: nextSelection,
        playhead,
        exportRange,
        cropSession:
          current.cropSession && findClipLocation(effective, current.cropSession.clipId)
            ? current.cropSession
            : null,
        previewPatch: null,
        markerEditorId:
          current.markerEditorId &&
          effective.markers.some((marker) => marker.id === current.markerEditorId)
            ? current.markerEditorId
            : null,
      })
      // 名额之外：撤销/重做/新命令都可能让「待回收」素材重新被引用或彻底没人引用。
      reconcilePendingAssets()
    }

  // ---- reconcile ----
  /**
   * 「待回收」素材的对账（延迟回收的核心）。
   *
   * 删除素材时片段删除走命令（可撤销），但 objectURL revoke 与 blob 删除不可逆。
   * 所以删除只把素材记为 pending 并从 `assets` 移除，这里负责两个方向的收敛：
   *
   * - **仍被引用**（当前工程 或 历史栈 past/present/future 的任一快照）→ 继续等；
   *   如果它此时已经不在素材库里（典型：Ctrl+Z 把片段带回来了但素材还是隐藏的），
   *   就把素材插回素材库原位置——这就是「撤销删除后素材重新出现」。
   * - **不再被引用** → 真正回收：revoke objectURL + 删除 IndexedDB 里的 blob
   *   （仍保留「其它项目还在用就别删」的判定）。
   *
   * `force`：切/关项目、组件卸载、destroy 时历史栈会被丢弃（或编辑器已经没了），
   * 不可能再撤销回来，直接全部回收。
   */
  const reconcilePendingAssets = (options: { force?: boolean } = {}): void => {
    const state = get()
    const entries = Object.entries(state.pendingReclaim)
    if (entries.length === 0) return

    const snapshots = options.force ? [] : history.snapshots()
    let assets = state.assets
    let source = state.source
    let changed = false
    const nextPending: Record<string, PendingReclaimEntry> = {}

    for (const [id, entry] of entries) {
      const projectRefs = isAssetReferenced(state.project, entry.asset)
      const historyRefs = !options.force && assetsReferencedBy(snapshots, entry.asset)
      const referenced = projectRefs || historyRefs

      if (referenced) {
        // 撤销把「当时被删掉的片段」带回来了 → 素材回素材库，待回收状态就此结束。
        // removeClips=false 的删除（片段本来就没被删）不恢复：用户就是想让它离开素材库。
        if (entry.removedClips && projectRefs) {
          changed = true
          if (!assets.some((item) => item.id === id)) {
            const insertAt = Math.min(Math.max(0, entry.indexAtDelete), assets.length)
            assets = [...assets.slice(0, insertAt), entry.asset, ...assets.slice(insertAt)]
            if (!source && entry.asset.kind !== 'audio') source = entry.asset
          }
          continue
        }
        nextPending[id] = entry
        continue
      }

      // 真正回收（不可逆）
      changed = true
      if (entry.asset.url.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(entry.asset.url)
        } catch {
          // 已经失效的 URL 忽略。
        }
      }
      void deleteMediaBlobIfUnreferenced(entry.asset.id, {
        exceptProjectId: entry.projectId,
        stillReferenced: assets.filter((item) => item.id !== id).map((item) => item.id),
      }).catch(() => undefined)
    }

    if (!changed) return
    set({ assets, source, pendingReclaim: nextPending })
  }

  // ---- run ----
  const run = (command: EditorCommand): boolean => {
    const effectiveCommand: EditorCommand = {
      ...command,
      execute(project) {
        let next = command.execute(project)
        if (next === project) return project
        if (get().timelineSettings.mainTrackMagnet) {
          next = clampMainTrackStart(next)
        }
        // 统一的字幕联动 hook：任何改动片段布局的命令都在同一步撤销里
        // 重新对齐带 link 的智能字幕。
        if (get().captionFollow) {
          const urlToAssetId = new Map(get().assets.map((asset) => [asset.url, asset.id]))
          next = relinkCaptions(next, urlToAssetId)
        }
        return next
      },
    }
    const result = history.execute(effectiveCommand)
    if (!result.changed) return false
    publishHistory()
    set({ isPlaying: false })
    sync(result.project, command.selectionAfter)
    set({ lastAction: command.label })
    return true
  }

  return {
    history,
    undo: () => {
      const entry = history.undo()
      if (entry) publishHistory()
      return entry
    },
    redo: () => {
      const entry = history.redo()
      if (entry) publishHistory()
      return entry
    },
    resetHistory: (project) => {
      history.reset(project)
      publishHistory()
    },
    sync,
    run,
    reconcilePendingAssets,
    cancelReverseForProjectSwap,
    getReverseController: () => reverseController,
    setReverseController: (controller) => {
      reverseController = controller
    },
  }
}
