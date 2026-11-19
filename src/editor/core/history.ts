import { HISTORY_LIMIT } from './constants'
import type { EditorCommand } from './commands'
import type { Project } from './types'

export interface HistoryEntry {
  command: EditorCommand
  before: Project
  after: Project
}

/**
 * Snapshot-backed command history. Commands make edits; snapshots make undo
 * and redo exact even for structural edits such as splitting a clip.
 */
export class HistoryStack {
  #past: HistoryEntry[] = []
  #future: HistoryEntry[] = []
  #present: Project
  readonly limit: number

  constructor(initial: Project, limit = HISTORY_LIMIT) {
    this.#present = initial
    this.limit = Math.max(1, limit)
  }

  get project(): Project {
    return this.#present
  }

  get canUndo(): boolean {
    return this.#past.length > 0
  }

  get canRedo(): boolean {
    return this.#future.length > 0
  }

  get pastLength(): number {
    return this.#past.length
  }

  get futureLength(): number {
    return this.#future.length
  }

  execute(command: EditorCommand): { project: Project; changed: boolean; entry?: HistoryEntry } {
    const before = this.#present
    const after = command.execute(before)
    if (after === before) return { project: before, changed: false }

    const entry: HistoryEntry = { command, before, after }
    this.#past.push(entry)
    if (this.#past.length > this.limit) this.#past.shift()
    this.#future = []
    this.#present = after
    return { project: after, changed: true, entry }
  }

  undo(): HistoryEntry | null {
    const entry = this.#past.pop()
    if (!entry) return null
    this.#future.unshift(entry)
    this.#present = entry.before
    return entry
  }

  redo(): HistoryEntry | null {
    const entry = this.#future.shift()
    if (!entry) return null
    this.#past.push(entry)
    this.#present = entry.after
    return entry
  }

  reset(project: Project): void {
    this.#present = project
    this.#past = []
    this.#future = []
  }
}