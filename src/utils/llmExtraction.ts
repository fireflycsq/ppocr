import { extractPageWithLlm, formatLlmStreamText, LlmOutputError, type LlmStreamSnapshot } from '../api/llm'
import type { InvoiceEntry, SublistRow, TargetStructureType } from '../types/labeling'
import type { LabelLayoutTemplate } from './labelTemplates'
import { buildPageRequestBody } from './llmConfig'
import type { PdfPageImage } from './pdfPageImages'
import { processPdfPages } from './pdfPageImages'
import type { ModelPageImagePreview } from './downloadModelPageImage'
import {
  createEmptyInvoiceEntry,
  createEmptySublistRow,
  createInvoiceEntryId,
  createSublistRowId,
} from './labelingStorage'

export type PageStatus = 'target' | 'skipped' | 'error'

export interface PageOutcome {
  pageIndex: number
  status: PageStatus
  error?: string
  /** 模型对该页的原始输出，用于排查提示词/字段问题 */
  raw?: string
}

/** 按字段 key 聚合后的一张发票 */
export interface AggregatedInvoice {
  header: Record<string, string>
  sublist: Array<Record<string, string>>
}

export interface PdfExtractionResult {
  structureType: TargetStructureType
  invoices: AggregatedInvoice[]
  pageOutcomes: PageOutcome[]
}

function coerceValue(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** 只保留版式定义过的字段 key；无值或空值统一为 '' */
function coerceRecord(
  raw: Record<string, unknown>,
  allowedKeys: Set<string>,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const key of allowedKeys) {
    result[key] = coerceValue(raw[key])
  }
  return result
}

function hasValues(record: Record<string, string>): boolean {
  return Object.values(record).some((v) => v.length > 0)
}

function findInvoiceNoKey(template: LabelLayoutTemplate): string | null {
  const match = template.headerFields.find((field) =>
    /invoice.*(no|number)|发票号/i.test(`${field.key} ${field.label}`),
  )
  return match?.key ?? template.headerFields[0]?.key ?? null
}

export type { ModelPageImagePreview } from './downloadModelPageImage'

export interface LlmStreamEvent {
  pageIndex: number
  totalPages: number
  snapshot: LlmStreamSnapshot
  text: string
}

export interface ExtractPdfParams {
  images: PdfPageImage[]
  /** 完整的 Ollama /api/chat 请求 JSON 文本（含页图片占位符） */
  requestJson: string
  template: LabelLayoutTemplate
  signal?: AbortSignal
  /** 每完成一页（无论成功/跳过/失败）回调一次 */
  onPageDone?: (outcome: PageOutcome, done: number, total: number) => void
  onStreamUpdate?: (event: LlmStreamEvent) => void
  /** 每页请求模型前回调，便于预览/下载送入模型的 JPEG */
  onPageImagePrepared?: (image: ModelPageImagePreview) => void
}

export interface ExtractPdfFileParams {
  file: File
  requestJson: string
  template: LabelLayoutTemplate
  signal?: AbortSignal
  onPageDone?: (outcome: PageOutcome, done: number, total: number) => void
  onStreamUpdate?: (event: LlmStreamEvent) => void
  onPageImagePrepared?: (image: ModelPageImagePreview) => void
}

function emitStreamUpdate(
  onStreamUpdate: ExtractPdfFileParams['onStreamUpdate'],
  event: {
    pageIndex: number
    totalPages: number
    snapshot: LlmStreamSnapshot
  },
) {
  if (!onStreamUpdate) return
  onStreamUpdate({
    ...event,
    text: formatLlmStreamText(event.snapshot, { preferCompleteJson: true }),
  })
}

/** 逐页渲染高清图并各请求一次大模型（无低清预判）。 */
export async function extractPdfFileWithLlm(
  params: ExtractPdfFileParams,
): Promise<PdfExtractionResult> {
  const images: PdfPageImage[] = []
  await processPdfPages(params.file, async (page) => {
    if (params.signal?.aborted) throw new DOMException('已中断', 'AbortError')
    images.push(
      await page.render({
        maxDimension: 1600,
        jpegQuality: 0.75,
      }),
    )
  })
  return extractPdfWithLlm({
    images,
    requestJson: params.requestJson,
    template: params.template,
    signal: params.signal,
    onPageDone: params.onPageDone,
    onStreamUpdate: params.onStreamUpdate,
    onPageImagePrepared: params.onPageImagePrepared,
  })
}

