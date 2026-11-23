import type { AudioClip, Clip, MediaAsset } from '../../core/types'
import { createId } from '../../core/ids'
import { createInitialProject } from '../../core/operations'
import { projectNameFromSource } from '../../core/projectLibrary'
import { isAssetReferenced, unusedAssets, assetKindOf } from '../../core/assets'
import { createRemoveAssetClipsCommand, createAddAudioClipCommand, createAddClipCommand, createAddClipToNewOverlayTrackCommand } from '../../core/commands'
import { resolveAssetPlacement } from '../../core/assetPlacement'
import type { AssetPlacementIntent } from '../../core/assetPlacement'
import { IMAGE_DEFAULT_DURATION } from '../../core/image'
import type { EditorState } from '../editorStore'
import type { StoreGet, StoreInternals, StoreSet } from '../internal'


/** assets slice：素材库、主素材、待回收素材与倒放任务状态 */
export type AssetsSlice = Pick<EditorState, 'source' | 'assets' | 'pendingReclaim' | 'reverseJob' | 'loadSource' | 'addAssets' | 'removeAsset' | 'cleanupUnusedAssets' | 'disposePendingAssets' | 'addAssetToTimeline' | 'updateSourceMeta' | 'cancelReverse'>

export function createAssetsSlice(ctx: {
  get: StoreGet
  set: StoreSet
  internals: StoreInternals
}): AssetsSlice {
  const { get, set, internals } = ctx
  /** 改动工程 / 素材回收 / 换项目时的倒放清理都在内核里，slice 只做接线。 */
  const { run, reconcilePendingAssets, cancelReverseForProjectSwap } = internals
  return {
    source: null,
    assets: [],
    pendingReclaim: {},
    reverseJob: null,
    loadSource: (source) => {
      cancelReverseForProjectSwap()
      const asset: MediaAsset = { ...source, id: createId('asset') }
      const project = createInitialProject(source, createId('clip'))
      internals.resetHistory(project)
      set({
        source: asset,
        assets: [asset],
        project,
        // 新会话 = 新项目：分配 id，项目名取主素材名。
        projectId: createId('project'),
        projectName: projectNameFromSource(source.name),
        projectNameEdited: false,
        selectedClipId: project.clips[0]?.id ?? null,
        // 必须同时重置多选：否则上一个项目的 id 会残留，复制/删除会用到失效 id。
        selectedIds: project.clips[0]?.id ? [project.clips[0].id] : [],
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
    },
    addAssets: (incoming) => {
      if (incoming.length === 0) return
      const current = get()
      const merged = [...current.assets]
      for (const asset of incoming) {
        if (!merged.some((item) => item.url === asset.url)) merged.push(asset)
      }
      if (current.assets.length === 0 && current.project.clips.length === 0) {
        const primary = merged.find((asset) => asset.kind !== 'audio')
        if (!primary) {
          set({ assets: merged, source: null })
          current.notify(
            incoming.length === 1
              ? `已导入音频「${incoming[0].name}」；再导入视频即可开始剪辑`
              : `已导入 ${incoming.length} 个素材；再导入视频即可开始剪辑`,
            'success',
          )
          return
        }
        const project = createInitialProject(primary, createId('clip'), primary.kind)
        internals.resetHistory(project)
        set({
          source: primary,
          assets: merged,
          project,
          // 第一次导入素材即成为新项目：分配 id，名字跟随主素材。
          projectId: current.projectId ?? createId('project'),
          projectName: current.projectNameEdited
            ? current.projectName
            : projectNameFromSource(primary.name),
          selectedClipId: project.clips[0]?.id ?? null,
          playhead: 0,
          isPlaying: false,
          cropSession: null,
          previewPatch: null,
          asrWordsBySource: null,
          lastAction: '',
        })
        current.notify(`已导入素材「${primary.name}」`, 'success')
        return
      }
      const nextSource =
        current.source ?? merged.find((asset) => asset.kind !== 'audio') ?? null
      set({
        assets: merged,
        source: nextSource,
        // 空会话里只导入音频时也要有一个项目身份；名字仍跟随主素材（若有）。
        projectId:
          current.projectId ??
          (nextSource || merged.length > 0 ? createId('project') : null),
        projectName:
          current.projectNameEdited || !nextSource
            ? current.projectName
            : projectNameFromSource(nextSource.name),
      })
      current.notify(
        incoming.length === 1 ? `已导入素材「${incoming[0].name}」` : `已导入 ${incoming.length} 个素材`,
        'success',
      )
    },
    removeAsset: (assetId, options) => {
      const state = get()
      const asset = state.assets.find((item) => item.id === assetId)
      if (!asset) return
      const referenced = isAssetReferenced(state.project, asset)
      const removedClips = options.removeClips && referenced

      // 先删片段（1 步撤销）。素材本身不在撤销历史里，所以这里**不销毁**它：
      // 只标记成待回收并从素材库隐藏，revoke / 删 blob 等到历史栈不再引用时再做
      // （见 reconcilePendingAssets），这样 Ctrl+Z 回来的片段仍然有可用的源。
      if (removedClips) {
        run(createRemoveAssetClipsCommand({ url: asset.url, assetId: asset.id }))
      }

      const current = get()
      const indexAtDelete = Math.max(
        0,
        current.assets.findIndex((item) => item.id === assetId),
      )
      const assets = current.assets.filter((item) => item.id !== assetId)
      const nextSource =
        current.source?.url === asset.url
          ? assets.find((item) => item.kind !== 'audio') ?? null
          : current.source
      set({
        assets,
        source: nextSource,
        pendingReclaim: {
          ...current.pendingReclaim,
          [assetId]: {
            asset,
            indexAtDelete,
            projectId: state.projectId,
            removedClips,
            deletedAt: Date.now(),
          },
        },
      })
      // 如果它已经没有任何引用（含历史栈），这里立刻回收；否则先挂着等撤销窗口关闭。
      reconcilePendingAssets()
      state.notify(`已删除素材「${asset.name}」，撤销可恢复`, 'info')
    },
    cleanupUnusedAssets: () => {
      const state = get()
      const unused = unusedAssets(state.project, state.assets)
      if (unused.length === 0) {
        state.notify('没有未使用的素材', 'info')
        return
      }
      const unusedIds = new Set(unused.map((asset) => asset.id))
      const assets = state.assets.filter((asset) => !unusedIds.has(asset.id))
      const source =
        state.source && unused.some((asset) => asset.url === state.source?.url)
          ? assets.find((asset) => asset.kind !== 'audio') ?? null
          : state.source
      // 同样只标记待回收：如果被清理的素材还留在撤销历史里（例如刚删过引用它的片段），
      // 撤销后片段还能恢复，立刻删 blob 会造出坏片段。
      const pendingReclaim = { ...state.pendingReclaim }
      unused.forEach((asset) => {
        pendingReclaim[asset.id] = {
          asset,
          indexAtDelete: Math.max(
            0,
            state.assets.findIndex((item) => item.id === asset.id),
          ),
          projectId: state.projectId,
          // 这些素材本来就没有片段引用，不存在「撤销把片段带回来」的恢复。
          removedClips: false,
          deletedAt: Date.now(),
        }
      })
      set({ assets, source, pendingReclaim })
      reconcilePendingAssets()
      state.notify(`已清理 ${unused.length} 个未使用素材`, 'success')
    },
    disposePendingAssets: () => {
      // 切/关项目、组件卸载：历史栈随后被丢弃，不可能再撤销回来，直接全部回收。
      reconcilePendingAssets({ force: true })
    },
    addAssetToTimeline: (assetId, intent) => {
      const state = get()
      const asset = state.assets.find((item) => item.id === assetId)
      if (!asset) return
      // 防御：旧调用点若还传 (assetId, trackId, start)，第二个参数会是字符串/null。
      // 这种情况按「自动落点」处理，绝不能把它当 trackId 去查轨道（会误报「已锁定」）。
      const normalizedIntent: AssetPlacementIntent =
        intent && typeof intent === 'object' && 'kind' in intent
          ? intent
          : { kind: 'auto', time: typeof intent === 'number' ? intent : state.playhead }
      // 落点规则集中在 core/assetPlacement（纯函数），store 只负责执行命令。
      const placement = resolveAssetPlacement(state.project, asset, normalizedIntent)
      if (placement.target === 'blocked') {
        state.notify(placement.message, 'warning')
        return
      }
      const kind = assetKindOf(asset)

      if (placement.target === 'audio') {
        const clip: AudioClip = {
          id: createId('audio'),
          sourceUrl: asset.url,
          sourceStart: 0,
          sourceEnd: Math.max(0.1, asset.duration ?? 0),
          start: placement.start,
          volume: 1,
          fadeIn: 0,
          fadeOut: 0,
        }
        const changed = placement.trackId
          ? run(createAddAudioClipCommand(placement.trackId, clip))
          : run(createAddAudioClipCommand(createId('audioTrack'), clip, placement.newTrackName))
        if (changed) {
          get().selectClip(clip.id)
          get().notify(placement.message, 'success')
        }
        return
      }

      const isImage = kind === 'image'
      const clip: Clip = {
        id: createId('clip'),
        sourceUrl: asset.url,
        sourceStart: 0,
        sourceEnd: isImage ? IMAGE_DEFAULT_DURATION : Math.max(0.1, asset.duration ?? 0),
        type: isImage ? 'image' : 'video',
        rotation: 0,
        flipH: false,
        flipV: false,
        crop: { x: 0, y: 0, w: 1, h: 1 },
        scale: 1,
        position: { x: 0, y: 0 },
        volume: isImage ? 0 : 1,
      }
      const changed =
        placement.target === 'main'
          ? run(createAddClipCommand(clip, null, placement.start))
          : placement.trackId
            ? run(createAddClipCommand(clip, placement.trackId, placement.start))
            : run(
                createAddClipToNewOverlayTrackCommand(
                  createId('overlayTrack'),
                  placement.newTrackName ?? '叠加轨',
                  clip,
                  placement.start,
                ),
              )
      if (changed) {
        get().selectClip(clip.id)
        get().notify(placement.message, 'success')
      }
    },
    updateSourceMeta: (patch) => {
      const source = get().source
      if (!source) return
      set({
        source: { ...source, ...patch },
        assets: get().assets.map((asset) =>
          asset.url === source.url ? { ...asset, ...patch } : asset,
        ),
      })
    },
    cancelReverse: () => {
      if (!get().reverseJob) return
      internals.getReverseController()?.abort()
      get().notify('正在取消倒放（当前分段结束后停止）…', 'info')
    },
  }
}
