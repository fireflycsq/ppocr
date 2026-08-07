import type { LabelLayoutTemplate } from './labelTemplates'
import { getLabelTemplate, LABEL_TEMPLATES } from './labelTemplates'
import { amountsMatch, parseAmount } from './amountUtils'

/**
 * 识别准确率统计：
 * 将「预识别结果 JSON」与「答案 JSON」按文件名配对，逐字段比对，
 * 统计整单全对率、各字段准确率，并挑出错误样本。
 * 两侧 JSON 均为本系统导出的单文档 payload（fields / invoices /
 * invoice+sublist / invoicesWithSublist 四种结构），也兼容批量导出的
 * documents 数组。
 */

export interface NormalizedInvoice {
  header: Record<string, string>
  sublist: Array<Record<string, string>>
}

export interface NormalizedDoc {
  /** 展示用文件名（优先取 payload 内 fileName，否则用压缩包内文件名） */
  fileName: string
  /** 配对用 key：去目录、去 .json/.pdf 后缀、小写 */
  matchKey: string
  /** 识别结果导出时携带的版式 id（extraction.layoutTemplateId） */
  templateId: string | null
  invoices: NormalizedInvoice[]
}

function coerceString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function coerceStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    result[key] = coerceString(item)
  }
  return result
}

function coerceRecordArray(value: unknown): Array<Record<string, string>> {
  if (!Array.isArray(value)) return []
  return value.map((item) => coerceStringRecord(item))
}

/** 文件名 → 配对 key：去目录、去 .json / .pdf 后缀、小写 */
export function fileMatchKey(name: string): string {
  const base = name.split('/').pop()?.split('\\').pop() ?? name
  return base
    .replace(/\.json$/i, '')
    .replace(/\.pdf$/i, '')
    .trim()
    .toLowerCase()
}

/** 从单文档导出 payload 中还原发票列表（四种结构统一为 invoices 形态） */
function normalizeInvoices(payload: Record<string, unknown>): NormalizedInvoice[] {
  if (Array.isArray(payload.invoicesWithSublist)) {
    return payload.invoicesWithSublist.map((item) => {
      const record =
        typeof item === 'object' && item !== null && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : {}
      return {
        header: coerceStringRecord(record.invoice),
        sublist: coerceRecordArray(record.sublist),
      }
    })
  }
  if (payload.invoice !== undefined || payload.sublist !== undefined) {
    return [
      {
        header: coerceStringRecord(payload.invoice),
        sublist: coerceRecordArray(payload.sublist),
      },
    ]
  }
  if (Array.isArray(payload.invoices)) {
    return payload.invoices.map((item) => ({
      header: coerceStringRecord(item),
      sublist: [],
    }))
  }
  if (payload.fields !== undefined) {
    return [{ header: coerceStringRecord(payload.fields), sublist: [] }]
  }
  return []
}

function normalizeSingleDoc(
  payload: Record<string, unknown>,
  fallbackName: string,
): NormalizedDoc {
  const fileName =
    typeof payload.fileName === 'string' && payload.fileName.trim()
      ? payload.fileName.trim()
      : fallbackName
  const extraction =
    typeof payload.extraction === 'object' &&
    payload.extraction !== null &&
    !Array.isArray(payload.extraction)
      ? (payload.extraction as Record<string, unknown>)
      : null
  const templateId =
    typeof extraction?.layoutTemplateId === 'string'
      ? extraction.layoutTemplateId
      : null
  return {
    fileName,
    matchKey: fileMatchKey(fileName),
    templateId,
    invoices: normalizeInvoices(payload),
  }
}

/** 解析一个 JSON 文件文本；批量导出（documents 数组）会展开成多个文档 */
export function parseExportJson(text: string, sourceName: string): NormalizedDoc[] {
  const parsed = JSON.parse(text) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('不是导出格式的 JSON 对象')
  }
  const payload = parsed as Record<string, unknown>
  if (Array.isArray(payload.documents)) {
    return payload.documents
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null && !Array.isArray(item),
      )
      .map((doc) => normalizeSingleDoc(doc, sourceName))
  }
  return [normalizeSingleDoc(payload, sourceName)]
}

