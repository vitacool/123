import { useState } from 'react'
import { VideoEditor } from './editor'
import { withPlaybackProfiler } from './editor/devProfiler'
import './styles/demo.css'

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1500)
}

/**
 * 宿主平台自己的界面（只在 ?hostDemo=1 时显示）。
 *
 * 用来验证 CSS 隔离：这里的 .button / .badge / @keyframes spin 和编辑器重名，
 * 但编辑器样式已限定在 .framecut-root 下、动画改成 fc- 前缀，双方互不影响。
 */
function HostChrome() {
  return (
    <div className="host-chrome" data-testid="host-chrome">
      <span className="badge">HOST</span>
      <button type="button" className="button" data-testid="host-button">
        宿主按钮
      </button>
      <span className="host-spinner" aria-hidden="true" />
    </div>
  )
}

export default function App() {
  const [open, setOpen] = useState(true)
  const hostDemo =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('hostDemo')

  if (!open) {
    return (
      <main className="demo-exit">
        <div className="demo-exit-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p className="demo-exit-kicker">HOST PLATFORM</p>
        <h1>编辑器已关闭</h1>
        <p>
          宿主收到了 <code>onCancel()</code>。把 <code>&lt;VideoEditor /&gt;</code>{' '}
          放进你的页面，就可以把这段剪辑流程借走。
        </p>
        <button type="button" className="demo-reopen" onClick={() => setOpen(true)}>
          重新进入编辑器
        </button>
      </main>
    )
  }

  return (
    <main className="demo-app">
      {hostDemo ? <HostChrome /> : null}
      {withPlaybackProfiler(
        <VideoEditor
          onExport={(blob) => triggerDownload(blob, 'framecut-export.mp4')}
          onCancel={() => setOpen(false)}
        />,
      )}
    </main>
  )
}