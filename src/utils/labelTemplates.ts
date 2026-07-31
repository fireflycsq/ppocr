import type { FieldDefinition } from '../types'
import type { InvoiceEntry, LabelBatch, LabelDocument, SublistRow } from '../types/labeling'

let templateRowIdCounter = 500

function createTemplateRowId(): string {
  templateRowIdCounter += 1
  return `row-${templateRowIdCounter}-${Date.now()}`
}

export interface LabelLayoutTemplate {
  id: string
  name: string
  description: string
  headerFields: FieldDefinition[]
  sublistColumns: FieldDefinition[]
  defaultHeaderValues?: Record<string, string>
  defaultSublistRows?: Array<Record<string, string>>
  /** 低清预判必须遵守的业务规则（写入分类 prompt） */
  classificationRules?: string[]
  /** 明细行必填列 key：这些列为空的明细行会被过滤；整页无有效内容时按跳过处理 */
  requiredSublistKeys?: string[]
}

export const LABEL_TEMPLATES: LabelLayoutTemplate[] = [
  {
    id: 'air_waybill',
    name: '空运单版式（FedEx）',
    description: '发票号码、发票日期 + 空中运输单编号 / 收费（INVOICE 發票双语发票）',
    headerFields: [
      { id: 'h1', key: 'invoice_no', label: '发票号码' },
      { id: 'h2', key: 'invoice_date', label: '发票日期' },
    ],
    sublistColumns: [
      {
        id: 'c1',
        key: 'air_waybill_number',
        label: '空中运输单编号（Air Waybill Number）',
      },
      { id: 'c2', key: 'total', label: '收费（Total）' },
    ],
    classificationRules: [
      '目标单证页顶部中央印有 INVOICE 發票（DUTIES, TAXES & OTHER CHARGES 進口關稅及其他收費），且包含 Details by Payment Type 詳細資料(按付款項目) 明细区域。',
      '明细区域必须至少出现一处空运提单号（Air Waybill Number 空運提單號）及对应编号，才可判 is_target=true。',
      '只有 Summary by Payment Type 付款項目摘要、Grand Total、付款方式说明（FPS、QR Pay 等）或 Remittance Slip 郵遞付款單 的汇总首页，必须判 is_target=false。',
      '仅出现发票号码、发票日期而无空运提单号明细的页面，多为封面、汇总页或付款回执，必须判 is_target=false。',
    ],
    requiredSublistKeys: ['air_waybill_number'],
  },
  {
    id: 'air_waybill_dhl',
    name: '空运单版式（DHL）',
    description: '发票号码、发票日期 + 空中运输单编号 / 收费（DHL 发票）',
    headerFields: [
      { id: 'dh1', key: 'invoice_no', label: '发票号码' },
      { id: 'dh2', key: 'invoice_date', label: '发票日期' },
    ],
    sublistColumns: [
      {
        id: 'dc1',
        key: 'air_waybill_number',
        label: '空中运输单编号（Air Waybill Number）',
      },
      { id: 'dc2', key: 'total', label: '收费（Total）' },
    ],
    classificationRules: [
      '目标单证页必须包含运单明细表格：表头出现 Air Waybill Number、Shipment Date、Origin / Consignor、Destination / Consignee、Total 等列，且 Air Waybill Number 列下方至少有一个具体运单号。',
      '只有 Type of Service 汇总表、Analysis of Extra Charges（附加费分析）、Total Amount (HKD)、Payment Instructions（付款指引）或银行转账/支票说明的汇总首页，必须判 is_target=false。',
      '封面页、合同条款、报关随附资料、空白页必须判 is_target=false。',
    ],
    requiredSublistKeys: ['air_waybill_number'],
  },
  {
    id: 'freight_invoice',
    name: '货运发票版式',
    description: 'GEODIS 货运发票：完整发票头 + 描述 / 收费明细',
    headerFields: [
      { id: 'fh1', key: 'invoice_no', label: '发票号' },
      { id: 'fh2', key: 'invoice_date', label: '发票日期' },
      { id: 'fh3', key: 'packages', label: '包裹（packages）' },
      { id: 'fh4', key: 'volume', label: '体积（volume）' },
      { id: 'fh5', key: 'weight', label: '重量（weight）' },
      { id: 'fh6', key: 'terms', label: '条款（terms）' },
      { id: 'fh7', key: 'incoterm', label: '国贸条规（incoterm）' },
      { id: 'fh8', key: 'supplier', label: '供应商（supplier）' },
      {
        id: 'fh9',
        key: 'vessel_voyage_imo',
        label: '船舶航行国际海事组织（劳埃德）（VESSEL VOYAGE IMO(LLOYDS)）',
      },
      {
        id: 'fh10',
        key: 'house_bill_of_lading',
        label: '提单（HOUSE BILL OF LADING）',
      },
      { id: 'fh11', key: 'total_hkd', label: '合计（TOTAL_HKD）' },
    ],
    sublistColumns: [
      { id: 'fc1', key: 'description', label: '描述（DESCRIPTION）' },
      { id: 'fc2', key: 'charges_in_hkd', label: '收费（CHARGES IN HKD）' },
    ],
    classificationRules: [
      '目标单证页上部印有 INVOICE 及紧随其后的发票编号，右侧有 INVOICE DATE、CUSTOMER ID、TERMS、INCOTERM 等发票信息网格表，中部有 SHIPMENT DETAILS 装运信息区域。',
      '页面必须包含 CHARGES 费用明细表格（DESCRIPTION / CHARGES IN HKD），且至少有一行费用项目，才可判 is_target=true。',
      '页面底部有 TOTAL CHARGES 合计区（SUBTOTAL、TOTAL HKD）。',
      '纯付款通知/付款回执（Payment Advice）、对账单、封面页或没有费用明细行的页面，必须判 is_target=false。',
    ],
    requiredSublistKeys: ['description'],
    defaultHeaderValues: {
      supplier: 'GEODIS Hong Kong Limited',
      terms: '15 days from Inv. Date',
      incoterm: 'FOB - Free On Board',
    },
    defaultSublistRows: [
      {
        description: 'Warehouse Handling - Minimum HKD 220.00',
        charges_in_hkd: '220.00',
      },
      {
        description: 'Bill of Lading Fee - Base Rate HKD 650.00',
        charges_in_hkd: '650.00',
      },
      {
        description: 'Seal Fee & Port Security Fee - Base Rate HKD 10.00',
        charges_in_hkd: '10.00',
      },
      {
        description: 'Handling - Base Rate HKD 450.00',
        charges_in_hkd: '450.00',
      },
      {
        description: 'Telex Release/Express Charges - Base Rate HKD 400.00',
        charges_in_hkd: '400.00',
      },
      {
        description: 'VGM Administration Fee - Base Rate HKD 195.00',
        charges_in_hkd: '195.00',
      },
    ],
  },
]

