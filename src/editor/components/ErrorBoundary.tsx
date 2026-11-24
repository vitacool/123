import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * 编辑器级错误边界：任何一个子组件在渲染/生命周期里抛错时，不应让宿主整页白屏。
 * 草稿已经由自动保存落盘，重新加载即可继续；错误详情折叠展示，便于反馈。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[FrameCut] 编辑器渲染失败：', error, info.componentStack)
  }

  render(): ReactNode {
    const error = this.state.error
    if (!error) return this.props.children
    return (
      <div className="framecut-error-boundary" role="alert">
        <div className="framecut-error-card">
          <strong>编辑器遇到问题</strong>
          <p>界面渲染失败。你的工程已自动保存在本机，重新加载后可继续。</p>
          <button
            type="button"
            className="button primary"
            onClick={() => window.location.reload()}
          >
            重新加载
          </button>
          <details>
            <summary>错误详情</summary>
            <pre>{error.message}</pre>
          </details>
        </div>
      </div>
    )
  }
}