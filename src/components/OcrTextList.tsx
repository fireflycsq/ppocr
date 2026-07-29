import type { OcrBox } from '../types'

interface OcrTextListProps {
  results: OcrBox[]
  selectedIndex: number | null
  adoptedIndices: Set<number>
  onSelect: (index: number) => void
}

export function OcrTextList({
  results,
  selectedIndex,
  adoptedIndices,
  onSelect,
}: OcrTextListProps) {
  if (results.length === 0) {
    return (
      <div className="ocr-text-list empty">
        <p>暂无识别结果</p>
      </div>
    )
  }

  return (
    <div className="ocr-text-list">
      <div className="ocr-text-list-header">
        <h3>全部识别文本</h3>
        <span>{results.length} 条</span>
      </div>
      <ul className="ocr-text-items">
        {results.map((item, index) => {
          const isSelected = selectedIndex === index
          const isAdopted = adoptedIndices.has(index)
          return (
            <li key={index}>
              <button
                type="button"
                className={`ocr-text-item ${isSelected ? 'selected' : ''} ${isAdopted ? 'adopted' : ''}`}
                onClick={() => onSelect(index)}
              >
                <span className="ocr-text-index">#{index}</span>
                <span className="ocr-text-content">{item.text}</span>
                {item.layout_type && (
                  <span className="ocr-text-type">{item.layout_type}</span>
                )}
                {item.confidence !== undefined && (
                  <span className="ocr-text-conf">
                    {(item.confidence * 100).toFixed(1)}%
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
