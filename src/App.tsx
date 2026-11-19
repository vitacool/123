import { useState } from 'react'
import { VideoEditor } from './editor'
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

export default function App() {
  const [open, setOpen] = useState(true)

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
      <VideoEditor
        onExport={(blob) => triggerDownload(blob, 'framecut-export.mp4')}
        onCancel={() => setOpen(false)}
      />
    </main>
  )
}