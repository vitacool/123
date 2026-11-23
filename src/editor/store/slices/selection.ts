import type { Clip, Project, TextClip } from '../../core/types'
import { findClipLocation, findSegmentById, getTimeline } from '../../core/timeline'
import { isOverlayLocked, isMainLocked, isAudioLocked, isTextLocked } from '../../core/tracks'
import { findAudioClipLocation } from '../../core/audio'
import { findTextClipLocation } from '../../core/text'
import { normalizeSelection, planBatchMove, primaryOf, rangeSelection, toggleSelection } from '../../core/selection'
import { buildClipboardPayload, planPaste } from '../../core/clipboard'
import type { IdFactory } from '../../core/clipboard'
import { createDeleteManyCommand, createPasteCommand, createMoveManyCommand, createUpdateAnyClipCommand, createPasteVisualAttributesCommand, createPasteAudioAttributesCommand, createPasteSpeedAttributesCommand, createDeleteOverlayClipCommand, createDeleteClipCommand } from '../../core/commands'
import { createId } from '../../core/ids'
import { clipTimelineDuration } from '../../core/clipTime'
import { normalizeColor, isSameColor } from '../../core/color'
import { captureVisualAttrs, captureAudioAttrs, captureSpeedAttrs, speedAttrsPatch } from '../../core/attributeClipboard'
import { applyAttributePatch } from '../../core/operations'
import { canChangeClipSpeed } from '../../core/speed'
import type { EditorState } from '../editorStore'
import {
  getAudio as getAudioAttrs,
  getSpeed as getSpeedAttrs,
  getVisual as getVisualAttrs,
  setAudio as setAudioAttrs,
  setSpeed as setSpeedAttrs,
  setVisual as setVisualAttrs,
} from '../../core/attributeClipboard'
import type { StoreGet, StoreInternals, StoreSet } from '../internal'


/** 可选中的片段 id（主轨 / 叠加轨 / 音频轨 / 字幕轨，按显示顺序）。 */
function selectableOrder(project: Project): string[] {
  const ids: string[] = []
  for (const segment of getTimeline(project.clips)) ids.push(segment.clip.id)
  for (const track of project.overlayTracks ?? []) {
    for (const segment of getTimeline(track.clips)) ids.push(segment.clip.id)
  }
  for (const track of project.audioTracks ?? []) {
    for (const clip of track.clips) ids.push(clip.id)
  }
  for (const track of project.textTracks ?? []) {
    for (const clip of track.clips) ids.push(clip.id)
  }
  return ids
}

/** selection slice：选中集合、剪贴板与属性剪贴板 */
export type SelectionSlice = Pick<EditorState, 'selectedClipId' | 'selectedIds' | 'clipboard' | 'colorClipboard' | 'selectClip' | 'toggleSelectClip' | 'rangeSelectClip' | 'selectIds' | 'selectAll' | 'copySelection' | 'cutSelection' | 'pasteAtPlayhead' | 'moveSelectionBy' | 'deleteSelectedClip' | 'copyClipColor' | 'pasteClipColor' | 'copyVisualAttributes' | 'pasteVisualAttributes' | 'copyAudioAttributes' | 'pasteAudioAttributes' | 'copySpeedAttributes' | 'pasteSpeedAttributes'>


