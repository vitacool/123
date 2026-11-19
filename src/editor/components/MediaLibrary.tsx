import { formatPlayhead } from '../core/format'
import { useEditorStore } from '../store/EditorProvider'
import { Icon } from './Icon'

interface MediaLibraryProps {
  onImport: () => void
  onNewProject: () => void
  onImportSubtitles: () => void
  onAutoCaption: () => void
  onCanvasBackground: () => void
}

export const MEDIA_DRAG_TYPE = 'application/x-framecut-asset'

export function MediaLibrary({
  onImport,
  onNewProject,
  onImportSubtitles,
  onAutoCaption,
  onCanvasBackground,
}: MediaLibraryProps) {
  const assets = useEditorStore((state) => state.assets)
  const playhead = useEditorStore((state) => state.playhead)
  const addAssetToTimeline = useEditorStore((state) => state.addAssetToTimeline)

  return (
    <aside className="media-library" aria-label="素材库">
      <div className="media-library-head">
        <div>
          <span className="media-library-kicker">素材库</span>
          <span className="media-library-count">{assets.length} 个素材</span>
        </div>
      </div>
      <div className="media-library-actions">
        <button
          type="button"
          className="button mini media-action"
          onClick={onImport}
          title="导入本地视频或音频"
        >
          <Icon name="upload" size={13} />
          导入素材
        </button>
        <button
          type="button"
          className="button mini media-action"
          onClick={onAutoCaption}
          title="用本地 Whisper 识别主轨语音并生成字幕"
        >
          <Icon name="spark" size={13} />
          智能字幕
        </button>
        <button
          type="button"
          className="button mini media-action"
          onClick={onImportSubtitles}
          title="导入 SRT / VTT 字幕"
        >
          <Icon name="text" size={13} />
          导入字幕
        </button>
        <button
          type="button"
          className="button mini media-action"
          onClick={onCanvasBackground}
          title="设置画布背景（黑场 / 纯色 / 模糊填充 / 图片）"
        >
          <Icon name="fill" size={13} />
          背景
        </button>
        <button
          type="button"
          className="button mini media-action"
          onClick={onNewProject}
          title="清除草稿并新建项目"
        >
          <Icon name="plus" size={13} />
          新建项目
        </button>
      </div>
      <div className="media-library-list">
        {assets.length === 0 && (
          <button type="button" className="media-library-empty" onClick={onImport}>
            <span className="media-library-empty-icon">
              <Icon name="film" size={19} />
            </span>
            导入视频素材
            <small>点击或拖到时间轴</small>
          </button>
        )}
        {assets.map((asset) => {
          const audio = asset.kind === 'audio'
          return (
          <button
            key={asset.id}
            type="button"
            className={`media-card${audio ? ' is-audio' : ''}`}
            draggable
            data-asset-id={asset.id}
            title={audio ? `点击添加到音频轨；拖到音频轨\n${asset.name}` : `点击添加到播放头；拖到主轨或叠加轨\n${asset.name}`}
            onClick={() => addAssetToTimeline(asset.id, null, playhead)}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'copy'
              event.dataTransfer.setData(MEDIA_DRAG_TYPE, asset.id)
              event.dataTransfer.setData('text/plain', asset.name)
            }}
          >
            <span
              className="media-card-thumb"
              style={
                !audio && asset.thumbnail
                  ? { backgroundImage: `url("${asset.thumbnail}")` }
                  : undefined
              }
            >
              {audio ? (
                <Icon name="music" size={18} />
              ) : (
                !asset.thumbnail && <Icon name="film" size={18} />
              )}
              <span className="media-card-duration">
                {formatPlayhead(asset.duration, 30)}
              </span>
            </span>
            <span className="media-card-copy">
              <strong>{asset.name}</strong>
              <small>{audio ? '音频' : `${asset.width}×${asset.height}`}</small>
            </span>
          </button>
          )
        })}
      </div>
      <p className="media-library-foot">点击添加到播放头 · 拖到任意轨道</p>
    </aside>
  )
}