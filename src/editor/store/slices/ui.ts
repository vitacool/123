import type { EditorState } from '../editorStore'
import type { StoreGet, StoreInternals, StoreSet } from '../internal'
import { DEFAULT_FRAMECUT_THEME } from '../../core/theme'
import { clearThemeTokenCache } from '../../services/themeTokens'
import { clampMainTrackStart } from '../internal'
import { createRelinkCaptionsCommand } from '../../core/commands'

/** ui slice：主题、提示、面板开关与其它纯界面会话态 */
export type UiSlice = Pick<EditorState, 'theme' | 'resolvedTheme' | 'previewFullscreen' | 'timelineSettings' | 'previewPatch' | 'markerEditorId' | 'coverPreview' | 'coverPanelOpen' | 'toast' | 'asrWordsBySource' | 'captionApplyAll' | 'captionFollow' | 'captionStylePreview' | 'setPreviewFullscreen' | 'toggleTimelineSetting' | 'setPreviewPatch' | 'togglePreviewMuteSegmentedSpeed' | 'setTheme' | 'setResolvedTheme' | 'openCoverPanel' | 'closeCoverPanel' | 'setCoverPreview' | 'setAsrWordsBySource' | 'setCaptionApplyAll' | 'setCaptionFollow' | 'setCaptionStylePreview' | 'openMarkerEditor' | 'closeMarkerEditor' | 'notify' | 'clearToast'>

export function createUiSlice(ctx: {
  get: StoreGet
  set: StoreSet
  internals: StoreInternals
}): UiSlice {
  const { get, set, internals } = ctx
  // 打开主轨磁吸时的贴齐走命令链（可撤销）
  const run = internals.run
  /** 提示条自增 id（每个 store 一份）。 */
  let toastCounter = 0
  return {
    theme: DEFAULT_FRAMECUT_THEME,
    resolvedTheme: 'light',
    previewFullscreen: false,
    timelineSettings: {
      mainTrackMagnet: false,
      autoSnap: true,
      linkage: false,
      previewAxis: true,
    },
    previewPatch: null,
    markerEditorId: null,
    coverPreview: false,
    coverPanelOpen: false,
    toast: null,
    asrWordsBySource: null,
    captionApplyAll: true,
    captionFollow: true,
    captionStylePreview: null,
    setPreviewFullscreen: (fullscreen) => {
      set({ previewFullscreen: fullscreen })
    },
    toggleTimelineSetting: (key) => {
      const state = get()
      const next = !state.timelineSettings[key]
      set((current) => ({
        timelineSettings: {
          ...current.timelineSettings,
          [key]: next,
        },
      }))
      if (key === 'mainTrackMagnet' && next) {
        const project = get().project
        if (project.clips[0] && (project.clips[0].gapBefore ?? 0) > 0.0001) {
          run({
            label: '主轨首段贴齐',
            selectionAfter: get().selectedClipId,
            execute: (current) => clampMainTrackStart(current),
          })
        }
      }
    },
    setPreviewPatch: (patch) => set({ previewPatch: patch }),
    togglePreviewMuteSegmentedSpeed: () =>
      set((current) => ({ previewMuteSegmentedSpeed: !current.previewMuteSegmentedSpeed })),
    setTheme: (theme) => {
      if (get().theme === theme) return
      set({ theme })
    },
    setResolvedTheme: (theme) => {
      if (get().resolvedTheme === theme) return
      // Canvas 界面元素按主题缓存颜色 token：切换时清掉，随后重绘取新值。
      clearThemeTokenCache()
      set({ resolvedTheme: theme })
    },
    openCoverPanel: () => set({ coverPanelOpen: true }),
    closeCoverPanel: () => set({ coverPanelOpen: false, coverPreview: false }),
    setCoverPreview: (active) => {
      if (get().coverPreview === active) return
      set({ coverPreview: active })
    },
    setAsrWordsBySource: (words) => {
      set({ asrWordsBySource: words })
    },
    setCaptionApplyAll: (applyAll) => {
      set({ captionApplyAll: applyAll })
    },
    setCaptionFollow: (follow) => {
      if (follow === get().captionFollow) return
      set({ captionFollow: follow })
      if (follow) {
        // 开启时立即执行一次 relink，作为一个独立可撤销命令。
        const urlToAssetId = new Map(get().assets.map((asset) => [asset.url, asset.id]))
        run(createRelinkCaptionsCommand(urlToAssetId))
      }
    },
    setCaptionStylePreview: (preview) => {
      set({ captionStylePreview: preview })
    },
    openMarkerEditor: (id) => {
      if (get().project.markers.some((marker) => marker.id === id)) {
        set({ markerEditorId: id, isPlaying: false })
      }
    },
    closeMarkerEditor: () => set({ markerEditorId: null }),
    notify: (message, kind = 'info') => {
      toastCounter += 1
      set({ toast: { id: toastCounter, kind, message } })
    },
    clearToast: () => set({ toast: null }),
  }
}