/** 金额类字段用数值比对（1,500.00 与 1500.00 视为一致） */
const AMOUNT_FIELD_KEYS = new Set(['total', 'charges_in_hkd', 'total_hkd'])

/** 重量/体积：数值一致即可（1.50 KG 与 1.5 KG / 1.5kg 视为一致） */
const MEASURE_FIELD_KEYS = new Set(['weight', 'volume'])

const MONTH_INDEX: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
}

/**
 * 文本归一：
 * - 中英文逗号统一为 `,`（， → ,）
 * - 中英文短横统一为 `-`（－—–─ → -），并去掉短横两侧空格（A - B / A- B / A -B → A-B）
 * - 压缩连续空白
 * - 去掉斜杠两侧空白（A / B、A/ B、A /B 均视为 A/B）
 * - 去首尾空白
 */
function normalizeText(value: string): string {
  return value
    .replace(/，/g, ',')
    .replace(/[－—–─]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\s*\/\s*/g, '/')
    .trim()
}

function isMeasureField(key: string): boolean {
  if (MEASURE_FIELD_KEYS.has(key)) return true
  return /^(gross_|net_|chargeable_)?(weight|volume|wt|vol)(_|$)/i.test(key)
}

function isDateField(key: string): boolean {
  return /date/i.test(key)
}

/** 解析「数值 + 可选单位」，如 1.50 KG、1.5kg、0.50CBM */
function parseMeasuredValue(
  value: string,
): { num: number; unit: string } | null {
  const trimmed = value.trim()
  const match = trimmed.match(/^(-?[\d,]*\.?\d+)\s*(.*)$/)
  if (!match) return null
  const num = parseFloat(match[1].replace(/,/g, ''))
  if (!Number.isFinite(num)) return null
  const unit = match[2].replace(/\s+/g, '').toLowerCase()
  return { num, unit }
}

function expandYear(year: number): number {
  if (year >= 100) return year
  // 发票场景：00–79 → 2000–2079，80–99 → 1980–1999
  return year < 80 ? 2000 + year : 1900 + year
}

function toIsoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const dt = new Date(Date.UTC(year, month - 1, day))
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null
  }
  const mm = String(month).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  return `${year}-${mm}-${dd}`
}

function resolveMonthToken(token: string): number | null {
  const key = token.trim().toLowerCase()
  if (MONTH_INDEX[key] != null) return MONTH_INDEX[key]
  const short = key.slice(0, 3)
  return MONTH_INDEX[short] ?? null
}

/**
 * 将常见发票日期解析为 YYYY-MM-DD。
 * 支持：13 Nov 2025、13-Nov-25、2025-11-13、13/11/2025、2025年11月13日、Nov 13, 2025 等。
 * 纯数字日期默认按日/月/年（航运单证常见）；若第一段>12 则必然是日在前。
 */
export function parseDateToIso(value: string): string | null {
  const text = normalizeText(value)
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null

  // 2025年11月13日
  let match = text.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?$/i)
  if (match) {
    return toIsoDate(Number(match[1]), Number(match[2]), Number(match[3]))
  }

  // 2025-11-13 / 2025/11/13 / 2025.11.13
  match = text.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/)
  if (match) {
    return toIsoDate(Number(match[1]), Number(match[2]), Number(match[3]))
  }

  // 13 Nov 2025 / 13-Nov-25 / 13/Nov/2025
  match = text.match(/^(\d{1,2})[/\-. ]([A-Za-z]{3,9})[/\-. ](\d{2,4})$/)
  if (match) {
    const month = resolveMonthToken(match[2])
    if (month == null) return null
    return toIsoDate(expandYear(Number(match[3])), month, Number(match[1]))
  }

  // Nov 13, 2025 / November 13 2025
  match = text.match(/^([A-Za-z]{3,9})[/\-. ](\d{1,2})[/\-. ](\d{2,4})$/)
  if (match) {
    const month = resolveMonthToken(match[1])
    if (month == null) return null
    return toIsoDate(expandYear(Number(match[3])), month, Number(match[2]))
  }

  // 13/11/2025、13-11-25、13.11.2025（默认日/月/年）
  match = text.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/)
  if (match) {
    let day = Number(match[1])
    let month = Number(match[2])
    const year = expandYear(Number(match[3]))
    // 01/13/2025 这类：第二段>12，按月/日/年理解
    if (month > 12 && day <= 12) {
      const swappedDay = month
      month = day
      day = swappedDay
    }
    return toIsoDate(year, month, day)
  }

  return null
}

