import type { FieldDefinition } from '../types'

export type DocumentCategory = 'target' | 'non_target'

export type DocumentFilter = 'all' | 'unclassified' | 'target' | 'non_target'

/** 目标单证结构 */
export type TargetStructureType =
  | 'single'
  | 'multi_invoice'
  | 'invoice_with_sublist'
  | 'multi_invoice_with_sublist'

export interface InvoiceEntry {
  id: string
  fieldValues: Record<string, string>
  /** 多发票+子清单：每张发票各自的明细行 */
  sublistRows?: SublistRow[]
}

export interface SublistRow {
  id: string
  cells: Record<string, string>
}

export interface LabelDocument {
  id: string
  fileName: string
  fileSize: number
  previewUrl: string | null
  category: DocumentCategory | null
  /** 目标单证结构类型 */
  structureType: TargetStructureType
  /** 单发票：一组头字段 */
  fieldValues: Record<string, string>
  /** 多发票：每组头字段一条 */
  invoiceEntries: InvoiceEntry[]
  /** 发票+子清单：头字段 */
  invoiceHeader: Record<string, string>
  /** 发票+子清单：明细行 */
  sublistRows: SublistRow[]
  note: string
  updatedAt: string | null
}

export interface LabelBatch {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  /** 发票头字段（发票号、发票日期等） */
  headerFields: FieldDefinition[]
  /** 子清单表格列 */
  sublistColumns: FieldDefinition[]
  /** 标注版式模板 ID */
  layoutTemplateId: string
  documents: LabelDocument[]
}

export interface LabelBatchExport {
  exportedAt: string
  batchId: string
  batchName: string
  headerFields: FieldDefinition[]
  sublistColumns: FieldDefinition[]
  summary: {
    total: number
    target: number
    nonTarget: number
    unclassified: number
    annotated: number
  }
  documents: Array<{
    fileName: string
    fileSize: number
    category: DocumentCategory | null
    structureType: TargetStructureType
    /** 单发票 */
    fields?: Record<string, string>
    /** 多发票 */
    invoices?: Array<Record<string, string>>
    /** 多发票+子清单：每张发票含 sublist */
    invoicesWithSublist?: Array<{
      invoice: Record<string, string>
      sublist: Array<Record<string, string>>
    }>
    /** 单发票+子清单 */
    invoice?: Record<string, string>
    sublist?: Array<Record<string, string>>
    note: string
    updatedAt: string | null
  }>
}

export interface StoredLabelBatch {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  headerFields?: FieldDefinition[]
  sublistColumns?: FieldDefinition[]
  layoutTemplateId?: string
  /** @deprecated 旧版字段，加载时迁移到 headerFields */
  predefinedFields?: FieldDefinition[]
  documents: Array<{
    id: string
    fileName: string
    fileSize: number
    category: DocumentCategory | null
    structureType?: TargetStructureType
    fieldValues?: Record<string, string>
    invoiceEntries?: InvoiceEntry[]
    invoiceHeader?: Record<string, string>
    sublistRows?: SublistRow[]
    note: string
    updatedAt: string | null
  }>
}

export const STRUCTURE_OPTIONS: Array<{
  value: TargetStructureType
  label: string
  desc: string
}> = [
  {
    value: 'single',
    label: '单发票',
    desc: '一个 PDF 对应一张发票',
  },
  {
    value: 'multi_invoice',
    label: '多发票',
    desc: '一个 PDF 含多张发票，分别填写发票号、日期等',
  },
  {
    value: 'invoice_with_sublist',
    label: '发票 + 子清单',
    desc: '一张发票对应一份子清单，明细按表格多行录入',
  },
  {
    value: 'multi_invoice_with_sublist',
    label: '多发票 + 子清单',
    desc: '一个 PDF 含多张发票，每张发票各有发票头字段和子清单明细表',
  },
]
