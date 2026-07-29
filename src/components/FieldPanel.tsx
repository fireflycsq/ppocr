import type { AdoptedField, FieldDefinition, FieldStatus } from '../types'

interface FieldPanelProps {
  fields: FieldDefinition[]
  adopted: Map<string, AdoptedField>
  selectedText: string | null
  selectedIndex: number | null
  selectedConfidence?: number
  onAddField: () => void
  onRemoveField: (id: string) => void
  onUpdateField: (id: string, patch: Partial<FieldDefinition>) => void
  onSetStatus: (fieldId: string, status: FieldStatus) => void
  onUpdateValue: (fieldId: string, value: string) => void
  onClearField: (fieldId: string) => void
  onExport: () => void
}

function statusLabel(status: FieldStatus | undefined) {
  if (status === 'adopted') return '已采纳'
  if (status === 'rejected') return '不采纳'
  return '待审核'
}

export function FieldPanel({
  fields,
  adopted,
  selectedText,
  selectedIndex,
  selectedConfidence,
  onAddField,
  onRemoveField,
  onUpdateField,
  onSetStatus,
  onUpdateValue,
  onClearField,
  onExport,
}: FieldPanelProps) {
  const adoptedCount = Array.from(adopted.values()).filter((f) => f.status === 'adopted').length
  const rejectedCount = Array.from(adopted.values()).filter((f) => f.status === 'rejected').length

  return (
    <div className="field-panel">
      <div className="panel-header">
        <div>
          <h2>字段配置 & 审核</h2>
          <p className="panel-desc">
            选中左侧识别文本，填入字段后选择「采纳」或「不采纳」
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={onExport}>
          导出 JSON
        </button>
      </div>

      {selectedText !== null && (
        <div className="selection-banner">
          <div className="selection-label">当前选中</div>
          <div className="selection-text">{selectedText}</div>
          {selectedConfidence !== undefined && (
            <div className="selection-meta">
              置信度 {(selectedConfidence * 100).toFixed(1)}% · 框 #{selectedIndex}
            </div>
          )}
        </div>
      )}

      <div className="field-list">
        {fields.map((field) => {
          const item = adopted.get(field.id)
          const value = item?.value ?? ''
          const status = item?.status

          return (
            <div
              key={field.id}
              className={`field-card status-${status ?? 'pending'} ${item ? 'field-reviewed' : ''}`}
            >
              <div className="field-card-top">
                <span className={`status-badge status-${status ?? 'pending'}`}>
                  {statusLabel(status)}
                </span>
                <button
                  type="button"
                  className="btn-icon btn-danger"
                  title="删除字段"
                  onClick={() => onRemoveField(field.id)}
                >
                  ×
                </button>
              </div>

              <div className="field-row">
                <label className="field-label-input">
                  <span>显示名</span>
                  <input
                    type="text"
                    value={field.label}
                    onChange={(e) => onUpdateField(field.id, { label: e.target.value })}
                    placeholder="字段名称"
                  />
                </label>
                <label className="field-label-input">
                  <span>键名</span>
                  <input
                    type="text"
                    value={field.key}
                    onChange={(e) =>
                      onUpdateField(field.id, {
                        key: e.target.value.replace(/\s/g, '_'),
                      })
                    }
                    placeholder="json_key"
                  />
                </label>
              </div>

              <div className="field-value-row">
                <input
                  type="text"
                  className="field-value"
                  value={value}
                  onChange={(e) => onUpdateValue(field.id, e.target.value)}
                  placeholder="手动输入或点击左侧识别文本"
                />
              </div>

              <div className="field-action-row">
                <button
                  type="button"
                  className="btn btn-adopt"
                  disabled={!value.trim() && selectedText === null}
                  onClick={() => onSetStatus(field.id, 'adopted')}
                >
                  采纳
                </button>
                <button
                  type="button"
                  className="btn btn-reject"
                  onClick={() => onSetStatus(field.id, 'rejected')}
                >
                  不采纳
                </button>
                {item && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => onClearField(field.id)}
                  >
                    重置
                  </button>
                )}
              </div>

              {item && item.sourceIndex >= 0 && item.status === 'adopted' && (
                <div className="field-source">
                  来源：检测框 #{item.sourceIndex}
                  {item.confidence !== undefined &&
                    ` · 置信度 ${(item.confidence * 100).toFixed(1)}%`}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <button type="button" className="btn btn-outline add-field-btn" onClick={onAddField}>
        + 添加字段
      </button>

      <div className="panel-footer">
        已采纳 {adoptedCount} · 不采纳 {rejectedCount} · 共 {fields.length} 个字段
      </div>
    </div>
  )
}