export function fieldValuesEqual(key: string, answer: string, actual: string): boolean {
  const a = normalizeText(answer)
  const b = normalizeText(actual)
  // 大小写不敏感 + 空白/斜杠空格归一后全等
  if (a.toLowerCase() === b.toLowerCase()) return true
  if (!a || !b) return false

  if (AMOUNT_FIELD_KEYS.has(key)) {
    return amountsMatch(parseAmount(a), parseAmount(b))
  }

  if (isMeasureField(key)) {
    const ma = parseMeasuredValue(a)
    const mb = parseMeasuredValue(b)
    if (!ma || !mb || !amountsMatch(ma.num, mb.num)) return false
    // 两侧都有单位时要求单位一致（忽略大小写与空格）；一侧无单位则只比数值
    if (ma.unit && mb.unit && ma.unit !== mb.unit) return false
    return true
  }

  if (isDateField(key)) {
    const da = parseDateToIso(a)
    const db = parseDateToIso(b)
    if (da && db && da === db) return true
  }

  return false
}

export type ErrorKind =
  | 'field_mismatch'
  | 'missing_row'
  | 'extra_row'
  | 'missing_invoice'
  | 'extra_invoice'

export const ERROR_KIND_LABELS: Record<ErrorKind, string> = {
  field_mismatch: '字段不一致',
  missing_row: '漏识别明细行',
  extra_row: '多识别明细行',
  missing_invoice: '漏识别发票',
  extra_invoice: '多识别发票',
}

export interface DocErrorDetail {
  kind: ErrorKind
  /** 位置描述，如「发票1 · 明细行2」 */
  location: string
  fieldKey: string
  fieldLabel: string
  expected: string
  actual: string
}

export interface DocComparison {
  fileName: string
  templateId: string
  errors: DocErrorDetail[]
  allCorrect: boolean
  /** 字段位次计数（供聚合）：key → {total, correct} */
  headerCounts: Map<string, { total: number; correct: number }>
  sublistCounts: Map<string, { total: number; correct: number }>
  answerRows: number
  matchedRows: number
  missingRows: number
  extraRows: number
}

function findInvoiceNoKey(template: LabelLayoutTemplate): string | null {
  const match = template.headerFields.find((field) =>
    /invoice.*(no|number)|发票号/i.test(`${field.key} ${field.label}`),
  )
  return match?.key ?? template.headerFields[0]?.key ?? null
}

/** 明细行配对列：优先版式必填列（运单号/描述），否则第一列 */
function sublistMatchKey(template: LabelLayoutTemplate): string | null {
  return (
    template.requiredSublistKeys?.[0] ?? template.sublistColumns[0]?.key ?? null
  )
}

function bump(
  counts: Map<string, { total: number; correct: number }>,
  key: string,
  correct: boolean,
) {
  const entry = counts.get(key) ?? { total: 0, correct: 0 }
  entry.total += 1
  if (correct) entry.correct += 1
  counts.set(key, entry)
}

