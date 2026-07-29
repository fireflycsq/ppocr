import { useState } from 'react'
import { useAuth } from './contexts/AuthContext'
import DocumentLabelPage from './pages/DocumentLabelPage'
import OcrReviewPage from './pages/OcrReviewPage'

type AppPage = 'ocr' | 'label'

const NAV_ITEMS: Array<{ key: AppPage; label: string }> = [
  { key: 'ocr', label: '智能预识别审核' },
  { key: 'label', label: '单证标注' },
]

export default function App() {
  const [page, setPage] = useState<AppPage>('ocr')
  const { user, logout } = useAuth()

  return (
    <div className="app">
      <nav className="app-subnav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`app-subnav-item ${page === item.key ? 'active' : ''}`}
            onClick={() => setPage(item.key)}
          >
            {item.label}
          </button>
        ))}
        <div className="app-subnav-user">
          {user ? (
            <>
              <span className="app-user-name">{user.username}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={logout}>
                退出
              </button>
            </>
          ) : page === 'label' ? (
            <span className="app-user-hint">请登录后标注</span>
          ) : null}
        </div>
      </nav>

      <div className="app-page">
        {page === 'ocr' ? <OcrReviewPage /> : <DocumentLabelPage />}
      </div>
    </div>
  )
}
