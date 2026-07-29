import type {
  InvoiceEntry,
  LabelBatch,
  LabelBatchExport,
  LabelDocument,
  StoredLabelBatch,
  SublistRow,
  TargetStructureType,
} from '../types/labeling'
import type { FieldDefinition } from '../types'
import {
  applyTemplateDefaultsToInvoiceEntry,
  buildDefaultHeaderValues,
  buildDefaultSublistRows,
  DEFAULT_TEMPLATE_ID,
  getLabelTemplate,
} from './labelTemplates'
import { downloadJson } from '../utils'

const STORAGE_KEY = 'ppocr-document-label-batch'

let docIdCounter = 100
let invoiceIdCounter = 300
let rowIdCounter = 400
let fieldIdCounter = 200

export const defaultHeaderFields: FieldDefinition[] = getLabelTemplate(
  DEFAULT_TEMPLATE_ID,
).headerFields.map((field) => ({ ...field }))

export const defaultSublistColumns: FieldDefinition[] = getLabelTemplate(
  DEFAULT_TEMPLATE_ID,
).sublistColumns.map((column) => ({ ...column }))

export function createDocumentId(): string {
  docIdCounter += 1
  return `doc-${docIdCounter}-${Date.now()}`
}

export function createInvoiceEntryId(): string {
  invoiceIdCounter += 1
  return `inv-${invoiceIdCounter}-${Date.now()}`
}

export function createSublistRowId(): string {
  rowIdCounter += 1
  return `row-${rowIdCounter}-${Date.now()}`
}

export function createEmptyInvoiceEntry(
  withSublist = false,
  layoutTemplateId = DEFAULT_TEMPLATE_ID,
): InvoiceEntry {
  const template = getLabelTemplate(layoutTemplateId)
  if (!withSublist) {
    return {
      id: createInvoiceEntryId(),
      fieldValues: {},
    }
  }

  const defaults = applyTemplateDefaultsToInvoiceEntry(template)
  return {
    id: createInvoiceEntryId(),
    fieldValues: defaults.fieldValues,
    sublistRows: defaults.sublistRows,
  }
}

export function createEmptySublistRow(): SublistRow {
  return { id: createSublistRowId(), cells: {} }
}

export function createEmptyDocument(
  file: { name: string; size: number; previewUrl: string },
  layoutTemplateId = DEFAULT_TEMPLATE_ID,
): LabelDocument {
  const template = getLabelTemplate(layoutTemplateId)
  return {
    id: createDocumentId(),
    fileName: file.name,
    fileSize: file.size,
    previewUrl: file.previewUrl,
    category: null,
    structureType: 'single',
    fieldValues: {},
    invoiceEntries: [createEmptyInvoiceEntry(false)],
    invoiceHeader: buildDefaultHeaderValues(template),
    sublistRows: buildDefaultSublistRows(template),
    note: '',
    updatedAt: null,
  }
}

export function createEmptyBatch(): LabelBatch {
  const now = new Date().toISOString()
  const template = getLabelTemplate(DEFAULT_TEMPLATE_ID)
  return {
    id: `batch-${Date.now()}`,
    name: `标注批次 ${new Date().toLocaleString('zh-CN')}`,
    createdAt: now,
    updatedAt: now,
    layoutTemplateId: DEFAULT_TEMPLATE_ID,
    headerFields: template.headerFields.map((field) => ({ ...field })),
    sublistColumns: template.sublistColumns.map((column) => ({ ...column })),
    documents: [],
  }
}

function hasFieldValues(values: Record<string, string>): boolean {
  return Object.values(values).some((v) => v.trim().length > 0)
}

function fieldsToExport(
  fieldDefs: FieldDefinition[],
  values: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(fieldDefs.map((f) => [f.key, values[f.id] ?? '']))
}

export function isDocumentAnnotated(doc: LabelDocument): boolean {
  if (!doc.category) return false
  if (doc.category === 'non_target') return true

  switch (doc.structureType) {
    case 'multi_invoice':
      return doc.invoiceEntries.some((entry) => hasFieldValues(entry.fieldValues))
    case 'multi_invoice_with_sublist':
      return doc.invoiceEntries.some(
        (entry) =>
          hasFieldValues(entry.fieldValues) ||
          (entry.sublistRows ?? []).some((row) => hasFieldValues(row.cells)),
      )
    case 'invoice_with_sublist':
      return (
        hasFieldValues(doc.invoiceHeader) ||
        doc.sublistRows.some((row) => hasFieldValues(row.cells))
      )
    default:
      return hasFieldValues(doc.fieldValues)
  }
}

