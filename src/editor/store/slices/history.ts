import type { EditorState } from '../editorStore'
import type { StoreGet, StoreInternals, StoreSet } from '../internal'
import type { HistoryState } from '../internal'
import type { Project } from '../../core/types'
import { findClipLocation } from '../../core/timeline'
import { findAudioClipLocation } from '../../core/audio'
import { findTextClipLocation } from '../../core/text'
import { selectionFallbackId } from '../../core/selection'

/** 片段 id 在给定工程快照里是否真的存在（主轨 / 叠加轨 / 音频轨 / 字幕轨）。 */
function clipExists(project: Project, id: string): boolean {
  return Boolean(
    findClipLocation(project, id) ||
      findAudioClipLocation(project, id) ||
      findTextClipLocation(project, id),
  )
}

/**
 * 撤销/重做后的选区。
 *
 * 三条分支缺一不可：
 * 1. 命令声明了 id 且它在目标快照里存在 → 用它（如「更新属性」类命令）；
 * 2. 命令**明确**声明 `null`（如批量删除）→ 清空，不要自作聪明地选一个；
 * 3. 命令没声明，或声明的 id 已经不存在（分割/定格/粘贴这类新 id）→ 就近回落到
 *    播放头所在片段。曾经这里退回「当前选中」，而当前选中恰恰就是那个已消失的
 *    新 id，于是撤销分割后选区成了幽灵，后续 Delete / 分割全部静默失效。
 */
function restoredSelection(
  project: Project,
  command: { selectionAfter?: string | null },
  playhead: number,
): string | null {
  const requested = command.selectionAfter
  if (typeof requested === 'string' && requested.length > 0) {
    if (clipExists(project, requested)) return requested
    return selectionFallbackId(project, playhead)
  }
  if (requested === null) return null
  return selectionFallbackId(project, playhead)
}

/** history slice：工程快照本身 + 撤销/重做入口 */
export type HistorySlice = Pick<
  EditorState,
  'project' | 'lastAction' | 'history' | 'execute' | 'undo' | 'redo'
>

export function createHistorySlice(ctx: {
  get: StoreGet
  set: StoreSet
  internals: StoreInternals
  initialProject: EditorState['project']
}): HistorySlice {
  const { get, set, internals, initialProject } = ctx
  const run = internals.run
  const sync = internals.sync
  void get
  void set
  return {
    project: initialProject,
    lastAction: '',
    history: {
      stack: internals.history,
      pastLength: 0,
      futureLength: 0,
      version: 0,
    } satisfies HistoryState,
    execute: (command) => run(command),
    undo: () => {
      const entry = internals.undo()
      if (!entry) return
      set({ isPlaying: false, cropSession: null, previewPatch: null })
      // 撤销后按命令声明的 selectionAfter 恢复选中（与 redo 一致），
      // 否则撤销“删除”“分割”等操作后选区会丢失，用户还得重新找片段。
      const selection = restoredSelection(entry.before, entry.command, get().playhead)
      sync(entry.before, selection)
      set({ lastAction: `撤销 · ${entry.command.label}` })
    },
    redo: () => {
      const entry = internals.redo()
      if (!entry) return
      set({ isPlaying: false, cropSession: null, previewPatch: null })
      const selection = restoredSelection(entry.after, entry.command, get().playhead)
      sync(entry.after, selection)
      set({ lastAction: `重做 · ${entry.command.label}` })
    },
  }
}