/** 按配对列贪心对齐两侧明细行；配不上的按剩余顺序对齐 */
function alignRows(
  answerRows: Array<Record<string, string>>,
  resultRows: Array<Record<string, string>>,
  matchKey: string | null,
): Array<{ answer: Record<string, string>; result: Record<string, string> | null }> {
  const used = new Array<boolean>(resultRows.length).fill(false)
  const pairs: Array<{
    answer: Record<string, string>
    result: Record<string, string> | null
  }> = answerRows.map((answer) => {
    if (!matchKey) return { answer, result: null }
    const target = normalizeText(answer[matchKey] ?? '').toLowerCase()
    if (!target) return { answer, result: null }
    const index = resultRows.findIndex(
      (row, i) =>
        !used[i] && normalizeText(row[matchKey] ?? '').toLowerCase() === target,
    )
    if (index < 0) return { answer, result: null }
    used[index] = true
    return { answer, result: resultRows[index] }
  })
  // 配对列没配上的，按顺序吃掉剩余行（容忍配对列本身识别错误）
  for (const pair of pairs) {
    if (pair.result) continue
    const index = used.findIndex((flag) => !flag)
    if (index < 0) break
    used[index] = true
    pair.result = resultRows[index]
  }
  return pairs
}

interface InvoicePair {
  answer: NormalizedInvoice | null
  result: NormalizedInvoice | null
}

function alignInvoices(
  answerInvoices: NormalizedInvoice[],
  resultInvoices: NormalizedInvoice[],
  invoiceNoKey: string | null,
): InvoicePair[] {
  const used = new Array<boolean>(resultInvoices.length).fill(false)
  const pairs: InvoicePair[] = answerInvoices.map((answer) => {
    if (!invoiceNoKey) return { answer, result: null }
    const target = normalizeText(answer.header[invoiceNoKey] ?? '').toLowerCase()
    if (!target) return { answer, result: null }
    const index = resultInvoices.findIndex(
      (inv, i) =>
        !used[i] &&
        normalizeText(inv.header[invoiceNoKey] ?? '').toLowerCase() === target,
    )
    if (index < 0) return { answer, result: null }
    used[index] = true
    return { answer, result: resultInvoices[index] }
  })
  for (const pair of pairs) {
    if (pair.result) continue
    const index = used.findIndex((flag) => !flag)
    if (index < 0) break
    used[index] = true
    pair.result = resultInvoices[index]
  }
  const extras: InvoicePair[] = resultInvoices
    .filter((_inv, i) => !used[i])
    .map((inv) => ({ answer: null, result: inv }))
  return [...pairs, ...extras]
}

