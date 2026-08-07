export interface MergeableInvoice {
  header: Record<string, string>
  sublist: Array<Record<string, string>>
}

/** 发票号比对前归一：去空白、转大写 */
export function normalizeInvoiceNo(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase()
}

/** 编辑距离（Levenshtein），用于 DHL 跨页发票号容错合并 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  const prev = new Array<number>(b.length + 1)
  const curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]
  }
  return prev[b.length]
}

/**
 * 在已有发票中找「发票号编辑距离 ≤ maxDistance」的匹配项。
 * 距离并列时取最先出现的那张（第一张目标单证）。
 */
export function findInvoiceByEditDistance<T extends MergeableInvoice>(
  invoices: T[],
  invoiceNoKey: string,
  invoiceNo: string,
  maxDistance: number,
): T | undefined {
  const target = normalizeInvoiceNo(invoiceNo)
  if (!target) return undefined
  let best: T | undefined
  let bestDistance = maxDistance + 1
  for (const invoice of invoices) {
    const existingNo = normalizeInvoiceNo(invoice.header[invoiceNoKey] ?? '')
    if (!existingNo) continue
    const distance = editDistance(existingNo, target)
    // 严格 < ：距离相等时保留先出现的第一张
    if (distance <= maxDistance && distance < bestDistance) {
      best = invoice
      bestDistance = distance
    }
  }
  return best
}

function mergeHeaderInto(
  target: MergeableInvoice,
  source: MergeableInvoice,
  invoiceNoKey: string,
): void {
  const keepInvoiceNo = target.header[invoiceNoKey] ?? ''
  for (const [key, value] of Object.entries(source.header)) {
    if (key === invoiceNoKey) continue
    if (!target.header[key] && value) target.header[key] = value
  }
  // 编辑距离命中时，始终保留第一张目标单证的发票号
  if (keepInvoiceNo) {
    target.header[invoiceNoKey] = keepInvoiceNo
  } else if (source.header[invoiceNoKey]) {
    target.header[invoiceNoKey] = source.header[invoiceNoKey]
  }
  target.sublist.push(...source.sublist)
}

/**
 * DHL：跨页多发票号若编辑距离 ≤ 1，合并子清单到「第一张」目标单证下，
 * 并始终保留第一张的发票号（不再用后续页的 13 位号覆盖）。
 */
export function mergeDhlInvoicesByInvoiceNo<T extends MergeableInvoice>(
  invoices: T[],
  invoiceNoKey: string,
): T[] {
  if (invoices.length <= 1) return invoices

  const merged: T[] = []
  for (const invoice of invoices) {
    const invoiceNo = invoice.header[invoiceNoKey] ?? ''
    const existing = invoiceNo
      ? findInvoiceByEditDistance(merged, invoiceNoKey, invoiceNo, 1)
      : undefined

    if (!existing) {
      merged.push(invoice)
      continue
    }

    mergeHeaderInto(existing, invoice, invoiceNoKey)
  }
  return merged
}

/**
 * DHL 单 PDF 默认「发票 + 子清单」：将所有发票折叠为第一张，
 * 子清单全部归并，发票号固定为第一张目标单证的发票号。
 */
export function collapseDhlToFirstInvoice<T extends MergeableInvoice>(
  invoices: T[],
  invoiceNoKey: string,
): T[] {
  if (invoices.length <= 1) return invoices
  const [first, ...rest] = invoices
  for (const invoice of rest) {
    mergeHeaderInto(first, invoice, invoiceNoKey)
  }
  return [first]
}