/**
 * 逐页调用 Qwen3-VL：每页 1 次请求；模型可返回 is_target 跳过无字段页，
 * 有效页的发票头与子清单跨页聚合成完整结果。
 */
export async function extractPdfWithLlm(
  params: ExtractPdfParams,
): Promise<PdfExtractionResult> {
  const { images, requestJson, template, signal, onPageDone, onStreamUpdate, onPageImagePrepared } =
    params
  const headerKeys = new Set(template.headerFields.map((f) => f.key))
  const sublistKeys = new Set(template.sublistColumns.map((c) => c.key))
  const requiredSublistKeys = (template.requiredSublistKeys ?? []).filter((key) =>
    sublistKeys.has(key),
  )
  /** 明细行必须有值，且必填列（如空运单号）不能为空 */
  const isValidSublistRow = (row: Record<string, string>): boolean =>
    hasValues(row) && requiredSublistKeys.every((key) => row[key]?.length > 0)
  const invoiceNoKey = findInvoiceNoKey(template)
  const totalPages = images.length

  const invoices: AggregatedInvoice[] = []
  /** 出现在第一张发票之前的孤儿明细行（少见，但避免丢数据） */
  const pendingOrphans: Array<Record<string, string>> = []
  const pageOutcomes: PageOutcome[] = []

  for (let i = 0; i < images.length; i++) {
    if (signal?.aborted) throw new DOMException('已中断', 'AbortError')
    const image = images[i]
    let outcome: PageOutcome

    try {
      onPageImagePrepared?.({
        pageIndex: image.pageIndex,
        totalPages,
        base64: image.base64,
        width: image.width,
        height: image.height,
      })
      const body = buildPageRequestBody(requestJson, image.base64)
      const { extraction: raw, rawContent } = await extractPageWithLlm(
        body,
        signal,
        (snapshot) => {
          emitStreamUpdate(onStreamUpdate, {
            pageIndex: image.pageIndex,
            totalPages,
            snapshot,
          })
        },
      )

      if (!raw.isTarget) {
        outcome = { pageIndex: image.pageIndex, status: 'skipped', raw: rawContent }
      } else {
        const pageInvoices = raw.invoices.map((rawInvoice) => ({
          header: coerceRecord(rawInvoice.header, headerKeys),
          sublist: rawInvoice.sublist
            .map((row) => coerceRecord(row, sublistKeys))
            .filter(isValidSublistRow),
        }))
        const orphans = raw.orphanSublist
          .map((row) => coerceRecord(row, sublistKeys))
          .filter(isValidSublistRow)

        const pageHasContent =
          orphans.length > 0 ||
          pageInvoices.some(
            (invoice) => hasValues(invoice.header) || invoice.sublist.length > 0,
          )

        if (!pageHasContent) {
          // 模型判为目标页但没有任何有效字段/必填明细（如缺空运单号），按跳过处理
          outcome = { pageIndex: image.pageIndex, status: 'skipped', raw: rawContent }
        } else {
          for (const { header, sublist } of pageInvoices) {
            const invoiceNo = invoiceNoKey ? (header[invoiceNoKey] ?? '') : ''
            const existing = invoiceNo
              ? invoices.find(
                  (inv) => invoiceNoKey && inv.header[invoiceNoKey] === invoiceNo,
                )
              : undefined

            if (existing) {
              for (const [key, value] of Object.entries(header)) {
                if (!existing.header[key] && value) existing.header[key] = value
              }
              existing.sublist.push(...sublist)
            } else if (!hasValues(header) && invoices.length > 0) {
              invoices[invoices.length - 1].sublist.push(...sublist)
            } else if (hasValues(header) || sublist.length > 0) {
              invoices.push({ header, sublist })
            }
          }

          if (orphans.length > 0) {
            if (invoices.length > 0) {
              invoices[invoices.length - 1].sublist.push(...orphans)
            } else {
              pendingOrphans.push(...orphans)
            }
          }

          outcome = { pageIndex: image.pageIndex, status: 'target', raw: rawContent }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      outcome = {
        pageIndex: image.pageIndex,
        status: 'error',
        error: err instanceof Error ? err.message : '抽取失败',
        raw: err instanceof LlmOutputError ? err.rawContent : undefined,
      }
    }

    pageOutcomes.push(outcome)
    onPageDone?.(outcome, i + 1, totalPages)
  }

  if (pendingOrphans.length > 0) {
    if (invoices.length > 0) {
      invoices[0].sublist.unshift(...pendingOrphans)
    } else {
      invoices.push({ header: {}, sublist: pendingOrphans })
    }
  }

  const hasSublist = invoices.some((inv) => inv.sublist.length > 0)
  const structureType: TargetStructureType =
    invoices.length > 1
      ? hasSublist
        ? 'multi_invoice_with_sublist'
        : 'multi_invoice'
      : hasSublist
        ? 'invoice_with_sublist'
        : 'single'

  return { structureType, invoices, pageOutcomes }
}

/** 与标注页一致的数据形态，四种结构的数据都填充好，便于审核时手动切换结构 */
export interface ReviewDocData {
  structureType: TargetStructureType
  fieldValues: Record<string, string>
  invoiceHeader: Record<string, string>
  sublistRows: SublistRow[]
  invoiceEntries: InvoiceEntry[]
}

function keyRecordToIdRecord(
  record: Record<string, string>,
  fields: LabelLayoutTemplate['headerFields'],
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const field of fields) {
    result[field.id] = record[field.key] ?? ''
  }
  return result
}

function keyRowsToSublistRows(
  rows: Array<Record<string, string>>,
  template: LabelLayoutTemplate,
): SublistRow[] {
  return rows.map((row) => ({
    id: createSublistRowId(),
    cells: keyRecordToIdRecord(row, template.sublistColumns),
  }))
}

export function extractionToReviewData(
  result: PdfExtractionResult,
  template: LabelLayoutTemplate,
): ReviewDocData {
  const first = result.invoices[0]
  const firstHeader = first ? keyRecordToIdRecord(first.header, template.headerFields) : {}
  const firstSublist = first ? keyRowsToSublistRows(first.sublist, template) : []

  const invoiceEntries: InvoiceEntry[] =
    result.invoices.length > 0
      ? result.invoices.map((invoice) => {
          const rows = keyRowsToSublistRows(invoice.sublist, template)
          return {
            id: createInvoiceEntryId(),
            fieldValues: keyRecordToIdRecord(invoice.header, template.headerFields),
            sublistRows: rows.length > 0 ? rows : [createEmptySublistRow()],
          }
        })
      : [createEmptyInvoiceEntry(false)]

  return {
    structureType: result.structureType,
    fieldValues: firstHeader,
    invoiceHeader: firstHeader,
    sublistRows: firstSublist.length > 0 ? firstSublist : [createEmptySublistRow()],
    invoiceEntries,
  }
}

function coerceKeyRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') result[key] = item
    else if (typeof item === 'number' || typeof item === 'boolean') result[key] = String(item)
    else result[key] = ''
  }
  return result
}