export const DEFAULT_TEMPLATE_ID = 'air_waybill'

export function getLabelTemplate(id: string): LabelLayoutTemplate {
  return (
    LABEL_TEMPLATES.find((template) => template.id === id) ??
    LABEL_TEMPLATES[0]
  )
}

function remapValuesByKey(
  values: Record<string, string>,
  oldFields: FieldDefinition[],
  newFields: FieldDefinition[],
): Record<string, string> {
  const oldKeyById = Object.fromEntries(oldFields.map((field) => [field.id, field.key]))
  const newIdByKey = Object.fromEntries(newFields.map((field) => [field.key, field.id]))
  const result: Record<string, string> = {}

  for (const [oldId, value] of Object.entries(values)) {
    const key = oldKeyById[oldId]
    const newId = key ? newIdByKey[key] : undefined
    if (newId && value.trim()) {
      result[newId] = value
    }
  }

  return result
}

function remapSublistRows(
  rows: SublistRow[],
  oldColumns: FieldDefinition[],
  newColumns: FieldDefinition[],
): SublistRow[] {
  return rows.map((row) => ({
    ...row,
    cells: remapValuesByKey(row.cells, oldColumns, newColumns),
  }))
}

function remapDocument(
  doc: LabelDocument,
  oldHeaderFields: FieldDefinition[],
  newHeaderFields: FieldDefinition[],
  oldSublistColumns: FieldDefinition[],
  newSublistColumns: FieldDefinition[],
): LabelDocument {
  return {
    ...doc,
    fieldValues: remapValuesByKey(doc.fieldValues, oldHeaderFields, newHeaderFields),
    invoiceHeader: remapValuesByKey(
      doc.invoiceHeader,
      oldHeaderFields,
      newHeaderFields,
    ),
    sublistRows: remapSublistRows(doc.sublistRows, oldSublistColumns, newSublistColumns),
    invoiceEntries: doc.invoiceEntries.map((entry) => ({
      ...entry,
      fieldValues: remapValuesByKey(
        entry.fieldValues,
        oldHeaderFields,
        newHeaderFields,
      ),
      sublistRows: entry.sublistRows
        ? remapSublistRows(entry.sublistRows, oldSublistColumns, newSublistColumns)
        : entry.sublistRows,
    })),
  }
}

