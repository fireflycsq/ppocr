import type {
  DocumentCategory,
  InvoiceEntry,
  LabelDocument,
  SublistRow,
  TargetStructureType,
} from '../../types/labeling'
import { STRUCTURE_OPTIONS } from '../../types/labeling'
import type { FieldDefinition } from '../../types'
import {
  createEmptyInvoiceEntry,
  createEmptySublistRow,
  isDocumentAnnotated,
} from '../../utils/labelingStorage'
import { getLabelTemplate, applyTemplateDefaultsToInvoiceEntry } from '../../utils/labelTemplates'
import { HeaderFieldsForm } from './HeaderFieldsForm'
import { InvoiceEntriesEditor } from './InvoiceEntriesEditor'
import { InvoiceWithSublistEntriesEditor } from './InvoiceWithSublistEntriesEditor'
import { SublistTableEditor } from './SublistTableEditor'

interface DocumentAnnotationPanelProps {
  document: LabelDocument | null
  headerFields: FieldDefinition[]
  sublistColumns: FieldDefinition[]
  layoutTemplateId: string
  onCategoryChange: (category: DocumentCategory) => void
  onStructureChange: (structureType: TargetStructureType) => void
  onSingleFieldChange: (fieldId: string, value: string) => void
  onInvoiceEntriesChange: (entries: InvoiceEntry[]) => void
  onInvoiceHeaderChange: (fieldId: string, value: string) => void
  onSublistRowsChange: (rows: SublistRow[]) => void
  onApplyTemplateDefaults: () => void
  onNoteChange: (note: string) => void
  onSaveDocument: () => void
  onExportDocument: () => void
}

