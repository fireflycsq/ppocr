import { useMemo } from 'react'
import type { SublistRow } from '../../types/labeling'
import type { FieldDefinition } from '../../types'
import {
  amountsMatch,
  findHeaderTotalField,
  findSublistAmountColumn,
  formatAmount,
  parseAmount,
  sumSublistAmount,
} from '../../utils/amountUtils'

function isWideTextColumn(column: FieldDefinition): boolean {
  return (
    column.key === 'description' ||
    column.key === 'air_waybill_number' ||
    /描述|运输单|waybill/i.test(column.label)
  )
}

function getColumnClassName(column: FieldDefinition): string {
  if (isWideTextColumn(column)) {
    return 'sublist-col-description'
  }
  if (
    /charges|total|amount|fee|收费|合计/i.test(column.key) ||
    /收费|合计/i.test(column.label)
  ) {
    return 'sublist-col-amount'
  }
  return 'sublist-col-text'
}

function isDescriptionColumn(column: FieldDefinition): boolean {
  return isWideTextColumn(column)
}

interface SublistTableEditorProps {
  rows: SublistRow[]
  columns: FieldDefinition[]
  headerFields?: FieldDefinition[]
  headerValues?: Record<string, string>
  onAddRow: () => void
  onRemoveRow: (id: string) => void
  onCellChange: (rowId: string, columnId: string, value: string) => void
}

export function SublistTableEditor({
  rows,
  columns,
  headerFields,
  headerValues,
  onAddRow,
  onRemoveRow,
  onCellChange,
}: SublistTableEditorProps) {
  const amountColumn = useMemo(() => findSublistAmountColumn(columns), [columns])
  const headerTotalField = useMemo(
    () => (headerFields ? findHeaderTotalField(headerFields) : undefined),
    [headerFields],
  )

  const sublistTotal = useMemo(() => {
    if (!amountColumn) return null
    return sumSublistAmount(rows, amountColumn.id)
  }, [rows, amountColumn])

  const headerTotal = useMemo(() => {
    if (!headerTotalField || !headerValues) return null
    const raw = headerValues[headerTotalField.id] ?? ''
    if (!raw.trim()) return null
    return parseAmount(raw)
  }, [headerTotalField, headerValues])

  const totalsMatch =
    sublistTotal !== null &&
    headerTotal !== null &&
    amountsMatch(sublistTotal, headerTotal)

  const totalsMismatch =
    sublistTotal !== null &&
    headerTotal !== null &&
    !amountsMatch(sublistTotal, headerTotal)

  if (columns.length === 0) {
    return <p className="label-hint">请先在下方配置子清单表格列</p>
  }

  return (
    <div className="sublist-table-editor">
      <div className="sublist-table-toolbar">
        <span>共 {rows.length} 行明细</span>
        <button type="button" className="btn btn-outline btn-sm" onClick={onAddRow}>
          + 添加行
        </button>
      </div>

      <div className="sublist-table-wrap">
        <table className="sublist-table">
          <thead>
            <tr>
              <th className="sublist-row-num">#</th>
              {columns.map((col) => (
                <th key={col.id} className={getColumnClassName(col)}>
                  {col.label}
                </th>
              ))}
              <th className="sublist-row-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.id}>
                <td className="sublist-row-num">{index + 1}</td>
                {columns.map((col) => (
                  <td key={col.id} className={getColumnClassName(col)}>
                    {isDescriptionColumn(col) ? (
                      <textarea
                        className="sublist-cell-input sublist-cell-textarea"
                        value={row.cells[col.id] ?? ''}
                        onChange={(e) => onCellChange(row.id, col.id, e.target.value)}
                        placeholder={col.label}
                        rows={2}
                      />
                    ) : (
                      <input
                        type="text"
                        className="sublist-cell-input"
                        value={row.cells[col.id] ?? ''}
                        onChange={(e) => onCellChange(row.id, col.id, e.target.value)}
                        placeholder={col.label}
                      />
                    )}
                  </td>
                ))}
                <td className="sublist-row-actions">
                  {rows.length > 1 && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => onRemoveRow(row.id)}
                    >
                      删除
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          {amountColumn && sublistTotal !== null && (
            <tfoot>
              <tr className="sublist-total-row">
                <td className="sublist-row-num" />
                {columns.map((col) => (
                  <td key={col.id} className={getColumnClassName(col)}>
                    {col.id === amountColumn.id ? (
                      <strong className="sublist-total-value">
                        合计 {formatAmount(sublistTotal)}
                      </strong>
                    ) : col.key === 'description' || /描述/i.test(col.label) ? (
                      <span className="sublist-total-label">明细合计</span>
                    ) : null}
                  </td>
                ))}
                <td className="sublist-row-actions" />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {amountColumn && sublistTotal !== null && (
        <div className="sublist-amount-summary">
          <span>
            明细合计：<strong>{formatAmount(sublistTotal)}</strong>
          </span>
          {headerTotalField && headerTotal !== null && (
            <span>
              发票头 {headerTotalField.label}：<strong>{formatAmount(headerTotal)}</strong>
            </span>
          )}
          {totalsMatch && (
            <span className="sublist-amount-match">一致，可核对行数与金额</span>
          )}
          {totalsMismatch && (
            <span className="sublist-amount-mismatch">
              不一致，请检查是否漏行、多行或金额录入有误
            </span>
          )}
        </div>
      )}

    </div>
  )
}
