import {
  BACKGROUND_TYPES,
  backgroundBlurAmount,
  BLUR_MAX,
  BLUR_MIN,
  DEFAULT_BACKGROUND,
  DEFAULT_BACKGROUND_COLOR,
  normalizeBackground,
  projectBackground,
} from '../core/background'
import type { CanvasBackground } from '../core/types'
import { useEditorStore } from '../store/EditorProvider'
import { CommitNumber } from './Toast'
import { CommitSlider } from './CommitSlider'

/**
 * 画布背景设置（无选中片段时展示，也可从顶栏入口打开）。
 * 修改作用于工程级背景；「应用到全部」会把同一份背景写到所有片段上，
 * 清掉片段级覆盖，避免逐段不一致。
 */
export function CanvasBackgroundPanel() {
  const project = useEditorStore((state) => state.project)
  const setCanvasBackground = useEditorStore((state) => state.setCanvasBackground)
  const applyBackgroundToAll = useEditorStore((state) => state.applyBackgroundToAll)
  const setPreviewPatch = useEditorStore((state) => state.setPreviewPatch)

  const background = projectBackground(project)
  const blur = backgroundBlurAmount(background)

  const update = (patch: Partial<CanvasBackground>) => {
    setCanvasBackground(normalizeBackground({ ...background, ...patch }))
  }

  return (
    <aside className="properties-panel" aria-label="画布背景">
      <div className="panel-head">
        <div>
          <p className="panel-eyebrow">画布</p>
          <h2>
            背景
            <span className="panel-index">未选中片段时设置</span>
          </h2>
        </div>
      </div>

      <div className="panel-scroll">
        <section className="panel-section">
          <div className="section-title">
            <span>填充方式</span>
          </div>
          <div className="background-choices">
            {BACKGROUND_TYPES.map((item) => (
              <button
                key={item.value}
                type="button"
                className={`background-choice${background.type === item.value ? ' is-active' : ''}`}
                aria-pressed={background.type === item.value}
                onClick={() => update({ type: item.value })}
              >
                {item.label}
              </button>
            ))}
          </div>

          {background.type === 'color' && (
            <label className="color-field">
              <span>颜色</span>
              <input
                type="color"
                value={background.color ?? DEFAULT_BACKGROUND_COLOR}
                aria-label="背景颜色"
                onChange={(event) => update({ color: event.target.value })}
              />
            </label>
          )}

          {background.type === 'blur' && (
            <div className="control-with-field">
              <CommitSlider
                value={blur}
                min={BLUR_MIN}
                max={BLUR_MAX}
                step={1}
                ariaLabel="背景模糊强度"
                onPreview={(value) =>
                  setPreviewPatch({
                    patch: {},
                    canvasBackground: normalizeBackground({ ...background, blurAmount: value }),
                  })
                }
                onCommit={(value) => update({ blurAmount: value })}
                format={(value) => `${Math.round(value)}px`}
              />
              <CommitNumber
                value={Math.round(blur)}
                min={BLUR_MIN}
                max={BLUR_MAX}
                step={1}
                unit="px"
                ariaLabel="背景模糊强度数值"
                onPreview={(value) =>
                  setPreviewPatch({
                    patch: {},
                    canvasBackground: normalizeBackground({ ...background, blurAmount: value }),
                  })
                }
                onCommit={(value) => update({ blurAmount: value })}
              />
            </div>
          )}

          <p className="control-note">
            黑场为默认值；模糊会用每个片段自身的画面放大填充并高斯模糊。
            图片背景尚未实现，旧工程里的图片背景会按黑色导出。
          </p>
        </section>

        <section className="panel-section">
          <div className="inline-actions">
            <button
              type="button"
              className="button mini"
              onClick={() => applyBackgroundToAll(background)}
              title="把当前背景写入所有片段，并清掉片段级覆盖"
            >
              应用到全部
            </button>
            <button
              type="button"
              className="button mini"
              onClick={() => {
                setCanvasBackground(DEFAULT_BACKGROUND)
                applyBackgroundToAll(DEFAULT_BACKGROUND)
              }}
            >
              恢复黑色
            </button>
          </div>
        </section>
      </div>
    </aside>
  )
}