function exportDocument(
  doc: LabelDocument,
  headerFields: FieldDefinition[],
  sublistColumns: FieldDefinition[],
): LabelBatchExport['documents'][number] {
  const base = {
    fileName: doc.fileName,
    fileSize: doc.fileSize,
    category: doc.category,
    structureType: doc.structureType,
    note: doc.note,
    updatedAt: doc.updatedAt,
  }

  switch (doc.structureType) {
    case 'multi_invoice':
      return {
        ...base,
        invoices: doc.invoiceEntries.map((entry) =>
          fieldsToExport(headerFields, entry.fieldValues),
        ),
      }
    case 'multi_invoice_with_sublist':
      return {
        ...base,
        invoicesWithSublist: doc.invoiceEntries.map((entry) => ({
          invoice: fieldsToExport(headerFields, entry.fieldValues),
          sublist: (entry.sublistRows ?? []).map((row) =>
            fieldsToExport(sublistColumns, row.cells),
          ),
        })),
      }
    case 'invoice_with_sublist':
      return {
        ...base,
        invoice: fieldsToExport(headerFields, doc.invoiceHeader),
        sublist: doc.sublistRows.map((row) =>
          fieldsToExport(sublistColumns, row.cells),
        ),
      }
    default:
      return {
        ...base,
        fields: fieldsToExport(headerFields, doc.fieldValues),
      }
  }
}

export function buildBatchSummary(documents: LabelDocument[]) {
  const target = documents.filter((d) => d.category === 'target').length
  const nonTarget = documents.filter((d) => d.category === 'non_target').length
  const unclassified = documents.filter((d) => !d.category).length
  const annotated = documents.filter(isDocumentAnnotated).length
  return { total: documents.length, target, nonTarget, unclassified, annotated }
}

export function buildExportPayload(batch: LabelBatch): LabelBatchExport {
  return {
    exportedAt: new Date().toISOString(),
    batchId: batch.id,
    batchName: batch.name,
    headerFields: batch.headerFields,
    sublistColumns: batch.sublistColumns,
    summary: buildBatchSummary(batch.documents),
    documents: batch.documents.map((doc) =>
      exportDocument(doc, batch.headerFields, batch.sublistColumns),
    ),
  }
}

export function exportLabelBatch(batch: LabelBatch) {
  const payload = buildExportPayload(batch)
  const safeName = batch.name.replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40)
  downloadJson(payload, `label-batch-${safeName}-${Date.now()}.json`)
}

export function documentExportFileName(fileName: string): string {
  if (/\.pdf$/i.test(fileName)) {
    return fileName.replace(/\.pdf$/i, '.json')
  }
  return `${fileName}.json`
}

export function buildDocumentExportPayload(
  doc: LabelDocument,
  headerFields: FieldDefinition[],
  sublistColumns: FieldDefinition[],
) {
  return {
    exportedAt: new Date().toISOString(),
    headerFields,
    sublistColumns,
    ...exportDocument(doc, headerFields, sublistColumns),
  }
}

export function exportLabelDocument(
  doc: LabelDocument,
  headerFields: FieldDefinition[],
  sublistColumns: FieldDefinition[],
) {
  const payload = buildDocumentExportPayload(doc, headerFields, sublistColumns)
  downloadJson(payload, documentExportFileName(doc.fileName))
}

function normalizeInvoiceEntries(
  entries: InvoiceEntry[] | undefined,
  structureType: TargetStructureType,
): InvoiceEntry[] {
  const list = entries?.length ? entries : [createEmptyInvoiceEntry(false)]
  if (structureType === 'multi_invoice_with_sublist') {
    return list.map((entry) => ({
      ...entry,
      sublistRows:
        entry.sublistRows?.length ? entry.sublistRows : [createEmptySublistRow()],
    }))
  }
  return list
}

