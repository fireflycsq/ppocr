import { useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import type {
  AccuracyReport,
  DocComparison,
  FieldStat,
  NormalizedDoc,
  TemplateAccuracyReport,
} from '../utils/accuracyStats'
import {
  buildAccuracyReport,
  ERROR_KIND_LABELS,
  parseExportJson,
  percentage,
} from '../utils/accuracyStats'
import { readZipJsonEntries } from '../utils/zipJson'

type Side = 'result' | 'answer'

interface LoadedZip {
  fileName: string
  docs: NormalizedDoc[]
  /** 解析失败的 JSON 文件及原因 */
  parseErrors: Array<{ path: string; message: string }>
}

const SIDE_LABELS: Record<Side, { title: string; desc: string }> = {
  result: {
    title: '预识别结果 JSON 压缩包',
    desc: '「智能预识别审核」导出的 JSON 文件打包成 zip 上传',
  },
  answer: {
    title: '答案 JSON 压缩包',
    desc: '人工核对后的标准答案 JSON（单文件导出或批量导出均可）打包成 zip 上传',
  },
}

async function loadZip(file: File): Promise<LoadedZip> {
  const entries = await readZipJsonEntries(file)
  if (entries.length === 0) {
    throw new Error('压缩包内没有找到 JSON 文件')
  }
  const docs: NormalizedDoc[] = []
  const parseErrors: Array<{ path: string; message: string }> = []
  for (const entry of entries) {
    try {
      docs.push(...parseExportJson(entry.text, entry.path))
    } catch (err) {
      parseErrors.push({
        path: entry.path,
        message: err instanceof Error ? err.message : '解析失败',
      })
    }
  }
  return { fileName: file.name, docs, parseErrors }
}

function rateClass(correct: number, total: number): string {
  if (total <= 0) return ''
  const rate = correct / total
  if (rate >= 0.995) return 'rate-good'
  if (rate >= 0.9) return 'rate-warn'
  return 'rate-bad'
}

function FieldStatsTable({
  title,
  stats,
}: {
  title: string
  stats: FieldStat[]
}) {
  if (stats.length === 0) return null
  return (
    <div className="accuracy-field-block">
      <h4>{title}</h4>
      <table className="accuracy-table">
        <thead>
          <tr>
            <th>字段</th>
            <th>正确 / 总数</th>
            <th>准确率</th>
            <th className="accuracy-bar-col" />
          </tr>
        </thead>
        <tbody>
          {stats.map((stat) => (
            <tr key={stat.key}>
              <td>
                <span className="accuracy-field-label">{stat.label}</span>
                <span className="accuracy-field-key">{stat.key}</span>
              </td>
              <td>
                {stat.correct} / {stat.total}
              </td>
              <td className={rateClass(stat.correct, stat.total)}>
                {percentage(stat.correct, stat.total)}
              </td>
              <td className="accuracy-bar-col">
                <div className="accuracy-bar">
                  <div
                    className={`accuracy-bar-fill ${rateClass(stat.correct, stat.total)}`}
                    style={{
                      width: `${stat.total > 0 ? (stat.correct / stat.total) * 100 : 0}%`,
                    }}
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ErrorDocItem({ doc }: { doc: DocComparison }) {
  return (
    <details className="accuracy-error-doc">
      <summary>
        <span className="accuracy-error-file">{doc.fileName}</span>
        <span className="accuracy-error-count">{doc.errors.length} 处错误</span>
      </summary>
      <table className="accuracy-table accuracy-error-table">
        <thead>
          <tr>
            <th>位置</th>
            <th>字段</th>
            <th>答案值</th>
            <th>识别值</th>
            <th>错误类型</th>
          </tr>
        </thead>
        <tbody>
          {doc.errors.map((error, index) => (
            <tr key={index}>
              <td>{error.location}</td>
              <td>{error.fieldLabel}</td>
              <td className="accuracy-value-cell">
                {error.expected || <span className="accuracy-empty">（空）</span>}
              </td>
              <td className="accuracy-value-cell">
                {error.actual || <span className="accuracy-empty">（空）</span>}
              </td>
              <td>
                <span className={`accuracy-kind accuracy-kind-${error.kind}`}>
                  {ERROR_KIND_LABELS[error.kind]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  )
}

function TemplateReportSection({ report }: { report: TemplateAccuracyReport }) {
  return (
    <section className="accuracy-template-section">
      <div className="accuracy-template-header">
        <h3>{report.templateName}</h3>
        <div className="accuracy-template-metrics">
          <span>
            文档 <strong>{report.docTotal}</strong>
          </span>
          <span>
            整单全对 <strong>{report.docAllCorrect}</strong>
          </span>
          <span className={rateClass(report.docAllCorrect, report.docTotal)}>
            全对率 <strong>{percentage(report.docAllCorrect, report.docTotal)}</strong>
          </span>
          {report.answerRows > 0 && (
            <span>
              明细行 <strong>{report.answerRows}</strong>
              {report.missingRows > 0 && (
                <em className="rate-bad">（漏 {report.missingRows}）</em>
              )}
              {report.extraRows > 0 && (
                <em className="rate-bad">（多 {report.extraRows}）</em>
              )}
            </span>
          )}
        </div>
      </div>

      <FieldStatsTable title="发票头字段准确率" stats={report.headerFieldStats} />
      <FieldStatsTable title="明细字段准确率" stats={report.sublistFieldStats} />

      {report.errorDocs.length > 0 && (
        <div className="accuracy-error-list">
          <h4>错误样本分析（{report.errorDocs.length} 个）</h4>
          {report.errorDocs.map((doc) => (
            <ErrorDocItem key={doc.fileName} doc={doc} />
          ))}
        </div>
      )}
    </section>
  )
}

export default function AccuracyStatsPage() {
  const [zips, setZips] = useState<Record<Side, LoadedZip | null>>({
    result: null,
    answer: null,
  })
  const [loading, setLoading] = useState<Side | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleUpload = async (side: Side, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setLoading(side)
    setError(null)
    try {
      const loaded = await loadZip(file)
      setZips((prev) => ({ ...prev, [side]: loaded }))
    } catch (err) {
      setError(
        `${SIDE_LABELS[side].title}读取失败：${err instanceof Error ? err.message : '未知错误'}`,
      )
    } finally {
      setLoading(null)
    }
  }

  const report: AccuracyReport | null = useMemo(() => {
    if (!zips.result || !zips.answer) return null
    return buildAccuracyReport(zips.answer.docs, zips.result.docs)
  }, [zips.result, zips.answer])

  const parseErrors = [
    ...(zips.result?.parseErrors ?? []),
    ...(zips.answer?.parseErrors ?? []),
  ]

  return (
    <div className="accuracy-page">
      <header className="page-header">
        <div className="brand">
          <h1>识别准确率统计</h1>
          <p>
            上传预识别结果与答案两组 JSON 压缩包 → 按文件名自动配对 →
            统计整单全对率与各字段准确率，并列出错误样本
          </p>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="accuracy-upload-row">
        {(['result', 'answer'] as Side[]).map((side) => {
          const loaded = zips[side]
          return (
            <label key={side} className="accuracy-upload-card">
              <input
                type="file"
                accept=".zip"
                onChange={(event) => handleUpload(side, event)}
                disabled={loading !== null}
              />
              <span className="accuracy-upload-title">{SIDE_LABELS[side].title}</span>
              <span className="accuracy-upload-desc">{SIDE_LABELS[side].desc}</span>
              <span className={`accuracy-upload-status ${loaded ? 'loaded' : ''}`}>
                {loading === side
                  ? '解压中…'
                  : loaded
                    ? `${loaded.fileName} · ${loaded.docs.length} 个文档`
                    : '点击选择 .zip 文件'}
              </span>
            </label>
          )
        })}
      </div>

      {parseErrors.length > 0 && (
        <div className="error-banner">
          以下 JSON 文件解析失败，已跳过：
          {parseErrors.map((item) => ` ${item.path}（${item.message}）`).join('；')}
        </div>
      )}

      {!report && (
        <div className="accuracy-placeholder">
          两个压缩包都上传后自动开始比对统计
        </div>
      )}

      {report && (
        <>
          <div className="accuracy-summary-row">
            <div className="accuracy-summary-card">
              <span className="accuracy-summary-value">{report.matchedPairs}</span>
              <span className="accuracy-summary-label">配对成功文档</span>
            </div>
            <div className="accuracy-summary-card">
              <span className="accuracy-summary-value">{report.docAllCorrect}</span>
              <span className="accuracy-summary-label">整单全对文档</span>
            </div>
            <div className="accuracy-summary-card">
              <span
                className={`accuracy-summary-value ${rateClass(report.docAllCorrect, report.matchedPairs)}`}
              >
                {percentage(report.docAllCorrect, report.matchedPairs)}
              </span>
              <span className="accuracy-summary-label">整单全对率</span>
            </div>
            <div className="accuracy-summary-card">
              <span className="accuracy-summary-value">
                {report.unmatchedResults.length + report.unmatchedAnswers.length}
              </span>
              <span className="accuracy-summary-label">未配对文件</span>
            </div>
          </div>

          {report.matchedPairs === 0 && (
            <div className="error-banner">
              两组 JSON 没有按文件名配对成功。请确认两侧文件名一致（如 A.pdf 的结果与答案都命名为
              A.json）。
            </div>
          )}

          {report.templates.map((templateReport) => (
            <TemplateReportSection
              key={templateReport.templateId}
              report={templateReport}
            />
          ))}

          {(report.unmatchedResults.length > 0 || report.unmatchedAnswers.length > 0) && (
            <section className="accuracy-template-section">
              <div className="accuracy-template-header">
                <h3>未配对文件</h3>
              </div>
              {report.unmatchedAnswers.length > 0 && (
                <p className="accuracy-unmatched">
                  有答案、缺识别结果：{report.unmatchedAnswers.join('、')}
                </p>
              )}
              {report.unmatchedResults.length > 0 && (
                <p className="accuracy-unmatched">
                  有识别结果、缺答案：{report.unmatchedResults.join('、')}
                </p>
              )}
            </section>
          )}
        </>
      )}
    </div>
  )
}
