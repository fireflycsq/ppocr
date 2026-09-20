import { useEffect, useState } from 'react'

type LoadState = 'loading' | 'ready' | 'error'

export default function ApiDocsPage() {
  const [state, setState] = useState<LoadState>('loading')

  useEffect(() => {
    let cancelled = false
    fetch('/api/v1/openapi.json')
      .then((res) => {
        if (!cancelled) setState(res.ok ? 'ready' : 'error')
      })
      .catch(() => {
        if (!cancelled) setState('error')
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="api-docs-page">
      <div className="api-docs-toolbar">
        <div>
          <h1>文档抽取 API</h1>
          <p>上传 PDF + 版式 ID，在线查看接口并直接调试。</p>
        </div>
        <a className="btn btn-ghost btn-sm" href="/api/v1/docs" target="_blank" rel="noreferrer">
          新窗口打开
        </a>
      </div>

      {state === 'loading' ? (
        <div className="api-docs-fallback">正在加载交互文档…</div>
      ) : null}

      {state === 'error' ? (
        <div className="api-docs-fallback">
          <strong>无法加载接口文档</strong>
          <p>
            请先启动 label-api：<code>npm run dev:label</code>
            ，然后刷新本页。
          </p>
        </div>
      ) : null}

      {state === 'ready' ? (
        <iframe
          className="api-docs-frame"
          title="文档抽取 API 交互文档"
          src="/api/v1/docs"
        />
      ) : null}
    </div>
  )
}
