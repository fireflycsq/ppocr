import type { FieldDefinition } from '../types'
import type { SublistRow } from '../types/labeling'

const SUBLIST_AMOUNT_KEYS = ['charges_in_hkd', 'total', 'charges', 'amount', 'fee']

const HEADER_TOTAL_KEYS = ['total_hkd', 'total', 'grand_total']

export function parseAmount(value: string): number {
  const cleaned = value.replace(/,/g, '').replace(/[^\d.-]/g, '')
  const num = parseFloat(cleaned)
  return Number.isFinite(num) ? num : 0
}

export function formatAmount(value: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export function findSublistAmountColumn(
  columns: FieldDefinition[],
): FieldDefinition | undefined {
  for (const key of SUBLIST_AMOUNT_KEYS) {
    const found = columns.find((col) => col.key.toLowerCase() === key)
    if (found) return found
  }
  return columns.find(
    (col) =>
      /收费|合计|charges|total/i.test(col.label) &&
      !/description|描述/i.test(col.label),
  )
}

export function findHeaderTotalField(
  fields: FieldDefinition[],
): FieldDefinition | undefined {
  for (const key of HEADER_TOTAL_KEYS) {
    const found = fields.find((field) => field.key.toLowerCase() === key)
    if (found) return found
  }
  return fields.find((field) => /合计|total/i.test(field.label))
}

export function sumSublistAmount(
  rows: SublistRow[],
  amountColumnId: string,
): number {
  return rows.reduce(
    (sum, row) => sum + parseAmount(row.cells[amountColumnId] ?? ''),
    0,
  )
}

export function amountsMatch(a: number, b: number, epsilon = 0.005): boolean {
  return Math.abs(a - b) < epsilon
}
