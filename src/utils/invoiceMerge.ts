export interface MergeableInvoice {
  header: Record<string, string>
  sublist: Array<Record<string, string>>
}

/** 发票号比对前归一：去空白、转大写 */
export function normalizeInvoiceNo(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase()
}

/** FedEx / DHL 空运单版式：跨页合并为「发票 + 子清单」 */
export const AIR_WAYBILL_MERGE_TEMPLATE_IDS = new Set([
  'air_waybill',
  'air_waybill_dhl',
])

/**
 * 统计各发票号出现次数，选出出现最多的作为权威发票号。
 * 次数并列时取最先出现的那个。
 */
export function pickMajorityInvoiceNo(
  counts: Map<string, number>,
): string | null {
  let bestKey: string | null = null
  let bestCount = 0
  for (const [key, count] of counts) {
    if (!key) continue
    if (count > bestCount) {
      bestKey = key
      bestCount = count
    }
  }
  return bestKey
}

function mergeHeaderFields(
  target: MergeableInvoice,
  source: MergeableInvoice,
  invoiceNoKey: string,
): void {
  for (const [key, value] of Object.entries(source.header)) {
    if (key === invoiceNoKey) continue
    if (!target.header[key] && value) target.header[key] = value
  }
  target.sublist.push(...source.sublist)
}

/**
 * FedEx / DHL 统一合并规则：
 * - 按跨页出现次数选出最多的发票号为权威编号；
 * - 所有子清单合并到该发票下；
 * - 其余发票号视为识别错误，丢弃其发票号，仅保留明细。
 * @param invoiceNoCounts 各归一化发票号在抽取过程中出现的次数（按页累计）
 */
export function mergeAirWaybillByMajorityInvoiceNo<T extends MergeableInvoice>(
  invoices: T[],
  invoiceNoKey: string,
  invoiceNoCounts: Map<string, number>,
): T[] {
  if (invoices.length === 0) return invoices

  let majorityKey = pickMajorityInvoiceNo(invoiceNoCounts)
  if (!majorityKey) {
    const firstNo =
      invoices.find((inv) => (inv.header[invoiceNoKey] ?? '').trim())?.header[
        invoiceNoKey
      ] ?? ''
    majorityKey = normalizeInvoiceNo(firstNo) || null
  }

  // 优先用已带权威发票号的那张作为底座；否则用第一张
  let canonical: T | undefined
  if (majorityKey) {
    canonical = invoices.find(
      (inv) => normalizeInvoiceNo(inv.header[invoiceNoKey] ?? '') === majorityKey,
    )
  }
  if (!canonical) canonical = invoices[0]

  // 权威发票号：保留底座上的原文形态；若底座没有则回填出现最多的归一化值
  const canonicalInvoiceNo =
    (normalizeInvoiceNo(canonical.header[invoiceNoKey] ?? '') === majorityKey
      ? canonical.header[invoiceNoKey]
      : '') ||
    majorityKey ||
    ''

  const result: T = {
    ...canonical,
    header: { ...canonical.header },
    sublist: [...canonical.sublist],
  }
  if (canonicalInvoiceNo) {
    result.header[invoiceNoKey] = canonicalInvoiceNo
  }

  for (const invoice of invoices) {
    if (invoice === canonical) continue
    mergeHeaderFields(result, invoice, invoiceNoKey)
  }

  return [result]
}

/** 累计发票号出现次数（空值不计） */
export function bumpInvoiceNoCount(
  counts: Map<string, number>,
  invoiceNo: string,
  weight = 1,
): void {
  const key = normalizeInvoiceNo(invoiceNo)
  if (!key) return
  counts.set(key, (counts.get(key) ?? 0) + Math.max(1, weight))
}

/**
 * 无跨页计次时（如加载已保存结果），用明细行数近似出现次数：
 * 正确发票号通常已吸收更多页的明细，权重更高。
 */
export function estimateInvoiceNoCountsFromInvoices<T extends MergeableInvoice>(
  invoices: T[],
  invoiceNoKey: string,
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const invoice of invoices) {
    bumpInvoiceNoCount(
      counts,
      invoice.header[invoiceNoKey] ?? '',
      Math.max(1, invoice.sublist.length),
    )
  }
  return counts
}