function migrateDocument(stored: StoredLabelBatch['documents'][number]): LabelDocument {
  const structureType: TargetStructureType = stored.structureType ?? 'single'
  return {
    id: stored.id,
    fileName: stored.fileName,
    fileSize: stored.fileSize,
    previewUrl: null,
    category: stored.category,
    structureType,
    fieldValues: stored.fieldValues ?? {},
    invoiceEntries: normalizeInvoiceEntries(stored.invoiceEntries, structureType),
    invoiceHeader: stored.invoiceHeader ?? {},
    sublistRows: stored.sublistRows?.length ? stored.sublistRows : [createEmptySublistRow()],
    note: stored.note,
    updatedAt: stored.updatedAt,
  }
}

function fromStoredBatch(stored: StoredLabelBatch): LabelBatch {
  const headerFields =
    stored.headerFields ??
    stored.predefinedFields?.map((f) => ({ ...f })) ??
    defaultHeaderFields.map((f) => ({ ...f }))
  const sublistColumns =
    stored.sublistColumns?.map((f) => ({ ...f })) ??
    defaultSublistColumns.map((f) => ({ ...f }))

  return {
    id: stored.id,
    name: stored.name,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    layoutTemplateId: stored.layoutTemplateId ?? DEFAULT_TEMPLATE_ID,
    headerFields,
    sublistColumns,
    documents: stored.documents.map(migrateDocument),
  }
}

function toStoredBatch(batch: LabelBatch): StoredLabelBatch {
  return {
    id: batch.id,
    name: batch.name,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    layoutTemplateId: batch.layoutTemplateId,
    headerFields: batch.headerFields,
    sublistColumns: batch.sublistColumns,
    documents: batch.documents.map((doc) => ({
      id: doc.id,
      fileName: doc.fileName,
      fileSize: doc.fileSize,
      category: doc.category,
      structureType: doc.structureType,
      fieldValues: doc.fieldValues,
      invoiceEntries: doc.invoiceEntries,
      invoiceHeader: doc.invoiceHeader,
      sublistRows: doc.sublistRows,
      note: doc.note,
      updatedAt: doc.updatedAt,
    })),
  }
}

export function batchFromStored(stored: StoredLabelBatch): LabelBatch {
  return fromStoredBatch(stored)
}

export function serializeBatchForStorage(batch: LabelBatch): StoredLabelBatch {
  return toStoredBatch(batch)
}

export function saveLabelBatch(batch: LabelBatch): LabelBatch {
  const updated: LabelBatch = { ...batch, updatedAt: new Date().toISOString() }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(toStoredBatch(updated)))
  return updated
}

export function loadLabelBatch(): LabelBatch | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    return fromStoredBatch(JSON.parse(raw) as StoredLabelBatch)
  } catch {
    return null
  }
}

export function clearSavedLabelBatch() {
  localStorage.removeItem(STORAGE_KEY)
}

export function mergeUploadedFiles(batch: LabelBatch, files: File[]): LabelBatch {
  const existingByName = new Map(batch.documents.map((doc) => [doc.fileName, doc]))
  const newDocs: LabelDocument[] = []

  for (const file of files) {
    const isPdf =
      file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    if (!isPdf) continue

    const previewUrl = URL.createObjectURL(file)
    const existing = existingByName.get(file.name)
    if (existing) {
      if (existing.previewUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(existing.previewUrl)
      }
      newDocs.push({ ...existing, fileSize: file.size, previewUrl })
      existingByName.delete(file.name)
    } else {
      newDocs.push(
        createEmptyDocument(
          { name: file.name, size: file.size, previewUrl },
          batch.layoutTemplateId,
        ),
      )
    }
  }

  return {
    ...batch,
    documents: [...newDocs, ...Array.from(existingByName.values())],
    updatedAt: new Date().toISOString(),
  }
}

export function revokeDocumentUrls(documents: LabelDocument[]) {
  documents.forEach((doc) => {
    if (doc.previewUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(doc.previewUrl)
    }
  })
}

export function createPredefinedField(
  label = '新字段',
  key = 'new_field',
): FieldDefinition {
  fieldIdCounter += 1
  return { id: String(fieldIdCounter), label, key }
}

export function structureTypeLabel(type: TargetStructureType): string {
  switch (type) {
    case 'multi_invoice':
      return '多发票'
    case 'invoice_with_sublist':
      return '发票+子清单'
    case 'multi_invoice_with_sublist':
      return '多发票+子清单'
    default:
      return '单发票'
  }
}
