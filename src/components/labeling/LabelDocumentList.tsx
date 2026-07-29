import { useRef } from 'react'
import type { DocumentCategory, DocumentFilter, LabelDocument } from '../../types/labeling'
import { isDocumentAnnotated, structureTypeLabel } from '../../utils/labelingStorage'

interface LabelDocumentListProps {
  documents: LabelDocument[]
  selectedId: string | null
  filter: DocumentFilter
  onFilterChange: (filter: DocumentFilter) => void
  onSelect: (id: string) => void
  onUpload: (files: File[]) => void
  onRemove: (id: string) => void
}

const FILTERS: Array<{ key: DocumentFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'unclassified', label: '未分类' },
  { key: 'target', label: '目标单证' },
  { key: 'non_target', label: '非目标单证' },
]

function categoryLabel(category: DocumentCategory | null) {
  if (category === 'target') return '目标单证'
  if (category === 'non_target') return '非目标单证'
  return '未分类'
}

function categoryClass(category: DocumentCategory | null) {
  if (category === 'target') return 'badge-target'
  if (category === 'non_target') return 'badge-non-target'
  return 'badge-unclassified'
}

export function LabelDocumentList({
  documents,
  selectedId,
  filter,
  onFilterChange,
  onSelect,
  onUpload,
  onRemove,
}: LabelDocumentListProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  const filtered = documents.filter((doc) => {
    if (filter === 'all') return true
    if (filter === 'unclassified') return !doc.category
    return doc.category === filter
  })

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length) onUpload(files)
    e.target.value = ''
  }

  return (
    <aside className="label-doc-list">
      <div className="label-doc-list-header">
        <h2>PDF 列表</h2>
        <span>{documents.length} 个</span>
      </div>

      <button
        type="button"
        className="btn btn-primary btn-block"
        onClick={() => inputRef.current?.click()}
      >
        批量上传 PDF
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        hidden
        onChange={handleChange}
      />
      <p className="label-upload-hint">支持多选，同名文件会保留已有标注</p>

      <div className="label-filter-tabs">
        {FILTERS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`label-filter-tab ${filter === item.key ? 'active' : ''}`}
            onClick={() => onFilterChange(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="label-doc-list-scroll">
        {filtered.length === 0 ? (
          <div className="label-empty-list">
            {documents.length === 0 ? '请先批量上传 PDF' : '当前筛选下暂无单证'}
          </div>
        ) : (
          <ul className="label-doc-items">
            {filtered.map((doc) => {
              const annotated = isDocumentAnnotated(doc)
              return (
                <li key={doc.id}>
                  <button
                    type="button"
                    className={`label-doc-item ${selectedId === doc.id ? 'active' : ''}`}
                    onClick={() => onSelect(doc.id)}
                  >
                    <span className="label-doc-name" title={doc.fileName}>
                      {doc.fileName}
                    </span>
                    <span className="label-doc-meta">
                      {(doc.fileSize / 1024).toFixed(1)} KB
                      {!doc.previewUrl && ' · 待重新上传预览'}
                    </span>
                    <span className="label-doc-badges">
                      <span className={`label-badge ${categoryClass(doc.category)}`}>
                        {categoryLabel(doc.category)}
                      </span>
                      {doc.category === 'target' && (
                        <span className="label-badge badge-structure">
                          {structureTypeLabel(doc.structureType)}
                        </span>
                      )}
                      {annotated && (
                        <span className="label-badge badge-done">已标注</span>
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="label-doc-remove"
                    title="移除"
                    onClick={() => onRemove(doc.id)}
                  >
                    ×
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </aside>
  )
}
