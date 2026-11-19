import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { serializeSrt } from '../core/text'
import type { TextClip, TextTrack } from '../core/types'
import { useEditorStore } from '../store/EditorProvider'
import { Icon } from './Icon'

interface CaptionListPanelProps {
  track: TextTrack
  clip: TextClip
}

const ROW_HEIGHT = 76
const OVERSCAN = 6

function fmtClock(seconds: number): string {
  const value = Math.max(0, seconds)
  const minutes = Math.floor(value / 60)
  const secs = value % 60
  return `${minutes}:${secs.toFixed(2).padStart(5, '0')}`
}

export function CaptionListPanel({ track, clip }: CaptionListPanelProps) {
  const playhead = useEditorStore((state) => state.playhead)
  const selectClip = useEditorStore((state) => state.selectClip)
  const setPlayhead = useEditorStore((state) => state.setPlayhead)
  const editCaptionText = useEditorStore((state) => state.editCaptionText)
  const splitCaption = useEditorStore((state) => state.splitCaption)
  const mergeCaptionUp = useEditorStore((state) => state.mergeCaptionUp)
  const deleteTextClip = useEditorStore((state) => state.deleteTextClip)
  const replaceCaptionText = useEditorStore((state) => state.replaceCaptionText)
  const replaceCaptionTextInClip = useEditorStore((state) => state.replaceCaptionTextInClip)
  const captionFollow = useEditorStore((state) => state.captionFollow)
  const setCaptionFollow = useEditorStore((state) => state.setCaptionFollow)

  const clips = track.clips
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewHeight, setViewHeight] = useState(400)

  useLayoutEffect(() => {
    const measure = () => {
      if (scrollRef.current) setViewHeight(scrollRef.current.clientHeight)
    }
    measure()
  }, [])

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const visibleCount = Math.ceil(viewHeight / ROW_HEIGHT) + OVERSCAN * 2
  const endIndex = Math.min(clips.length, startIndex + visibleCount)

  const activeIndex = clips.findIndex((c) => playhead >= c.start - 0.001 && playhead < c.end - 0.001)

  // 播放头所在行自动滚到可见区域。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || activeIndex < 0) return
    const top = activeIndex * ROW_HEIGHT
    if (top < el.scrollTop || top + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 2)
    }
  }, [activeIndex, clips.length])

  const jumpTo = (c: TextClip) => {
    selectClip(c.id)
    setPlayhead(c.start)
  }

  const commitRow = (c: TextClip, value: string) => {
    editCaptionText(c.id, value)
  }

  const onKeyDown = (c: TextClip, event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = event.currentTarget
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      editCaptionText(c.id, el.value)
      el.blur()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      editCaptionText(c.id, el.value)
      splitCaption(c.id, el.selectionStart)
      return
    }
    if (event.key === 'Backspace' && el.selectionStart === 0 && el.selectionEnd === 0) {
      event.preventDefault()
      mergeCaptionUp(c.id)
    }
  }

  const exportSrt = useCallback(() => {
    const srt = serializeSrt(clips)
    const blob = new Blob([srt], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${track.name}.srt`
    anchor.click()
    URL.revokeObjectURL(url)
  }, [clips, track.name])

  const doReplaceAll = () => {
    replaceCaptionText(track.id, find, replace)
  }

  const doReplaceCurrent = () => {
    replaceCaptionTextInClip(clip.id, find, replace)
  }

  return (
    <aside className="properties-panel caption-list-panel" aria-label="字幕列表">
      <div className="panel-head">
        <div>
          <p className="panel-eyebrow">字幕列表</p>
          <h2>
            字幕
            <span className="panel-index">{clips.length} 条</span>
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

      <div className="caption-list-toolbar">
        <input
          value={find}
          onChange={(event) => setFind(event.target.value)}
          placeholder="查找"
          aria-label="查找"
        />
        <input
          value={replace}
          onChange={(event) => setReplace(event.target.value)}
          placeholder="替换为"
          aria-label="替换为"
        />
        <button type="button" className="button mini" onClick={doReplaceCurrent} disabled={!find}>
          替换当前
        </button>
        <button type="button" className="button mini" onClick={doReplaceAll} disabled={!find}>
          全部替换
        </button>
        <button type="button" className="button mini" onClick={exportSrt}>
          导出 SRT
        </button>
        <label className="caption-follow-check">
          <input
            type="checkbox"
            checked={captionFollow}
            onChange={(event) => setCaptionFollow(event.target.checked)}
          />
          <span>字幕跟随视频</span>
        </label>
      </div>

      <div
        className="caption-list"
        ref={scrollRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        role="list"
        aria-label="字幕条目"
      >
        <div style={{ height: startIndex * ROW_HEIGHT }} />
        {clips.slice(startIndex, endIndex).map((c) => {
          const rowIndex = clips.indexOf(c)
          const active = rowIndex === activeIndex
          const selected = c.id === clip.id
          return (
            <div
              key={c.id}
              role="listitem"
              className={`caption-row${active ? ' is-active' : ''}${selected ? ' is-selected' : ''}`}
              style={{ height: ROW_HEIGHT }}
            >
              <button
                type="button"
                className="caption-row-time"
                onClick={() => jumpTo(c)}
                aria-label={`跳转到 ${fmtClock(c.start)}`}
              >
                {fmtClock(c.start)}
              </button>
              <textarea
                className="caption-row-text"
                key={c.id}
                defaultValue={c.text}
                rows={2}
                onBlur={(event) => commitRow(c, event.currentTarget.value)}
                onKeyDown={(event) => onKeyDown(c, event)}
                aria-label="字幕文字"
              />
              <button
                type="button"
                className="caption-row-delete"
                onClick={() => deleteTextClip(track.id, c.id)}
                aria-label="删除字幕"
                title="删除字幕"
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          )
        })}
        <div style={{ height: Math.max(0, (clips.length - endIndex) * ROW_HEIGHT) }} />
      </div>

      <div className="panel-foot">
        <Icon name="info" size={13} />
        点时间跳转 · Enter 拆句 · 行首 Backspace 合并 · Ctrl+Enter 提交
      </div>
    </aside>
  )
}