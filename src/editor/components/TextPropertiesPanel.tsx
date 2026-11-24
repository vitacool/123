import { useEffect, useRef, useState } from 'react'
import {
  CAPTION_STYLE_PRESETS,
  TEXT_SHADOW_ENABLED_DEFAULTS,
  resolveCaptionStyle,
  textClipDuration,
} from '../core/text'
import type { CaptionStyle, TextClip, TextTrack } from '../core/types'
import { colorToHex, recolorKeepingAlpha } from '../core/color'
import { useEditorStore } from '../store/EditorProvider'
import { CommitNumber } from './Toast'
import { CommitSlider } from './CommitSlider'
import { Icon } from './Icon'
import { KeyframeButton } from './KeyframeButton'

interface TextPropertiesPanelProps {
  track: TextTrack
  clip: TextClip
}

export function TextPropertiesPanel({ track, clip }: TextPropertiesPanelProps) {
  const updateTextClip = useEditorStore((state) => state.updateTextClip)
  const setAnimatableValue = useEditorStore((state) => state.setAnimatableValue)
  const updateCaptionStyle = useEditorStore((state) => state.updateCaptionStyle)
  const setCaptionStylePreview = useEditorStore((state) => state.setCaptionStylePreview)
  const deleteTextClip = useEditorStore((state) => state.deleteTextClip)
  const selectClip = useEditorStore((state) => state.selectClip)
  const captionApplyAll = useEditorStore((state) => state.captionApplyAll)
  const setCaptionApplyAll = useEditorStore((state) => state.setCaptionApplyAll)

  const [text, setText] = useState(clip.text)
  const pendingRef = useRef<number | null>(null)
  const committedRef = useRef(clip.text)

  const isCaption = track.kind === 'caption'
  // 合并后生效的样式：clip.styleOverride > track.captionStyle > clip 默认值
  const style = resolveCaptionStyle(clip, track.captionStyle)

  useEffect(() => {
    setText(clip.text)
    committedRef.current = clip.text
  }, [clip.id])

  useEffect(() => {
    return () => {
      if (pendingRef.current !== null) window.clearTimeout(pendingRef.current)
    }
  }, [])

  /** 文本内容写当前片段。 */
  const commit = (update: Partial<Omit<TextClip, 'id'>>, label: string) => {
    updateTextClip(track.id, clip.id, update, label)
  }

  /** 样式字段：字幕轨按 applyAll 路由到组样式或单条覆盖；普通文本轨直接写片段。 */
  const commitStyle = (update: CaptionStyle, label: string) => {
    if (isCaption) {
      updateCaptionStyle(track.id, clip.id, update, captionApplyAll, label)
    } else {
      updateTextClip(track.id, clip.id, update, label)
    }
  }

  const duration = textClipDuration(clip)
  const hasBackground = style.background !== 'transparent'
  const scalePercent = Math.round((clip.scale ?? 1) * 100)
  const opacityPercent = Math.round((clip.opacity ?? 1) * 100)
  const shadowEnabled = Boolean(
    style.shadowColor && style.shadowColor.trim().toLowerCase() !== 'transparent',
  )
  const shadowBlurPercent = Math.round((style.shadowBlur ?? 0) * 1000) / 10
  const shadowOffsetXPercent = Math.round((style.shadowOffsetX ?? 0) * 1000) / 10
  const shadowOffsetYPercent = Math.round((style.shadowOffsetY ?? 0) * 1000) / 10

  const commitText = () => {
    if (pendingRef.current !== null) {
      window.clearTimeout(pendingRef.current)
      pendingRef.current = null
    }
    if (text === committedRef.current) return
    committedRef.current = text
    commit({ text }, '修改文本内容')
  }

  /** 位置：已有关键帧时写当前关键帧；否则仍走组样式/单条覆盖的静态路径。 */
  const commitPosition = (prop: 'position.x' | 'position.y', value: number) => {
    if ((clip.anim?.[prop]?.length ?? 0) > 0) {
      setAnimatableValue(prop, value)
      return
    }
    commitStyle(prop === 'position.x' ? { x: value } : { y: value }, '调整文本位置')
  }

  const previewShadow = (patch: Partial<CaptionStyle>) => {
    setCaptionStylePreview({ trackId: track.id, style: { ...style, ...patch } })
  }

  const commitShadow = (patch: Partial<CaptionStyle>, label: string) => {
    setCaptionStylePreview(null)
    commitStyle(patch, label)
  }

  const setShadowEnabled = (enabled: boolean) => {
    setCaptionStylePreview(null)
    if (enabled) {
      commitStyle({ ...TEXT_SHADOW_ENABLED_DEFAULTS }, '开启文字阴影')
    } else {
      // 必须写 transparent 而不是 undefined，否则组样式里的阴影会重新透出来。
      commitStyle({ shadowColor: 'transparent' }, '关闭文字阴影')
    }
  }

  const updateText = (value: string) => {
    setText(value)
    if (pendingRef.current !== null) window.clearTimeout(pendingRef.current)
    pendingRef.current = window.setTimeout(() => {
      pendingRef.current = null
      if (value === committedRef.current) return
      committedRef.current = value
      commit({ text: value }, '修改文本内容')
    }, 350)
  }

  return (
    <aside className="properties-panel" aria-label="文本属性">
      <div className="panel-head">
        <div>
          <p className="panel-eyebrow">文本属性</p>
          <h2>
            文本片段
            <span className="panel-index">{track.name}</span>
          </h2>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={() => selectClip(null)}
          aria-label="收起属性面板"
          title="收起属性面板"
        >
          <Icon name="close" size={16} />
        </button>
      </div>

      <div className="panel-scroll">
        {isCaption && (
          <section className="panel-section caption-apply-all">
            <label className="caption-apply-all-check">
              <input
                type="checkbox"
                checked={captionApplyAll}
                onChange={(event) => setCaptionApplyAll(event.target.checked)}
              />
              <span>应用到全部字幕</span>
            </label>
            <div className="caption-style-presets" aria-label="字幕样式预设">
              {CAPTION_STYLE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="button mini"
                  onMouseEnter={() => setCaptionStylePreview({ trackId: track.id, style: preset.style })}
                  onMouseLeave={() => setCaptionStylePreview(null)}
                  onClick={() =>
                    updateCaptionStyle(
                      track.id,
                      clip.id,
                      preset.style,
                      true,
                      `应用「${preset.label}」`,
                    )
                  }
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </section>
        )}

        <div className="clip-summary">
          <span className="type-pill text">TEXT</span>
          <span className="summary-duration">{duration.toFixed(1)}s</span>
          <span className="summary-dot" />
          <span className="summary-meta">
            {clip.start.toFixed(1)}s – {clip.end.toFixed(1)}s
          </span>
        </div>

        <section className="panel-section">
          <div className="section-title">
            <span>时间</span>
            <span className="section-hint">秒</span>
          </div>
          <div className="control-with-field">
            <span className="section-hint">开始</span>
            <CommitNumber
              value={Number(clip.start.toFixed(2))}
              min={0}
              max={86400}
              step={0.1}
              unit="s"
              ariaLabel="开始时间"
              onCommit={(value) =>
                updateTextClip(
                  track.id,
                  clip.id,
                  { start: value, end: Math.max(value + 0.2, clip.end) },
                  '修改开始时间',
                )
              }
            />
          </div>
          <div className="control-with-field">
            <span className="section-hint">结束</span>
            <CommitNumber
              value={Number(clip.end.toFixed(2))}
              min={0.2}
              max={86400}
              step={0.1}
              unit="s"
              ariaLabel="结束时间"
              onCommit={(value) =>
                updateTextClip(
                  track.id,
                  clip.id,
                  { end: Math.max(clip.start + 0.2, value) },
                  '修改结束时间',
                )
              }
            />
          </div>
          <p className="control-note">改时间会解除与视频片段的联动（字幕不再跟随）。</p>
        </section>

        <section className="panel-section">
          <div className="section-title">
            <span>内容</span>
            <span className="section-hint">{text.length}/500</span>
          </div>
          <textarea
            className="text-editor-input"
            value={text}
            maxLength={500}
            rows={4}
            placeholder="输入文字，支持换行"
            onChange={(event) => updateText(event.target.value)}
            onBlur={commitText}
          />
        </section>

        <section className="panel-section">
          <div className="section-title">
            <span>字体</span>
            <span className="section-hint">系统字体</span>
          </div>
          <select
            className="text-font-select"
            value={style.fontFamily ?? ''}
            aria-label="文本字体"
            onChange={(event) =>
              commitStyle(
                { fontFamily: event.target.value || undefined },
                '修改文本字体',
              )
            }
          >
            <option value="">系统默认</option>
            <option value='"Microsoft YaHei", "PingFang SC", sans-serif'>黑体 / 雅黑</option>
            <option value='"SimSun", "Songti SC", serif'>宋体</option>
            <option value='"KaiTi", "Kaiti SC", serif'>楷体</option>
            <option value='"SimHei", "Heiti SC", sans-serif'>黑体</option>
            <option value='monospace'>等宽</option>
          </select>
        </section>

        <section className="panel-section">
          <div className="section-title">
            <span>字号</span>
            <span className="section-hint">2% – 20% 画布高度</span>
          </div>
          <div className="control-with-field">
            <CommitSlider
              value={Math.round(style.fontSize * 1000) / 10}
              min={2}
              max={20}
              step={0.5}
              ariaLabel="文本字号"
              onPreview={(value) => {
                // 拖动中走临时预览通道（不写历史）；松手才由 commitStyle 落库。
                setCaptionStylePreview({
                  trackId: track.id,
                  style: { ...style, fontSize: value / 100 },
                })
              }}
              onCommit={(value) => {
                setCaptionStylePreview(null)
                commitStyle({ fontSize: value / 100 }, '调整文本字号')
              }}
              format={(value) => `${Number(value.toFixed(1))}%`}
            />
            <CommitNumber
              value={Math.round(style.fontSize * 1000) / 10}
              min={2}
              max={20}
              step={0.5}
              unit="%"
              ariaLabel="文本字号百分比"
              onCommit={(value) => commitStyle({ fontSize: value / 100 }, '调整文本字号')}
            />
          </div>
        </section>

        <section className="panel-section">
          <div className="section-title">
            <span>排版</span>
            <span className="section-hint">行距 / 字距 / 斜体</span>
          </div>
          <div className="control-with-field">
            <span className="section-hint">行距</span>
            <CommitSlider
              value={Math.round((style.lineHeight ?? 1.26) * 100)}
              min={80}
              max={300}
              step={1}
              ariaLabel="文本行距"
              onPreview={(value) =>
                setCaptionStylePreview({
                  trackId: track.id,
                  style: { ...style, lineHeight: value / 100 },
                })
              }
              onCommit={(value) => {
                setCaptionStylePreview(null)
                commitStyle({ lineHeight: value / 100 }, '调整文本行距')
              }}
              format={(value) => `${Math.round(value)}%`}
            />
          </div>
          <div className="control-with-field">
            <span className="section-hint">字距</span>
            <CommitSlider
              value={Math.round((style.letterSpacing ?? 0) * 100)}
              min={-20}
              max={50}
              step={1}
              ariaLabel="文本字间距"
              onPreview={(value) =>
                setCaptionStylePreview({
                  trackId: track.id,
                  style: { ...style, letterSpacing: value / 100 },
                })
              }
              onCommit={(value) => {
                setCaptionStylePreview(null)
                commitStyle({ letterSpacing: value / 100 }, '调整文本字间距')
              }}
              format={(value) => `${Math.round(value)}%`}
            />
          </div>
          <label className="control-toggle">
            <input
              type="checkbox"
              checked={style.italic === true}
              onChange={(event) => commitStyle({ italic: event.target.checked }, '切换文本斜体')}
            />
            斜体
          </label>
        </section>

        <section className="panel-section">
          <div className="section-title">
            <span>字号 / 缩放</span>
            <span className="section-hint">10% – 400%，叠加在字号上</span>
          </div>
          <div className="control-with-field">
            <CommitSlider
              value={scalePercent}
              min={10}
              max={400}
              step={1}
              ariaLabel="文本缩放"
              onPreview={() => undefined}
              onCommit={(value) => setAnimatableValue('scale', value / 100)}
              format={(value) => `${Math.round(value)}%`}
            />
            <CommitNumber
              value={scalePercent}
              min={10}
              max={400}
              step={1}
              unit="%"
              ariaLabel="文本缩放百分比"
              onCommit={(value) => setAnimatableValue('scale', value / 100)}
            />
            <KeyframeButton prop="scale" clip={clip} />
          </div>
        </section>

        <section className="panel-section">
          <div className="section-title">
            <span>不透明度</span>
            <span className="section-hint">0 – 100%</span>
          </div>
          <div className="control-with-field">
            <CommitSlider
              value={opacityPercent}
              min={0}
              max={100}
              step={1}
              ariaLabel="文本不透明度"
              onPreview={() => undefined}
              onCommit={(value) => setAnimatableValue('opacity', value / 100)}
              format={(value) => `${Math.round(value)}%`}
            />
            <CommitNumber
              value={opacityPercent}
              min={0}
              max={100}
              step={1}
              unit="%"
              ariaLabel="文本不透明度百分比"
              onCommit={(value) => setAnimatableValue('opacity', value / 100)}
            />
            <KeyframeButton prop="opacity" clip={clip} />
          </div>
        </section>

        <section className="panel-section">
          <div className="section-title">
            <span>颜色</span>
            <span className="section-hint">文字 / 背景</span>
          </div>
          <div className="text-color-row">
            <label>
              文字
              <input
                type="color"
                value={style.color}
                aria-label="文字颜色"
                onChange={(event) => commitStyle({ color: event.target.value }, '修改文字颜色')}
              />
            </label>
            <span className="text-color-value">{style.color}</span>
            <label>
              背景
              <input
                type="checkbox"
                checked={hasBackground}
                onChange={(event) =>
                  commitStyle(
                    {
                      background: event.target.checked
                        ? 'rgba(0, 0, 0, 0.55)'
                        : 'transparent',
                    },
                    event.target.checked ? '开启文字背景' : '关闭文字背景',
                  )
                }
              />
            </label>
            {hasBackground && (
              <input
                type="color"
                value={style.background.startsWith('#') ? style.background : '#000000'}
                aria-label="文字背景颜色"
                onChange={(event) =>
                  commitStyle(
                    {
                      background: event.target.value,
                    },
                    '修改文字背景',
                  )
                }
              />
            )}
          </div>
          <div className="text-color-presets" aria-label="常用文字颜色">
            {['#ffffff', '#ffd84d', '#ff5a4e', '#111111', '#5ad1ff'].map((color) => (
              <button
                key={color}
                type="button"
                className={`text-color-swatch${style.color === color ? ' is-active' : ''}`}
                style={{ background: color }}
                aria-label={`文字颜色 ${color}`}
                title={color}
                onClick={() => commitStyle({ color }, '修改文字颜色')}
              />
            ))}
          </div>
        </section>

        <section className="panel-section">
          <div className="section-title">
            <span>描边</span>
            <span className="section-hint">0 为关闭</span>
          </div>
          <div className="text-color-row">
            <label>
              颜色
              <input
                type="color"
                value={style.strokeColor ?? '#000000'}
                aria-label="描边颜色"
                onChange={(event) =>
                  commitStyle(
                    {
                      strokeColor: event.target.value,
                      strokeWidth:
                        style.strokeWidth && style.strokeWidth > 0
                          ? style.strokeWidth
                          : 0.06,
                    },
                    '修改描边颜色',
                  )
                }
              />
            </label>
            <CommitNumber
              value={Math.round((style.strokeWidth ?? 0) * 1000) / 10}
              min={0}
              max={15}
              step={0.5}
              unit="%"
              ariaLabel="描边宽度"
              onCommit={(value) =>
                commitStyle(
                  {
                    strokeWidth: value / 100,
                    strokeColor: style.strokeColor ?? '#000000',
                  },
                  value > 0 ? '开启描边' : '关闭描边',
                )
              }
            />
          </div>
        </section>

        <section className="panel-section">
          <div className="section-title">
            <span>阴影</span>
            <span className="section-hint">模糊 / 偏移按字号比例</span>
          </div>
          <div className="text-color-row">
            <label>
              <input
                type="checkbox"
                checked={shadowEnabled}
                aria-label="启用文字阴影"
                onChange={(event) => setShadowEnabled(event.target.checked)}
              />
              <span>启用阴影</span>
            </label>
            {shadowEnabled && (
              <label>
                颜色
                <input
                  type="color"
                  value={colorToHex(style.shadowColor, '#000000')}
                  aria-label="阴影颜色"
                  onChange={(event) =>
                    // 颜色选择器没有 alpha：保留原有不透明度，否则 rgba(0,0,0,0.55)
                    // 会被写成不透明的 #rrggbb，阴影突然变重。
                    commitShadow(
                      { shadowColor: recolorKeepingAlpha(event.target.value, style.shadowColor, 0.55) },
                      '修改阴影颜色',
                    )
                  }
                />
              </label>
            )}
            {shadowEnabled && <span className="text-color-value">{style.shadowColor}</span>}
          </div>
          {shadowEnabled && (
            <>
              <div className="control-with-field">
                <span className="section-hint">模糊</span>
                <CommitSlider
                  value={shadowBlurPercent}
                  min={0}
                  max={20}
                  step={0.5}
                  ariaLabel="阴影模糊"
                  onPreview={(value) => previewShadow({ shadowBlur: value / 100 })}
                  onCommit={(value) =>
                    commitShadow({ shadowBlur: value / 100 }, '调整阴影模糊')
                  }
                  format={(value) => `${Number(value.toFixed(1))}%`}
                />
                <CommitNumber
                  value={shadowBlurPercent}
                  min={0}
                  max={20}
                  step={0.5}
                  unit="%"
                  ariaLabel="阴影模糊百分比"
                  onCommit={(value) =>
                    commitShadow({ shadowBlur: value / 100 }, '调整阴影模糊')
                  }
                />
              </div>
              <div className="position-grid">
                <label>
                  <span>偏移 X</span>
                  <CommitNumber
                    value={shadowOffsetXPercent}
                    min={-20}
                    max={20}
                    step={0.5}
                    unit="%"
                    ariaLabel="阴影水平偏移"
                    onCommit={(value) =>
                      commitShadow({ shadowOffsetX: value / 100 }, '调整阴影水平偏移')
                    }
                  />
                </label>
                <label>
                  <span>偏移 Y</span>
                  <CommitNumber
                    value={shadowOffsetYPercent}
                    min={-20}
                    max={20}
                    step={0.5}
                    unit="%"
                    ariaLabel="阴影垂直偏移"
                    onCommit={(value) =>
                      commitShadow({ shadowOffsetY: value / 100 }, '调整阴影垂直偏移')
                    }
                  />
                </label>
              </div>
            </>
          )}
        </section>

        <section className="panel-section">
          <div className="section-title">
            <span>位置 / 对齐</span>
            <span className="section-hint">画布百分比</span>
          </div>
          <div className="position-grid">
            <label>
              <span>水平</span>
              <span className="text-position-control">
                <CommitNumber
                  value={Math.round(style.x * 1000) / 10}
                  min={0}
                  max={100}
                  step={0.5}
                  unit="%"
                  ariaLabel="文本水平位置"
                  onCommit={(value) => commitPosition('position.x', value / 100)}
                />
                <KeyframeButton prop="position.x" clip={clip} />
              </span>
            </label>
            <label>
              <span>垂直</span>
              <span className="text-position-control">
                <CommitNumber
                  value={Math.round(style.y * 1000) / 10}
                  min={0}
                  max={100}
                  step={0.5}
                  unit="%"
                  ariaLabel="文本垂直位置"
                  onCommit={(value) => commitPosition('position.y', value / 100)}
                />
                <KeyframeButton prop="position.y" clip={clip} />
              </span>
            </label>
          </div>
          <div className="inline-actions">
            {(['left', 'center', 'right'] as const).map((align) => (
              <button
                key={align}
                type="button"
                className={`button mini${style.align === align ? ' is-active' : ''}`}
                onClick={() =>
                  commitStyle(
                    {
                      align,
                      x: align === 'left' ? 0.08 : align === 'right' ? 0.92 : 0.5,
                    },
                    '调整文本对齐',
                  )
                }
              >
                {align === 'left' ? '左对齐' : align === 'center' ? '居中' : '右对齐'}
              </button>
            ))}
            <button
              type="button"
              className={`button mini${style.bold ? ' is-active' : ''}`}
              onClick={() => commitStyle({ bold: !style.bold }, '切换粗体')}
            >
              B 粗体
            </button>
          </div>
        </section>

        <section className="panel-section panel-danger">
          <button
            type="button"
            className="button delete-clip"
            onClick={() => deleteTextClip(track.id, clip.id)}
          >
            <Icon name="trash" size={16} />
            删除文本片段
            <kbd>Delete</kbd>
          </button>
          <p className="control-note">删除后可用 Ctrl/⌘ + Z 恢复。</p>
        </section>
      </div>

      <div className="panel-foot">
        <Icon name="info" size={13} />
        文本会在预览和导出中烧录到画面。
      </div>
    </aside>
  )
}