export function createSelectionSlice(ctx: {
  get: StoreGet
  set: StoreSet
  internals: StoreInternals
}): SelectionSlice {
  const { get, set, internals } = ctx
  /** 所有改动工程的选中类动作都走同一条命令链（磁吸 / 字幕联动 / 一步撤销）。 */
  const run = internals.run

/** 粘贴目标：显式传入的 ids 优先，其次多选，最后当前单选。 */
  const resolvePasteTargets = (state: EditorState, ids: readonly string[]): string[] => {
    if (ids.length > 0) return [...ids]
    if (state.selectedIds.length > 0) return [...state.selectedIds]
    return state.selectedClipId ? [state.selectedClipId] : []
  }

  /** 统一的选中入口：写 selectedIds，并派生 selectedClipId。 */
  const setSelection = (ids: string[], preferred?: string | null): void => {
      const nextIds = normalizeSelection(ids)
      set({
        selectedIds: nextIds,
        selectedClipId: primaryOf(nextIds, preferred),
        markerEditorId: null,
        cropSession: null,
      })
    }

  return {
    selectedClipId: null,
    selectedIds: [],
    clipboard: { items: [], count: 0 },
    colorClipboard: null,
    selectClip: (id) => {
      const project = get().project
      let textToReveal: TextClip | null = null
      if (id) {
        const video = findClipLocation(project, id)
        if (video) {
          const locked = video.track
            ? isOverlayLocked(video.track)
            : isMainLocked(project)
          if (locked) return
        } else {
          const audio = findAudioClipLocation(project, id)
          if (audio && isAudioLocked(audio.track)) return
          const text = findTextClipLocation(project, id)
          if (text) {
            if (isTextLocked(text.track)) return
            textToReveal = text.clip
          }
        }
      }
      const crop = get().cropSession
      setSelection(id ? [id] : [])
      if (crop && crop.clipId !== id) {
        set({ cropSession: null })
      }
      if (crop && crop.clipId === id) {
        set({ cropSession: crop })
      }
      if (textToReveal) {
        const playhead = get().playhead
        if (
          playhead < textToReveal.start - 0.001 ||
          playhead >= textToReveal.end - 0.001
        ) {
          set({ playhead: Math.max(0, textToReveal.start) })
        }
      }
    },
    toggleSelectClip: (id) => {
      const state = get()
      const project = state.project
      // 锁定轨道上的片段不可选中。
      const video = findClipLocation(project, id)
      if (video && (video.track ? isOverlayLocked(video.track) : isMainLocked(project))) return
      const audio = findAudioClipLocation(project, id)
      if (audio && isAudioLocked(audio.track)) return
      const text = findTextClipLocation(project, id)
      if (text && isTextLocked(text.track)) return

      const base = state.selectedIds.length > 0
        ? state.selectedIds
        : state.selectedClipId
          ? [state.selectedClipId]
          : []
      setSelection(toggleSelection(base, id), id)
    },
    rangeSelectClip: (id) => {
      const state = get()
      // 以主选中为锚点，按时间轴上的显示顺序做区间选择。
      const ordered = selectableOrder(state.project)
      setSelection(rangeSelection(ordered, state.selectedClipId, id), id)
    },
    selectIds: (ids) => {
      setSelection(ids)
    },
    selectAll: () => {
      const state = get()
      setSelection(selectableOrder(state.project))
    },
    copySelection: () => {
      const state = get()
      const ids = state.selectedIds.length > 0
        ? state.selectedIds
        : state.selectedClipId
          ? [state.selectedClipId]
          : []
      const payload = buildClipboardPayload(state.project, ids)
      if (payload.count === 0) return
      set({ clipboard: payload })
      state.notify(`已复制 ${payload.count} 个片段`, 'info')
    },
    cutSelection: () => {
      const state = get()
      const ids = state.selectedIds.length > 0
        ? state.selectedIds
        : state.selectedClipId
          ? [state.selectedClipId]
          : []
      const payload = buildClipboardPayload(state.project, ids)
      if (payload.count === 0) return
      set({ clipboard: payload })
      if (run(createDeleteManyCommand(ids))) {
        state.notify(`已剪切 ${payload.count} 个片段`, 'info')
      }
    },
    pasteAtPlayhead: () => {
      const state = get()
      const payload = state.clipboard
      if (payload.count === 0) {
        state.notify('剪贴板为空', 'warning')
        return
      }
      const lockedTrackIds = new Set<string>()
      for (const track of state.project.overlayTracks ?? []) {
        if (isOverlayLocked(track)) lockedTrackIds.add(track.id)
      }
      for (const track of state.project.audioTracks ?? []) {
        if (isAudioLocked(track)) lockedTrackIds.add(track.id)
      }
      for (const track of state.project.textTracks ?? []) {
        if (isTextLocked(track)) lockedTrackIds.add(track.id)
      }
      const plan = planPaste(state.project, payload, state.playhead, { lockedTrackIds })
      const outIds: string[] = []
      const nextId: IdFactory = (prefix) => createId(prefix === 'overlay' ? 'overlay' : prefix)
      if (run(createPasteCommand(plan, nextId, outIds))) {
        if (outIds.length > 0) setSelection(outIds, outIds[0])
        get().notify(`已粘贴 ${outIds.length} 个片段`, 'success')
      }
    },
    moveSelectionBy: (delta) => {
      const state = get()
      const ids = state.selectedIds.length > 0
        ? state.selectedIds
        : state.selectedClipId
          ? [state.selectedClipId]
          : []
      if (ids.length === 0 || Math.abs(delta) < 0.0001) return
      // 顺序轨以段头最小 gapBefore 收敛，避免越界。
      const items = ids.map((id) => {
        const video = findSegmentById(state.project.clips, id)
        if (video) return { id, start: video.start, duration: video.duration }
        for (const track of state.project.overlayTracks ?? []) {
          const segment = findSegmentById(track.clips, id)
          if (segment) return { id, start: segment.start, duration: segment.duration }
        }
        const audio = findAudioClipLocation(state.project, id)
        if (audio) return { id, start: audio.clip.start, duration: clipTimelineDuration(audio.clip) }
        const text = findTextClipLocation(state.project, id)
        if (text) return { id, start: text.clip.start, duration: text.clip.end - text.clip.start }
        return null
      }).filter((item): item is { id: string; start: number; duration: number } => item !== null)
      if (items.length === 0) return
      const moves = planBatchMove(items, delta)
      if (run(createMoveManyCommand(moves.map((move) => move.id), moves[0].delta))) {
        get().notify(`已移动 ${moves.length} 个片段`, 'info')
      }
    },
    copyClipColor: (clipId) => {
      const state = get()
      const location =
        findClipLocation(state.project, clipId)?.clip ??
        findAudioClipLocation(state.project, clipId)?.clip ??
        null
      if (!location) return
      set({ colorClipboard: normalizeColor('color' in location ? location.color : null) })
      state.notify('已复制当前调色设置', 'info')
    },
    pasteClipColor: (clipId) => {
      const state = get()
      const clipboard = state.colorClipboard
      if (!clipboard) {
        state.notify('还没有复制调色设置', 'warning')
        return
      }
      const location = findClipLocation(state.project, clipId)
      if (!location) return
      if (location.track ? isOverlayLocked(location.track) : isMainLocked(state.project)) return
      if (isSameColor(normalizeColor(location.clip.color), clipboard)) return
      run(createUpdateAnyClipCommand(clipId, { color: clipboard }, '粘贴调色'))
    },
    copyVisualAttributes: (clipId) => {
      const state = get()
      const location = findClipLocation(state.project, clipId)
      if (!location) {
        state.notify('没有可复制的片段', 'warning')
        return
      }
      // 复制是只读操作，锁定轨道上的片段也允许复制。
      setVisualAttrs(captureVisualAttrs(location.clip))
      state.notify('已复制画面属性', 'info')
    },
    pasteVisualAttributes: (ids) => {
      const state = get()
      const attrs = getVisualAttrs()
      if (!attrs || Object.keys(attrs).length === 0) {
        state.notify('剪贴板为空', 'warning')
        return
      }
      const targets = resolvePasteTargets(state, ids)
      if (targets.length === 0) {
        state.notify('没有可粘贴的片段', 'warning')
        return
      }
      // 先干跑一次拿统计（命令本身是纯函数）。
      const preview = applyAttributePatch(state.project, targets, attrs as Partial<Clip>)
      if (preview.applied === 0) {
        state.notify('目标片段在锁定轨道上，未粘贴', 'warning')
        return
      }
      if (run(createPasteVisualAttributesCommand(targets, attrs))) {
        state.notify(`已粘贴到 ${preview.applied} 个片段`, 'success')
      }
    },
    copyAudioAttributes: (clipId) => {
      const state = get()
      const location = findClipLocation(state.project, clipId)
      if (!location) {
        state.notify('没有可复制的片段', 'warning')
        return
      }
      setAudioAttrs(captureAudioAttrs(location.clip))
      state.notify('已复制音频属性', 'info')
    },
    pasteAudioAttributes: (ids) => {
      const state = get()
      const attrs = getAudioAttrs()
      if (!attrs || Object.keys(attrs).length === 0) {
        state.notify('剪贴板为空', 'warning')
        return
      }
      const targets = resolvePasteTargets(state, ids)
      if (targets.length === 0) {
        state.notify('没有可粘贴的片段', 'warning')
        return
      }
      const preview = applyAttributePatch(state.project, targets, attrs as Partial<Clip>)
      if (preview.applied === 0) {
        state.notify('目标片段在锁定轨道上，未粘贴', 'warning')
        return
      }
      if (run(createPasteAudioAttributesCommand(targets, attrs))) {
        state.notify(`已粘贴到 ${preview.applied} 个片段`, 'success')
      }
    },
    copySpeedAttributes: (clipId) => {
      const state = get()
      const location = findClipLocation(state.project, clipId)
      if (!location) {
        state.notify('没有可复制的片段', 'warning')
        return
      }
      if (!canChangeClipSpeed(location.clip)) {
        state.notify('定格 / 图片片段没有变速属性', 'warning')
        return
      }
      setSpeedAttrs(captureSpeedAttrs(location.clip))
      state.notify('已复制变速属性', 'info')
    },
    pasteSpeedAttributes: (ids) => {
      const state = get()
      const attrs = getSpeedAttrs()
      if (!attrs || Object.keys(attrs).length === 0) {
        state.notify('变速剪贴板为空', 'warning')
        return
      }
      const targets = resolvePasteTargets(state, ids).filter((id) => {
        const location = findClipLocation(state.project, id)
        return Boolean(location && canChangeClipSpeed(location.clip))
      })
      if (targets.length === 0) {
        state.notify('目标片段不支持变速（定格 / 图片是静帧）', 'warning')
        return
      }
      // 先干跑一次拿统计（命令本身是纯函数）。
      const preview = applyAttributePatch(state.project, targets, speedAttrsPatch(attrs))
      if (preview.applied === 0) {
        state.notify('目标片段在锁定轨道上，未粘贴', 'warning')
        return
      }
      if (run(createPasteSpeedAttributesCommand(targets, attrs))) {
        state.notify(`已粘贴变速属性到 ${preview.applied} 个片段`, 'success')
      }
    },
    deleteSelectedClip: () => {
      const state = get()
      // 多选：一次命令批量删除（锁定轨道上的片段跳过）。
      if (state.selectedIds.length > 1) {
        const deletable = state.selectedIds.filter((id) => {
          const video = findClipLocation(state.project, id)
          if (video) {
            return !(video.track
              ? isOverlayLocked(video.track)
              : isMainLocked(state.project))
          }
          const audio = findAudioClipLocation(state.project, id)
          if (audio) return !isAudioLocked(audio.track)
          const text = findTextClipLocation(state.project, id)
          if (text) return !isTextLocked(text.track)
          return false
        })
        if (deletable.length === 0) return
        if (run(createDeleteManyCommand(deletable))) {
          get().notify(`已删除 ${deletable.length} 个片段`, 'info')
        }
        return
      }
      const audio = findAudioClipLocation(state.project, state.selectedClipId)
      if (audio) {
        get().deleteAudioClip(audio.track.id, audio.clip.id)
        return
      }
      const text = findTextClipLocation(state.project, state.selectedClipId)
      if (text) {
        get().deleteTextClip(text.track.id, text.clip.id)
        return
      }
      const location = findClipLocation(state.project, state.selectedClipId)
      if (!location) return
      if (location.track ? isOverlayLocked(location.track) : isMainLocked(state.project)) {
        return
      }
      if (location.track) {
        const track = location.track
        const index = track.clips.findIndex((clip) => clip.id === location.clip.id)
        const nextSelection =
          track.clips[index + 1]?.id ??
          track.clips[index - 1]?.id ??
          state.project.clips[0]?.id ??
          null
        if (run(createDeleteOverlayClipCommand(track.id, location.clip.id, nextSelection))) {
          get().notify('已删除叠加片段', 'info')
        }
        return
      }
      const clip = location.clip
      if (state.project.clips.length === 0) return
      const index = state.project.clips.findIndex((item) => item.id === clip.id)
      const nextSelection =
        state.project.clips[index + 1]?.id ?? state.project.clips[index - 1]?.id ?? null
      if (run(createDeleteClipCommand(clip.id, nextSelection))) {
        get().notify('已删除片段', 'info')
      }
    },
  }
}