/** 从已保存的导出 JSON 恢复审核数据（保留用户修改） */
export function reviewDataFromExportPayload(
  payload: Record<string, unknown>,
  template: LabelLayoutTemplate,
): ReviewDocData | null {
  let invoices: AggregatedInvoice[] = []
  let structureType = (payload.structureType as TargetStructureType) || 'single'

  if (Array.isArray(payload.invoicesWithSublist)) {
    invoices = payload.invoicesWithSublist.map((item) => {
      const record =
        typeof item === 'object' && item !== null && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : {}
      return {
        header: coerceKeyRecord(record.invoice),
        sublist: Array.isArray(record.sublist)
          ? record.sublist.map((row) => coerceKeyRecord(row))
          : [],
      }
    })
    structureType = 'multi_invoice_with_sublist'
  } else if (payload.invoice !== undefined || payload.sublist !== undefined) {
    invoices = [
      {
        header: coerceKeyRecord(payload.invoice),
        sublist: Array.isArray(payload.sublist)
          ? payload.sublist.map((row) => coerceKeyRecord(row))
          : [],
      },
    ]
    structureType = 'invoice_with_sublist'
  } else if (Array.isArray(payload.invoices)) {
    invoices = payload.invoices.map((item) => ({
      header: coerceKeyRecord(item),
      sublist: [],
    }))
    structureType = invoices.length > 1 ? 'multi_invoice' : 'single'
  } else if (payload.fields !== undefined) {
    invoices = [{ header: coerceKeyRecord(payload.fields), sublist: [] }]
    structureType = 'single'
  } else {
    return null
  }

  return extractionToReviewData(
    { structureType, invoices, pageOutcomes: [] },
    template,
  )
}
