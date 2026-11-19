import { describe, expect, it } from 'vitest'
import {
  createSplitCommand,
  createUpdateClipCommand,
} from '../src/editor/core/commands'
import { HistoryStack } from '../src/editor/core/history'
import { createInitialProject } from '../src/editor/core/operations'
import type { Project } from '../src/editor/core/types'

function makeProject(): Project {
  return createInitialProject({ url: 'blob:test', duration: 10 }, 'clip-a')
}

describe('HistoryStack', () => {
  it('executes a command and undoes/redoes it', () => {
    const history = new HistoryStack(makeProject())
    const command = createUpdateClipCommand('clip-a', { rotation: 90 }, '旋转')

    const result = history.execute(command)
    expect(result.changed).toBe(true)
    expect(history.project.clips[0].rotation).toBe(90)
    expect(history.canUndo).toBe(true)
    expect(history.canRedo).toBe(false)

    const undone = history.undo()
    expect(undone?.command.label).toBe('旋转')
    expect(history.project.clips[0].rotation).toBe(0)
    expect(history.canRedo).toBe(true)

    history.redo()
    expect(history.project.clips[0].rotation).toBe(90)
  })

  it('does not add a history entry for a no-op command', () => {
    const history = new HistoryStack(makeProject())
    const command = createUpdateClipCommand('missing', { rotation: 20 }, '无效操作')
    const result = history.execute(command)
    expect(result.changed).toBe(false)
    expect(history.pastLength).toBe(0)
    expect(history.canUndo).toBe(false)
  })

  it('clears the redo stack after a new edit', () => {
    const history = new HistoryStack(makeProject())
    history.execute(createUpdateClipCommand('clip-a', { rotation: 30 }, '旋转'))
    history.undo()
    expect(history.canRedo).toBe(true)

    history.execute(createUpdateClipCommand('clip-a', { scale: 1.4 }, '缩放'))
    expect(history.canRedo).toBe(false)
    expect(history.project.clips[0].scale).toBe(1.4)
  })

  it('caps the undo stack at 100 entries', () => {
    const history = new HistoryStack(makeProject(), 100)
    for (let index = 0; index < 105; index += 1) {
      history.execute(
        createUpdateClipCommand('clip-a', { scale: 1 + index / 1000 }, '连续操作'),
      )
    }
    expect(history.pastLength).toBe(100)
    let undone = 0
    while (history.undo()) undone += 1
    expect(undone).toBe(100)
    expect(history.canUndo).toBe(false)
  })

  it('restores structural edits exactly across undo and redo', () => {
    const history = new HistoryStack(makeProject())
    const command = createSplitCommand('clip-a', 4, 'clip-right')
    history.execute(command)
    expect(history.project.clips).toHaveLength(2)
    expect(command.selectionAfter).toBe('clip-right')

    history.undo()
    expect(history.project.clips).toHaveLength(1)
    expect(history.project.clips[0].sourceEnd).toBe(10)

    history.redo()
    expect(history.project.clips).toHaveLength(2)
    expect(history.project.clips[1].id).toBe('clip-right')
  })

  it('keeps immutable snapshots for existing projects', () => {
    const project = makeProject()
    const history = new HistoryStack(project)
    history.execute(createUpdateClipCommand('clip-a', { rotation: 45 }, '旋转'))
    expect(project.clips[0].rotation).toBe(0)
    expect(history.project.clips[0].rotation).toBe(45)
  })
})