export function DocumentAnnotationPanel({
  document,
  headerFields,
  sublistColumns,
  layoutTemplateId,
  onCategoryChange,
  onStructureChange,
  onSingleFieldChange,
  onInvoiceEntriesChange,
  onInvoiceHeaderChange,
  onSublistRowsChange,
  onApplyTemplateDefaults,
  onNoteChange,
  onSaveDocument,
  onExportDocument,
}: DocumentAnnotationPanelProps) {
  if (!document) {
    return (
      <div className="label-annotation-panel empty">
        <p>请从左侧选择一个 PDF 进行标注</p>
      </div>
    )
  }

  const template = getLabelTemplate(layoutTemplateId)
  const hasTemplateDefaults =
    Boolean(template.defaultHeaderValues) || Boolean(template.defaultSublistRows?.length)

  const handleInvoiceEntryChange = (
    entryId: string,
    fieldId: string,
    value: string,
  ) => {
    onInvoiceEntriesChange(
      document.invoiceEntries.map((entry) =>
        entry.id === entryId
          ? { ...entry, fieldValues: { ...entry.fieldValues, [fieldId]: value } }
          : entry,
      ),
    )
  }

  const handleAddInvoice = () => {
    const withSublist = document.structureType === 'multi_invoice_with_sublist'
    onInvoiceEntriesChange([
      ...document.invoiceEntries,
      createEmptyInvoiceEntry(withSublist, layoutTemplateId),
    ])
  }

  const handleRemoveInvoice = (id: string) => {
    onInvoiceEntriesChange(document.invoiceEntries.filter((e) => e.id !== id))
  }

  const handleAddSublistRow = () => {
    onSublistRowsChange([...document.sublistRows, createEmptySublistRow()])
  }

  const handleRemoveSublistRow = (id: string) => {
    onSublistRowsChange(document.sublistRows.filter((r) => r.id !== id))
  }

  const handleSublistCellChange = (
    rowId: string,
    columnId: string,
    value: string,
  ) => {
    onSublistRowsChange(
      document.sublistRows.map((row) =>
        row.id === rowId
          ? { ...row, cells: { ...row.cells, [columnId]: value } }
          : row,
      ),
    )
  }

  const handleInvoiceSublistAddRow = (invoiceId: string) => {
    onInvoiceEntriesChange(
      document.invoiceEntries.map((entry) =>
        entry.id === invoiceId
          ? {
              ...entry,
              sublistRows: [...(entry.sublistRows ?? []), createEmptySublistRow()],
            }
          : entry,
      ),
    )
  }

  const handleInvoiceSublistRemoveRow = (invoiceId: string, rowId: string) => {
    onInvoiceEntriesChange(
      document.invoiceEntries.map((entry) =>
        entry.id === invoiceId
          ? {
              ...entry,
              sublistRows: (entry.sublistRows ?? []).filter((r) => r.id !== rowId),
            }
          : entry,
      ),
    )
  }

  const handleInvoiceSublistCellChange = (
    invoiceId: string,
    rowId: string,
    columnId: string,
    value: string,
  ) => {
    onInvoiceEntriesChange(
      document.invoiceEntries.map((entry) =>
        entry.id === invoiceId
          ? {
              ...entry,
              sublistRows: (entry.sublistRows ?? []).map((row) =>
                row.id === rowId
                  ? { ...row, cells: { ...row.cells, [columnId]: value } }
                  : row,
              ),
            }
          : entry,
      ),
    )
  }

  const handleApplyEntryTemplateDefaults = (invoiceId: string) => {
    if (
      !window.confirm(
        '将用当前版式的预填值覆盖该发票的头字段与子清单明细，已有内容会被替换。确定继续？',
      )
    ) {
      return
    }
    const defaults = applyTemplateDefaultsToInvoiceEntry(template)
    onInvoiceEntriesChange(
      document.invoiceEntries.map((entry) =>
        entry.id === invoiceId ? { ...entry, ...defaults } : entry,
      ),
    )
  }

  const showTemplateFillButton =
    hasTemplateDefaults &&
    (document.structureType === 'invoice_with_sublist' ||
      document.structureType === 'multi_invoice_with_sublist')

  return (
    <div className="label-annotation-panel">
      <div className="label-annotation-header">
        <h2>单证标注</h2>
        <p className="label-current-file" title={document.fileName}>
          {document.fileName}
        </p>
      </div>

      <section className="label-category-section">
        <h3>单证分类</h3>
        <div className="label-category-options">
          <label
            className={`label-category-option ${document.category === 'target' ? 'active target' : ''}`}
          >
            <input
              type="radio"
              name={`category-${document.id}`}
              checked={document.category === 'target'}
              onChange={() => onCategoryChange('target')}
            />
            <span className="option-title">目标单证</span>
            <span className="option-desc">需要填写结构化字段</span>
          </label>
          <label
            className={`label-category-option ${document.category === 'non_target' ? 'active non-target' : ''}`}
          >
            <input
              type="radio"
              name={`category-${document.id}`}
              checked={document.category === 'non_target'}
              onChange={() => onCategoryChange('non_target')}
            />
            <span className="option-title">非目标单证</span>
            <span className="option-desc">无需填写字段，标记即可</span>
          </label>
        </div>
      </section>

      {document.category === 'target' && (
        <>
          <section className="label-structure-section">
            <h3>单证结构</h3>
            <div className="label-structure-options">
              {STRUCTURE_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className={`label-structure-option ${document.structureType === opt.value ? 'active' : ''}`}
                >
                  <input
                    type="radio"
                    name={`structure-${document.id}`}
                    checked={document.structureType === opt.value}
                    onChange={() => onStructureChange(opt.value)}
                  />
                  <span className="option-title">{opt.label}</span>
                  <span className="option-desc">{opt.desc}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="label-fields-section">
            {document.structureType === 'single' && (
              <>
                <h3>发票字段</h3>
                <HeaderFieldsForm
                  fields={headerFields}
                  values={document.fieldValues}
                  onChange={onSingleFieldChange}
                />
              </>
            )}

            {document.structureType === 'multi_invoice' && (
              <>
                <h3>多张发票</h3>
                <p className="label-hint">
                  同一 PDF 内每张发票单独填写发票号、发票日期等头字段
                </p>
                <InvoiceEntriesEditor
                  entries={document.invoiceEntries}
                  fields={headerFields}
                  onAdd={handleAddInvoice}
                  onRemove={handleRemoveInvoice}
                  onChange={handleInvoiceEntryChange}
                />
              </>
            )}

            {document.structureType === 'invoice_with_sublist' && (
              <>
                <h3>发票头信息</h3>
                <HeaderFieldsForm
                  fields={headerFields}
                  values={document.invoiceHeader}
                  onChange={onInvoiceHeaderChange}
                />
                <h3 className="label-subsection-title">子清单明细</h3>
                <p className="label-hint">一行对应子清单中的一条明细，可添加多行</p>
                {showTemplateFillButton && (
                  <button
                    type="button"
                    className="btn btn-outline btn-sm label-template-fill-btn"
                    onClick={onApplyTemplateDefaults}
                  >
                    填入版式预填值
                  </button>
                )}
                <SublistTableEditor
                  rows={document.sublistRows}
                  columns={sublistColumns}
                  headerFields={headerFields}
                  headerValues={document.invoiceHeader}
                  onAddRow={handleAddSublistRow}
                  onRemoveRow={handleRemoveSublistRow}
                  onCellChange={handleSublistCellChange}
                />
              </>
            )}

            {document.structureType === 'multi_invoice_with_sublist' && (
              <>
                <h3>多张发票（各含子清单）</h3>
                <p className="label-hint">
                  每张发票填写发票号、发票日期，并单独录入该发票对应的子清单明细表
                </p>
                {showTemplateFillButton && (
                  <button
                    type="button"
                    className="btn btn-outline btn-sm label-template-fill-btn"
                    onClick={onApplyTemplateDefaults}
                  >
                    填入版式预填值（全部发票）
                  </button>
                )}
                <InvoiceWithSublistEntriesEditor
                  entries={document.invoiceEntries}
                  headerFields={headerFields}
                  sublistColumns={sublistColumns}
                  hasTemplateDefaults={hasTemplateDefaults}
                  onAdd={handleAddInvoice}
                  onRemove={handleRemoveInvoice}
                  onHeaderChange={handleInvoiceEntryChange}
                  onApplyEntryDefaults={handleApplyEntryTemplateDefaults}
                  onAddSublistRow={handleInvoiceSublistAddRow}
                  onRemoveSublistRow={handleInvoiceSublistRemoveRow}
                  onSublistCellChange={handleInvoiceSublistCellChange}
                />
              </>
            )}
          </section>
        </>
      )}

      <section className="label-note-section">
        <label className="field-label-input">
          <span>备注（可选）</span>
          <textarea
            className="label-note-input"
            value={document.note}
            onChange={(e) => onNoteChange(e.target.value)}
            placeholder="补充说明…"
            rows={3}
          />
        </label>
      </section>

      <div className="label-annotation-actions">
        <div className="label-annotation-buttons">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!document.category}
            onClick={onSaveDocument}
          >
            保存当前单证
          </button>
          <button
            type="button"
            className="btn btn-outline"
            disabled={!isDocumentAnnotated(document)}
            onClick={onExportDocument}
          >
            导出 JSON
          </button>
        </div>
        {document.updatedAt && (
          <span className="label-saved-at">
            上次保存：{new Date(document.updatedAt).toLocaleString('zh-CN')}
          </span>
        )}
      </div>
    </div>
  )
}