/** 比对一对文档（答案 vs 识别结果），产出错误明细与字段计数 */
export function compareDocPair(
  fileName: string,
  templateId: string,
  answer: NormalizedDoc,
  result: NormalizedDoc,
): DocComparison {
  const template = getLabelTemplate(templateId)
  const invoiceNoKey = findInvoiceNoKey(template)
  const rowKey = sublistMatchKey(template)

  const errors: DocErrorDetail[] = []
  const headerCounts = new Map<string, { total: number; correct: number }>()
  const sublistCounts = new Map<string, { total: number; correct: number }>()
  let answerRows = 0
  let matchedRows = 0
  let missingRows = 0
  let extraRows = 0

  const invoicePairs = alignInvoices(answer.invoices, result.invoices, invoiceNoKey)

  invoicePairs.forEach((pair, pairIndex) => {
    const invoiceLabel = `发票${pairIndex + 1}`

    if (!pair.answer) {
      // 识别结果多出来的发票
      errors.push({
        kind: 'extra_invoice',
        location: invoiceLabel,
        fieldKey: invoiceNoKey ?? '',
        fieldLabel: '发票',
        expected: '',
        actual: invoiceNoKey ? (pair.result?.header[invoiceNoKey] ?? '') : '',
      })
      extraRows += pair.result?.sublist.length ?? 0
      return
    }

    const resultInvoice = pair.result

    if (!resultInvoice) {
      errors.push({
        kind: 'missing_invoice',
        location: invoiceLabel,
        fieldKey: invoiceNoKey ?? '',
        fieldLabel: '发票',
        expected: invoiceNoKey ? (pair.answer.header[invoiceNoKey] ?? '') : '',
        actual: '',
      })
      for (const field of template.headerFields) {
        bump(headerCounts, field.key, false)
      }
      for (let i = 0; i < pair.answer.sublist.length; i++) {
        answerRows += 1
        missingRows += 1
        for (const column of template.sublistColumns) {
          bump(sublistCounts, column.key, false)
        }
      }
      return
    }

    // 发票头字段比对
    for (const field of template.headerFields) {
      const expected = pair.answer.header[field.key] ?? ''
      const actual = resultInvoice.header[field.key] ?? ''
      const equal = fieldValuesEqual(field.key, expected, actual)
      bump(headerCounts, field.key, equal)
      if (!equal) {
        errors.push({
          kind: 'field_mismatch',
          location: `${invoiceLabel} · 发票头`,
          fieldKey: field.key,
          fieldLabel: field.label,
          expected,
          actual,
        })
      }
    }

    // 明细行比对
    const rowPairs = alignRows(pair.answer.sublist, resultInvoice.sublist, rowKey)
    const usedResultRows = rowPairs.filter((row) => row.result).length
    rowPairs.forEach((rowPair, rowIndex) => {
      answerRows += 1
      const rowLabel = `${invoiceLabel} · 明细行${rowIndex + 1}`
      if (!rowPair.result) {
        missingRows += 1
        errors.push({
          kind: 'missing_row',
          location: rowLabel,
          fieldKey: rowKey ?? '',
          fieldLabel: '明细行',
          expected: rowKey ? (rowPair.answer[rowKey] ?? '') : '',
          actual: '',
        })
        for (const column of template.sublistColumns) {
          bump(sublistCounts, column.key, false)
        }
        return
      }
      matchedRows += 1
      for (const column of template.sublistColumns) {
        const expected = rowPair.answer[column.key] ?? ''
        const actual = rowPair.result[column.key] ?? ''
        const equal = fieldValuesEqual(column.key, expected, actual)
        bump(sublistCounts, column.key, equal)
        if (!equal) {
          errors.push({
            kind: 'field_mismatch',
            location: rowLabel,
            fieldKey: column.key,
            fieldLabel: column.label,
            expected,
            actual,
          })
        }
      }
    })

    const extraCount = resultInvoice.sublist.length - usedResultRows
    if (extraCount > 0) {
      extraRows += extraCount
      errors.push({
        kind: 'extra_row',
        location: invoiceLabel,
        fieldKey: rowKey ?? '',
        fieldLabel: '明细行',
        expected: '',
        actual: `多出 ${extraCount} 行`,
      })
    }
  })

  return {
    fileName,
    templateId,
    errors,
    allCorrect: errors.length === 0,
    headerCounts,
    sublistCounts,
    answerRows,
    matchedRows,
    missingRows,
    extraRows,
  }
}

/** 无版式 id 时按字段 key 推断（GEODIS 字段集独有；FedEx/DHL 字段相同，归入 air_waybill） */
export function inferTemplateId(docs: NormalizedDoc[]): string {
  const keys = new Set<string>()
  for (const doc of docs) {
    for (const invoice of doc.invoices) {
      for (const key of Object.keys(invoice.header)) keys.add(key)
      for (const row of invoice.sublist) {
        for (const key of Object.keys(row)) keys.add(key)
      }
    }
  }
  let best: { id: string; score: number } | null = null
  for (const template of LABEL_TEMPLATES) {
    const templateKeys = [
      ...template.headerFields.map((f) => f.key),
      ...template.sublistColumns.map((c) => c.key),
    ]
    const score = templateKeys.filter((key) => keys.has(key)).length / templateKeys.length
    if (!best || score > best.score) best = { id: template.id, score }
  }
  return best?.id ?? LABEL_TEMPLATES[0].id
}

export interface FieldStat {
  key: string
  label: string
  total: number
  correct: number
}

