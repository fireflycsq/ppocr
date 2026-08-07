export interface MergeableInvoice {
  header: Record<string, string>
  sublist: Array<Record<string, string>>
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

/** 在已有发票中找「发票号编辑距离 ≤ maxDistance」的匹配项 */
export function findInvoiceByEditDistance<T extends MergeableInvoice>(
  invoices: T[],
  invoiceNoKey: string,
  invoiceNo: string,
  maxDistance: number,
): T | undefined {
  if (!invoiceNo) return undefined
  let best: T | undefined
  let bestDistance = maxDistance + 1
  for (const invoice of invoices) {
    const existingNo = invoice.header[invoiceNoKey] ?? ''
    if (!existingNo) continue
    const distance = editDistance(existingNo, invoiceNo)
    if (distance <= maxDistance && distance < bestDistance) {
      best = invoice
      bestDistance = distance
    }
  }
  return best
}

/**
 * DHL：跨页多发票号若编辑距离 ≤ 1，合并子清单到长度为 13 的发票号下。
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

    for (const [key, value] of Object.entries(invoice.header)) {
      if (!existing.header[key] && value) existing.header[key] = value
    }
    existing.sublist.push(...invoice.sublist)

    const existingNo = existing.header[invoiceNoKey] ?? ''
    // 优先保留长度为 13 的发票号；两边都不是 13 时保留较长者
    if (invoiceNo.length === 13 && existingNo.length !== 13) {
      existing.header[invoiceNoKey] = invoiceNo
    } else if (
      invoiceNo.length !== 13 &&
      existingNo.length !== 13 &&
      invoiceNo.length > existingNo.length
    ) {
      existing.header[invoiceNoKey] = invoiceNo
    }
  }
  return merged
}
