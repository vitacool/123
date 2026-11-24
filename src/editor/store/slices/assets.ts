import type { AudioClip, Clip, MediaAsset } from '../../core/types'
import { createId } from '../../core/ids'
import { createInitialProject } from '../../core/operations'
import { projectNameFromSource } from '../../core/projectLibrary'
import { isAssetReferenced, unusedAssets, assetKindOf, normalizeAssetFolder } from '../../core/assets'
import { createRemoveAssetClipsCommand, createAddAudioClipCommand, createAddClipCommand, createAddClipToNewOverlayTrackCommand, createRelinkAssetCommand, createReplaceAudioSourceCommand, createReverseAudioClipCommand } from '../../core/commands'
import { reverseAudioAsset } from '../../services/reverseAudio'
import { readAssetFile } from '../../services/assetReader'
import { persistImportedAssets } from '../../services/draftStore'
import { resolveAssetPlacement } from '../../core/assetPlacement'
import type { AssetPlacementIntent } from '../../core/assetPlacement'
import { IMAGE_DEFAULT_DURATION } from '../../core/image'
import type { EditorState } from '../editorStore'
import type { StoreGet, StoreInternals, StoreSet } from '../internal'


/** assets slice：素材库、主素材、待回收素材与倒放任务状态 */
export type AssetsSlice = Pick<EditorState, 'source' | 'assets' | 'missingAssets' | 'pendingReclaim' | 'reverseJob' | 'loadSource' | 'addAssets' | 'removeAsset' | 'relinkMissingAsset' | 'replaceAudioClipSource' | 'reverseAudioClip' | 'updateAssetThumbnail' | 'renameAsset' | 'setAssetFolder' | 'cleanupUnusedAssets' | 'disposePendingAssets' | 'addAssetToTimeline' | 'updateSourceMeta' | 'cancelReverse'>

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
    missingAssets: [],
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
        // 新会话没有占位素材（占位只在「载入工程」时由缺失素材产生）。
        missingAssets: [],
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
        exportRangeRaw: null,
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
          /**
           * 空会话里**只导入音频**：也要分配 projectId，否则 `buildDraftRecord` 返回 null，
           * 保存被整体跳过 —— 刷新/关标签页后音频素材和已经写进 IndexedDB 的 blob 全丢
           * （界面还提示「再导入视频即可开始剪辑」）。与下面"追加素材"分支保持一致。
           */
          set({
            assets: merged,
            source: null,
            projectId: current.projectId ?? createId('project'),
            projectName: current.projectNameEdited
              ? current.projectName
              : projectNameFromSource(merged[0]?.name ?? ''),
          })
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
          missingAssets: [],
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
      // 意图（用户点了什么）与观察（此刻是否还有引用）必须分开记录，见 PendingReclaimEntry。
      const removeClips = Boolean(options.removeClips)
      const clipsRemovedNow = removeClips && referenced

      // 先删片段（1 步撤销）。素材本身不在撤销历史里，所以这里**不销毁**它：
      // 只标记成待回收并从素材库隐藏，revoke / 删 blob 等到历史栈不再引用时再做
      // （见 reconcilePendingAssets），这样 Ctrl+Z 回来的片段仍然有可用的源。
      if (clipsRemovedNow) {
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
      const nextMissingAssets = removeClips
        ? // 连带删片段后，这个素材不再需要占位记录。
          current.missingAssets.filter((item) => item.url !== asset.url)
        : referenced
          ? [
              // 「仅从素材库移除」必须把素材写进 missingAssets：占位片段的
              // 存活依据是 missingAssets，不是 pendingReclaim（后者只活在本会话，
              // 刷新就没了）。不写的话，重载时 pruneProjectUrls 会把引用它的
              // 片段全部剔掉——用户看到的「片段变空白」会在刷新后直接消失。
              ...current.missingAssets.filter((item) => item.url !== asset.url),
              {
                url: asset.url,
                name: asset.name,
                kind: assetKindOf(asset),
                duration: asset.duration,
              },
            ]
          : current.missingAssets
      set({
        assets,
        source: nextSource,
        missingAssets: nextMissingAssets,
        pendingReclaim: {
          ...current.pendingReclaim,
          [assetId]: {
            asset,
            indexAtDelete,
            projectId: state.projectId,
            removedClips: removeClips,
            referencedAtDelete: referenced,
            deletedAt: Date.now(),
          },
        },
      })
      // 如果它已经没有任何引用（含历史栈），这里立刻回收；否则先挂着等撤销窗口关闭。
      reconcilePendingAssets()
      state.notify(
        removeClips
          ? `已删除素材「${asset.name}」及关联片段，撤销可恢复`
          : `已删除素材「${asset.name}」，片段保留为占位`,
        'info',
      )
    },
    /**
     * 重新链接缺失素材：把工程里所有引用 `url` 的地方改到新读入的素材上。
     * 片段入出点、关键帧、音量都保留，只换源；成功后落盘 Blob。
     * 旧的 missingAssets 记录会保留到下一次草稿恢复时由引用关系自动清理，
     * 这样撤销重链后片段仍然有占位依据（不会被当成无主片段剔除）。
     */
    relinkMissingAsset: async (url, file) => {
      if (!get().missingAssets.some((item) => item.url === url)) {
        get().notify('该素材已不需要重新链接', 'info')
        return false
      }
      let asset: MediaAsset
      try {
        asset = await readAssetFile(file, {
          onTranscodeStatus: (status) => get().notify(status, 'info'),
        })
      } catch (error) {
        get().notify(
          `读取素材失败：${error instanceof Error ? error.message : String(error)}`,
          'error',
        )
        return false
      }
      // 先把新素材放进 assets，再跑命令：run 内部会按「URL → assetId」重建
      // 字幕联动，若此时还找不到新素材的 URL，link.assetId 会被当成陌生 key，
      // 关联字幕可能被判成「来源片段已删除」而删掉。
      const previousAssets = get().assets
      set({
        assets: [
          ...previousAssets.filter(
            (item) => item.id !== asset.id && item.url !== asset.url,
          ),
          asset,
        ],
      })
      if (!run(createRelinkAssetCommand(url, asset.url, asset.id))) {
        set({ assets: previousAssets })
        URL.revokeObjectURL(asset.url)
        get().notify('重新链接失败：工程里没有引用该素材的位置', 'warning')
        return false
      }
      const current = get()
      const currentSource = current.source
      const nextSource =
        currentSource?.url === url
          ? asset
          : // 原来主素材就是这条缺失素材（删除后 source 变 null）时，重链成功后要
            // 重新把它接回 source，否则预览/导出会缺主素材尺寸。
            (currentSource ?? (assetKindOf(asset) === 'audio' ? null : asset))
      set({
        source: nextSource,
        // 这里**故意保留**旧的 missingAssets 记录：重链是进历史的，
        // 用户撤销后片段会重新指向旧 URL。若此刻删掉记录，下一次加载
        // pruneProjectUrls 会把撤销回来的片段当成无主片段剔掉（丢工作）。
        // 未引用的记录会在 restoreDraft 的 filterReferencedMissingAssets 里自动清掉。
      })
      // 新素材 Blob 必须立刻落盘：否则刷新后占位又会回来。
      await persistImportedAssets([asset], { notify: get().notify })
      // 旧 URL 已经没人引用，待回收素材可以真正释放了。
      reconcilePendingAssets()
      get().notify(`已重新链接「${asset.name}」`, 'success')
      return true
    },
    updateAssetThumbnail: (assetId, thumbnail) => {
      const state = get()
      const asset = state.assets.find((item) => item.id === assetId)
      if (!asset) return
      set({
        assets: state.assets.map((item) =>
          item.id === assetId ? { ...item, thumbnail } : item,
        ),
        source:
          state.source && state.source.url === asset.url
            ? { ...state.source, thumbnail }
            : state.source,
      })
    },
    renameAsset: (assetId, name) => {
      const state = get()
      const asset = state.assets.find((item) => item.id === assetId)
      if (!asset) return
      const nextName = name.trim().slice(0, 200)
      if (!nextName || nextName === asset.name) return
      set({
        assets: state.assets.map((item) =>
          item.id === assetId ? { ...item, name: nextName } : item,
        ),
        source:
          state.source && state.source.url === asset.url
            ? { ...state.source, name: nextName }
            : state.source,
      })
      get().notify(`已重命名素材为「${nextName}」`, 'success')
    },
    replaceAudioClipSource: async (trackId, clipId, file) => {
      let asset: MediaAsset
      try {
        asset = await readAssetFile(file, {
          onTranscodeStatus: (status) => get().notify(status, 'info'),
        })
      } catch (error) {
        get().notify(
          `读取素材失败：${error instanceof Error ? error.message : String(error)}`,
          'error',
        )
        return false
      }
      const previousAssets = get().assets
      if (!previousAssets.some((item) => item.url === asset.url || item.id === asset.id)) {
        set({ assets: [...previousAssets, asset] })
      }
      if (
        !run(
          createReplaceAudioSourceCommand(trackId, clipId, asset.url, asset.duration),
        )
      ) {
        set({ assets: previousAssets })
        URL.revokeObjectURL(asset.url)
        get().notify('替换失败：目标音频片段不存在或已被删除', 'warning')
        return false
      }
      await persistImportedAssets([asset], { notify: get().notify })
      get().notify(`已把音频片段替换为「${asset.name}」`, 'success')
      return true
    },
    reverseAudioClip: async (trackId, clipId) => {
      const state = get()
      const track = (state.project.audioTracks ?? []).find((item) => item.id === trackId)
      const clip = track?.clips.find((item) => item.id === clipId)
      if (!track || !clip) {
        get().notify('目标音频片段不存在', 'warning')
        return false
      }
      const asset = state.assets.find((item) => item.url === clip.sourceUrl)
      if (!asset || asset.kind !== 'audio' || !(asset.duration > 0)) {
        get().notify('找不到原音频素材或时长未知，无法倒放', 'warning')
        return false
      }
      let file: File
      try {
        file = await reverseAudioAsset(asset, {
          onStatus: (message) => get().notify(message, 'info'),
        })
      } catch (error) {
        const cancelled =
          error instanceof Error && error.name === 'AbortError'
        get().notify(
          cancelled
            ? '已取消音频倒放'
            : `音频倒放失败：${error instanceof Error ? error.message : String(error)}`,
          cancelled ? 'info' : 'error',
        )
        return false
      }
      const url = URL.createObjectURL(file)
      const reversedAsset: MediaAsset = {
        id: createId('asset'),
        url,
        name: file.name,
        size: file.size,
        duration: asset.duration,
        width: 0,
        height: 0,
        kind: 'audio',
        file,
        hasAudio: true,
      }
      const previousAssets = get().assets
      set({ assets: [...previousAssets, reversedAsset] })
      if (
        !run(
          createReverseAudioClipCommand(trackId, clipId, url, asset.duration),
        )
      ) {
        set({ assets: previousAssets })
        URL.revokeObjectURL(url)
        get().notify('音频倒放失败：片段已被删除', 'warning')
        return false
      }
      await persistImportedAssets([reversedAsset], { notify: get().notify })
      get().notify('已生成倒放音频并替换片段', 'success')
      return true
    },
    setAssetFolder: (assetId, folder) => {
      const state = get()
      const asset = state.assets.find((item) => item.id === assetId)
      if (!asset) return
      const next = normalizeAssetFolder(folder)
      if (normalizeAssetFolder(asset.folder) === next) return
      set({
        assets: state.assets.map((item) =>
          item.id === assetId ? { ...item, folder: next || undefined } : item,
        ),
      })
      get().notify(next ? `已移到文件夹「${next}」` : '已移出文件夹', 'success')
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
          referencedAtDelete: false,
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
