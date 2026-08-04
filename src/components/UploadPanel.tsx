import { useEffect, useRef } from 'react'
import { PdfPreview } from './PdfPreview'
import type { LlmJob, JobDocument } from '../api/llmJobs'

export interface LlmStreamPreview {
  label: string
  text: string
}

interface UploadPanelProps {
  files: File[]
  /** 服务端任务中的文档列表（刷新恢复后可能没有本地 File） */
  jobDocuments?: JobDocument[]
  selectedDocId: string | null
  previewUrl: string | null
  isRecognizing: boolean
  ocrReady?: boolean
  llmStream?: LlmStreamPreview | null
  job?: LlmJob | null
  onFilesSelect: (files: File[]) => void
  onSelectDoc: (docId: string) => void
  /** 打开指定已完成文档的字段审核 */
  onReviewDoc?: (docId: string) => void
  /** 从队列进入批量审核（默认第一个已完成文档） */
  onEnterBatchReview?: () => void
  onRunOcr: () => void
  onReset: () => void
  onCancelJob?: () => void
  onExportBatch?: () => void
}

function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
}

function statusLabel(status: JobDocument['status']): string {
  switch (status) {
    case 'queued':
      return '排队中'
    case 'running':
      return '识别中'
    case 'done':
      return '已完成'
    case 'error':
      return '失败'
    case 'cancelled':
      return '已中断'
    default:
      return status
  }
}

export function UploadPanel({
  files,
  jobDocuments = [],
  selectedDocId,
  previewUrl,
  isRecognizing,
  ocrReady = true,
  llmStream = null,
  job = null,
  onFilesSelect,
  onSelectDoc,
  onReviewDoc,
  onEnterBatchReview,
  onRunOcr,
  onReset,
  onCancelJob,
  onExportBatch,
}: UploadPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const streamRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    const el = streamRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [llmStream?.text, llmStream?.label])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? []).filter(isPdfFile)
    if (selected.length > 0) onFilesSelect(selected)
    e.target.value = ''
  }

  const listItems: Array<{
    id: string
    fileName: string
    fileSize: number
    status?: JobDocument['status']
    progress?: { done: number; total: number }
    error?: string | null
  }> =
    jobDocuments.length > 0
      ? jobDocuments.map((doc) => ({
          id: doc.id,
          fileName: doc.fileName,
          fileSize: doc.fileSize,
          status: doc.status,
          progress: doc.progress,
          error: doc.error,
        }))
      : files.map((file, index) => ({
          id: `local-${index}-${file.name}`,
          fileName: file.name,
          fileSize: file.size,
        }))

  const doneCount = jobDocuments.filter((d) => d.status === 'done').length
  const totalCount = jobDocuments.length || files.length

  return (
    <div className="upload-panel-inner">
      <div
        className="upload-dropzone"
        onClick={() => !isRecognizing && inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          if (isRecognizing) return
          const dropped = Array.from(e.dataTransfer.files ?? []).filter(isPdfFile)
          if (dropped.length > 0) onFilesSelect(dropped)
        }}
      >
        <div className="upload-icon">📄</div>
        <p className="upload-title">批量上传 PDF 单证</p>
        <p className="upload-hint">
          支持多选 / 拖拽多个 PDF；上传后由服务端排队识别，关闭页面也不会中断
        </p>
        <p className="upload-hint">点击选择或拖拽文件到此处</p>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          hidden
          disabled={isRecognizing}
          onChange={handleChange}
        />
      </div>

      {listItems.length > 0 && (
        <div className="upload-preview-card">
          <div className="upload-file-info">
            <strong>
              {totalCount} 个文件
              {job ? ` · 任务 ${job.status}` : ''}
              {doneCount > 0 ? ` · 已完成 ${doneCount}` : ''}
            </strong>
            {job?.current && (
              <span>
                当前：{job.current.fileName}
                {job.current.totalPages > 0
                  ? ` 第 ${job.current.pageIndex + 1}/${job.current.totalPages} 页`
                  : ''}
              </span>
            )}
          </div>

          <ul className="llm-batch-file-list">
            {listItems.map((item) => {
              const active = item.id === selectedDocId
              const progress =
                item.progress && item.progress.total > 0
                  ? `${item.progress.done}/${item.progress.total}`
                  : ''
              const canReview = item.status === 'done'
              return (
                <li key={item.id} className="llm-batch-file-row">
                  <button
                    type="button"
                    className={`llm-batch-file-item ${active ? 'active' : ''} ${item.status ? `status-${item.status}` : ''}`}
                    onClick={() => onSelectDoc(item.id)}
                  >
                    <span className="llm-batch-file-name" title={item.fileName}>
                      {item.fileName}
                    </span>
                    <span className="llm-batch-file-meta">
                      {(item.fileSize / 1024).toFixed(1)} KB
                      {item.status ? ` · ${statusLabel(item.status)}` : ''}
                      {progress ? ` · ${progress}` : ''}
                    </span>
                    {item.error && (
                      <span className="llm-batch-file-error">{item.error}</span>
                    )}
                  </button>
                  {canReview && onReviewDoc && (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm llm-batch-review-btn"
                      onClick={() => onReviewDoc(item.id)}
                    >
                      审核
                    </button>
                  )}
                </li>
              )
            })}
          </ul>

          {previewUrl && <PdfPreview url={previewUrl} className="upload-preview-pdf" />}

          <div className="upload-actions">
            {!job && (
              <button
                type="button"
                className="btn btn-primary btn-lg"
                disabled={isRecognizing || !ocrReady || files.length === 0}
                onClick={onRunOcr}
              >
                {isRecognizing
                  ? '排队识别中…'
                  : ocrReady
                    ? `开始批量抽取（${files.length}）`
                    : '等待 Ollama 连接…'}
              </button>
            )}
            {job && doneCount > 0 && onEnterBatchReview && (
              <button
                type="button"
                className="btn btn-primary btn-lg"
                onClick={onEnterBatchReview}
              >
                进入批量审核（{doneCount}）
              </button>
            )}
            {job && isRecognizing && onCancelJob && (
              <button type="button" className="btn btn-outline" onClick={onCancelJob}>
                中断任务
              </button>
            )}
            {job && doneCount > 0 && onExportBatch && (
              <button type="button" className="btn btn-outline" onClick={onExportBatch}>
                导出结果 ZIP（{doneCount}）
              </button>
            )}
            <button
              type="button"
              className="btn btn-outline"
              disabled={isRecognizing}
              onClick={() => inputRef.current?.click()}
            >
              {job ? '新建任务并上传' : '添加/更换文件'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={isRecognizing}
              onClick={onReset}
            >
              清空
            </button>
          </div>

          {(isRecognizing || llmStream) && llmStream && (
            <div className="llm-stream-live">
              <div className="llm-stream-live-label">{llmStream.label}</div>
              <pre ref={streamRef} className="llm-stream-live-text">
                {llmStream.text || '等待模型流式输出…'}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
