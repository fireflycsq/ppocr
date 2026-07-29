import type { InvoiceEntry } from '../../types/labeling'
import type { FieldDefinition } from '../../types'
import { HeaderFieldsForm } from './HeaderFieldsForm'

interface InvoiceEntriesEditorProps {
  entries: InvoiceEntry[]
  fields: FieldDefinition[]
  onAdd: () => void
  onRemove: (id: string) => void
  onChange: (id: string, fieldId: string, value: string) => void
}

export function InvoiceEntriesEditor({
  entries,
  fields,
  onAdd,
  onRemove,
  onChange,
}: InvoiceEntriesEditorProps) {
  return (
    <div className="invoice-entries-editor">
      <div className="invoice-entries-toolbar">
        <span>共 {entries.length} 张发票</span>
        <button type="button" className="btn btn-outline btn-sm" onClick={onAdd}>
          + 添加发票
        </button>
      </div>

      <div className="invoice-entries-list">
        {entries.map((entry, index) => (
          <div key={entry.id} className="invoice-entry-card">
            <div className="invoice-entry-header">
              <strong>发票 #{index + 1}</strong>
              {entries.length > 1 && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => onRemove(entry.id)}
                >
                  删除
                </button>
              )}
            </div>
            <HeaderFieldsForm
              fields={fields}
              values={entry.fieldValues}
              onChange={(fieldId, value) => onChange(entry.id, fieldId, value)}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
