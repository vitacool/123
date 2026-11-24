import { describe, expect, it } from 'vitest'
import { ErrorBoundary } from '../src/editor/components/ErrorBoundary'

describe('ErrorBoundary（编辑器渲染失败兜底）', () => {
  it('getDerivedStateFromError 把错误放进 state，触发 fallback 渲染', () => {
    const error = new Error('boom')
    expect(ErrorBoundary.getDerivedStateFromError(error)).toEqual({ error })
  })
})