export function applyTemplateToBatch(
  batch: LabelBatch,
  templateId: string,
): LabelBatch {
  const template = getLabelTemplate(templateId)
  if (templateId === batch.layoutTemplateId) return batch

  const newHeaderFields = template.headerFields.map((field) => ({ ...field }))
  const newSublistColumns = template.sublistColumns.map((column) => ({ ...column }))

  return {
    ...batch,
    layoutTemplateId: templateId,
    headerFields: newHeaderFields,
    sublistColumns: newSublistColumns,
    documents: batch.documents.map((doc) =>
      remapDocument(
        doc,
        batch.headerFields,
        newHeaderFields,
        batch.sublistColumns,
        newSublistColumns,
      ),
    ),
    updatedAt: new Date().toISOString(),
  }
}

export function buildDefaultHeaderValues(
  template: LabelLayoutTemplate,
): Record<string, string> {
  if (!template.defaultHeaderValues) return {}

  const result: Record<string, string> = {}
  for (const field of template.headerFields) {
    const value = template.defaultHeaderValues[field.key]
    if (value) result[field.id] = value
  }
  return result
}

export function buildDefaultSublistRows(
  template: LabelLayoutTemplate,
): SublistRow[] {
  if (!template.defaultSublistRows?.length) {
    return [{ id: createTemplateRowId(), cells: {} }]
  }

  return template.defaultSublistRows.map((rowByKey) => {
    const cells: Record<string, string> = {}
    for (const column of template.sublistColumns) {
      const value = rowByKey[column.key]
      if (value) cells[column.id] = value
    }
    return { id: createTemplateRowId(), cells }
  })
}

export function applyTemplateDefaultsToInvoiceEntry(
  template: LabelLayoutTemplate,
): Pick<InvoiceEntry, 'fieldValues' | 'sublistRows'> {
  return {
    fieldValues: buildDefaultHeaderValues(template),
    sublistRows: buildDefaultSublistRows(template),
  }
}

export function applyTemplateDefaultsToDocument(
  doc: LabelDocument,
  template: LabelLayoutTemplate,
): Partial<LabelDocument> {
  if (doc.structureType === 'multi_invoice_with_sublist') {
    return {
      invoiceEntries: doc.invoiceEntries.map((entry) => ({
        ...entry,
        ...applyTemplateDefaultsToInvoiceEntry(template),
      })),
    }
  }

  if (doc.structureType === 'invoice_with_sublist') {
    return {
      invoiceHeader: {
        ...doc.invoiceHeader,
        ...buildDefaultHeaderValues(template),
      },
      sublistRows: buildDefaultSublistRows(template),
    }
  }

  return {}
}
