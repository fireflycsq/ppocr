import type { OcrPageResult } from '../types'

interface PageThumbnailSidebarProps {
  pages: OcrPageResult[]
  viewingPageIndex: number | null
  onOpenPage: (pageIndex: number) => void
}

export function PageThumbnailSidebar({
  pages,
  viewingPageIndex,
  onOpenPage,
}: PageThumbnailSidebarProps) {
  return (
    <aside className="page-thumbnails">
      <div className="page-thumbnails-header">
        <h3>PDF 页面</h3>
        <span>{pages.length} 页</span>
      </div>
      <p className="page-thumbnails-hint">双击页面查看详情</p>
      <ul className="page-thumbnail-list">
        {pages.map((page) => {
          const isActive = viewingPageIndex === page.pageIndex
          return (
            <li key={page.pageIndex}>
              <button
                type="button"
                className={`page-thumbnail-item ${isActive ? 'active' : ''}`}
                onDoubleClick={() => onOpenPage(page.pageIndex)}
                title={`第 ${page.pageIndex + 1} 页 · ${page.results.length} 个检测框 · 双击查看`}
              >
                {page.thumbnailUrl ? (
                  <img
                    src={page.thumbnailUrl}
                    alt={`第 ${page.pageIndex + 1} 页`}
                    className="page-thumbnail-img"
                    draggable={false}
                  />
                ) : (
                  <div className="page-thumbnail-placeholder">P{page.pageIndex + 1}</div>
                )}
                <span className="page-thumbnail-label">第 {page.pageIndex + 1} 页</span>
                <span className="page-thumbnail-meta">{page.results.length} 框</span>
              </button>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
