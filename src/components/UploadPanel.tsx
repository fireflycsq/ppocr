import { useEffect, useRef } from 'react'
import { PdfPreview } from './PdfPreview'

export interface LlmStreamPreview {
  label: string
  text: string
}

interface UploadPanelProps {
  file: File | null
  previewUrl: string | null
  isRecognizing: boolean
  /** 大模型服务是否就绪 */
  ocrReady?: boolean
  /** 抽取过程中的流式模型输出 */
  llmStream?: LlmStreamPreview | null
  onFileSelect: (file: File) => void
  onRunOcr: () => void
  onReset: () => void
}

function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
}

export function UploadPanel({
  file,
  previewUrl,
  isRecognizing,
  ocrReady = true,
  llmStream = null,
  onFileSelect,
  onRunOcr,
  onReset,
}: UploadPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const streamRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    const el = streamRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [llmStream?.text, llmStream?.label])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0]
    if (selected && isPdfFile(selected)) onFileSelect(selected)
    e.target.value = ''
  }

  return (
    <div className="upload-panel-inner">
      <div
        className="upload-dropzone"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          const dropped = e.dataTransfer.files?.[0]
          if (dropped && isPdfFile(dropped)) onFileSelect(dropped)
        }}
      >
        <div className="upload-icon">📄</div>
        <p className="upload-title">上传 PDF 单证</p>
        <p className="upload-hint">
          单个 PDF 文件，Qwen3-VL 将逐页识别：自动过滤无关页并抽取字段
        </p>
        <p className="upload-hint">点击选择或拖拽文件到此处</p>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={handleChange}
        />
      </div>

      {file && (
        <div className="upload-preview-card">
          <div className="upload-file-info">
            <strong>{file.name}</strong>
            <span>{(file.size / 1024).toFixed(1)} KB</span>
          </div>
          {previewUrl && <PdfPreview url={previewUrl} className="upload-preview-pdf" />}
          <div className="upload-actions">
            <button
              type="button"
              className="btn btn-primary btn-lg"
              disabled={isRecognizing || !ocrReady}
              onClick={onRunOcr}
            >
              {isRecognizing
                ? '抽取中…'
                : ocrReady
                  ? '开始智能抽取'
                  : '等待 Ollama 连接…'}
            </button>
            <button
              type="button"
              className="btn btn-outline"
              disabled={isRecognizing}
              onClick={() => inputRef.current?.click()}
            >
              更换文件
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={isRecognizing}
              onClick={onReset}
            >
              重置
            </button>
          </div>

          {isRecognizing && llmStream && (
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
