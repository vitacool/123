import type { EditorState } from '../editorStore'
import type { StoreGet, StoreInternals, StoreSet } from '../internal'
import type { HistoryState } from '../internal'
import { findClipLocation } from '../../core/timeline'
import { findAudioClipLocation } from '../../core/audio'
import { findTextClipLocation } from '../../core/text'

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
      const selection =
        entry.command.selectionAfter &&
        (findClipLocation(entry.before, entry.command.selectionAfter) ||
          findAudioClipLocation(entry.before, entry.command.selectionAfter) ||
          findTextClipLocation(entry.before, entry.command.selectionAfter))
          ? entry.command.selectionAfter
          : get().selectedClipId
      sync(entry.before, selection)
      set({ lastAction: `撤销 · ${entry.command.label}` })
    },
    redo: () => {
      const entry = internals.redo()
      if (!entry) return
      set({ isPlaying: false, cropSession: null, previewPatch: null })
      const selection =
        entry.command.selectionAfter &&
        (findClipLocation(entry.after, entry.command.selectionAfter) ||
          findAudioClipLocation(entry.after, entry.command.selectionAfter) ||
          findTextClipLocation(entry.after, entry.command.selectionAfter))
          ? entry.command.selectionAfter
          : get().selectedClipId
      sync(entry.after, selection)
      set({ lastAction: `重做 · ${entry.command.label}` })
    },
  }
}
