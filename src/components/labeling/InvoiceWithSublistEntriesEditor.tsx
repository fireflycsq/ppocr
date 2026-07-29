import type { InvoiceEntry } from '../../types/labeling'
import type { FieldDefinition } from '../../types'
import { HeaderFieldsForm } from './HeaderFieldsForm'
import { SublistTableEditor } from './SublistTableEditor'

interface InvoiceWithSublistEntriesEditorProps {
  entries: InvoiceEntry[]
  headerFields: FieldDefinition[]
  sublistColumns: FieldDefinition[]
  hasTemplateDefaults?: boolean
  onAdd: () => void
  onRemove: (id: string) => void
  onHeaderChange: (id: string, fieldId: string, value: string) => void
  onApplyEntryDefaults?: (invoiceId: string) => void
  onAddSublistRow: (invoiceId: string) => void
  onRemoveSublistRow: (invoiceId: string, rowId: string) => void
  onSublistCellChange: (
    invoiceId: string,
    rowId: string,
    columnId: string,
    value: string,
  ) => void
}

export function InvoiceWithSublistEntriesEditor({
  entries,
  headerFields,
  sublistColumns,
  hasTemplateDefaults = false,
  onAdd,
  onRemove,
  onHeaderChange,
  onApplyEntryDefaults,
  onAddSublistRow,
  onRemoveSublistRow,
  onSublistCellChange,
}: InvoiceWithSublistEntriesEditorProps) {
  return (
    <div className="invoice-entries-editor">
      <div className="invoice-entries-toolbar">
        <span>共 {entries.length} 张发票（每张含子清单）</span>
        <button type="button" className="btn btn-outline btn-sm" onClick={onAdd}>
          + 添加发票
        </button>
      </div>

      <div className="invoice-entries-list">
        {entries.map((entry, index) => (
          <div key={entry.id} className="invoice-entry-card invoice-entry-with-sublist">
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

            <h4 className="invoice-entry-subtitle">发票头信息</h4>
            <HeaderFieldsForm
              fields={headerFields}
              values={entry.fieldValues}
              onChange={(fieldId, value) => onHeaderChange(entry.id, fieldId, value)}
            />

            <h4 className="invoice-entry-subtitle">子清单明细</h4>
            {hasTemplateDefaults && onApplyEntryDefaults && (
              <button
                type="button"
                className="btn btn-outline btn-sm label-template-fill-btn"
                onClick={() => onApplyEntryDefaults(entry.id)}
              >
                填入版式预填值（本发票）
              </button>
            )}
            <SublistTableEditor
              rows={entry.sublistRows ?? []}
              columns={sublistColumns}
              headerFields={headerFields}
              headerValues={entry.fieldValues}
              onAddRow={() => onAddSublistRow(entry.id)}
              onRemoveRow={(rowId) => onRemoveSublistRow(entry.id, rowId)}
              onCellChange={(rowId, columnId, value) =>
                onSublistCellChange(entry.id, rowId, columnId, value)
              }
            />
          </div>
        ))}
      </div>
    </div>
  )
}