export interface TemplateAccuracyReport {
  templateId: string
  templateName: string
  docTotal: number
  docAllCorrect: number
  headerFieldStats: FieldStat[]
  sublistFieldStats: FieldStat[]
  answerRows: number
  matchedRows: number
  missingRows: number
  extraRows: number
  /** 有错误的样本（错误样本分析列表） */
  errorDocs: DocComparison[]
}

export interface AccuracyReport {
  matchedPairs: number
  docAllCorrect: number
  templates: TemplateAccuracyReport[]
  /** 只有识别结果、找不到答案的文件 */
  unmatchedResults: string[]
  /** 只有答案、找不到识别结果的文件 */
  unmatchedAnswers: string[]
}

function aggregateFieldStats(
  comparisons: DocComparison[],
  pick: (item: DocComparison) => Map<string, { total: number; correct: number }>,
  fields: Array<{ key: string; label: string }>,
): FieldStat[] {
  return fields
    .map((field) => {
      let total = 0
      let correct = 0
      for (const item of comparisons) {
        const entry = pick(item).get(field.key)
        if (entry) {
          total += entry.total
          correct += entry.correct
        }
      }
      return { key: field.key, label: field.label, total, correct }
    })
    .filter((stat) => stat.total > 0)
}

/** 主入口：答案文档 + 识别结果文档 → 全量统计报告 */
export function buildAccuracyReport(
  answerDocs: NormalizedDoc[],
  resultDocs: NormalizedDoc[],
): AccuracyReport {
  const resultByKey = new Map<string, NormalizedDoc>()
  for (const doc of resultDocs) {
    if (!resultByKey.has(doc.matchKey)) resultByKey.set(doc.matchKey, doc)
  }

  const fallbackTemplateId = inferTemplateId([...answerDocs, ...resultDocs])
  const comparisons: DocComparison[] = []
  const matchedKeys = new Set<string>()
  const unmatchedAnswers: string[] = []

  for (const answer of answerDocs) {
    const result = resultByKey.get(answer.matchKey)
    if (!result) {
      unmatchedAnswers.push(answer.fileName)
      continue
    }
    matchedKeys.add(answer.matchKey)
    const templateId =
      result.templateId ?? answer.templateId ?? inferTemplateId([answer, result])
    comparisons.push(
      compareDocPair(
        answer.fileName,
        templateId || fallbackTemplateId,
        answer,
        result,
      ),
    )
  }

  const unmatchedResults = resultDocs
    .filter((doc) => !matchedKeys.has(doc.matchKey))
    .map((doc) => doc.fileName)

  const templateIds = [...new Set(comparisons.map((item) => item.templateId))]
  const templates: TemplateAccuracyReport[] = templateIds.map((templateId) => {
    const template = getLabelTemplate(templateId)
    const group = comparisons.filter((item) => item.templateId === templateId)
    return {
      templateId,
      templateName: template.name,
      docTotal: group.length,
      docAllCorrect: group.filter((item) => item.allCorrect).length,
      headerFieldStats: aggregateFieldStats(
        group,
        (item) => item.headerCounts,
        template.headerFields,
      ),
      sublistFieldStats: aggregateFieldStats(
        group,
        (item) => item.sublistCounts,
        template.sublistColumns,
      ),
      answerRows: group.reduce((sum, item) => sum + item.answerRows, 0),
      matchedRows: group.reduce((sum, item) => sum + item.matchedRows, 0),
      missingRows: group.reduce((sum, item) => sum + item.missingRows, 0),
      extraRows: group.reduce((sum, item) => sum + item.extraRows, 0),
      errorDocs: group.filter((item) => !item.allCorrect),
    }
  })

  return {
    matchedPairs: comparisons.length,
    docAllCorrect: comparisons.filter((item) => item.allCorrect).length,
    templates,
    unmatchedResults,
    unmatchedAnswers,
  }
}

export function percentage(correct: number, total: number): string {
  if (total <= 0) return '—'
  return `${((correct / total) * 100).toFixed(1)}%`
}
