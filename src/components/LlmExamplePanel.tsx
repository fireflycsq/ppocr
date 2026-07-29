import { useEffect, useRef, useState } from 'react'
import type { LlmExample } from '../types/llmExamples'
import { resolveExampleMediaType } from '../types/llmExamples'
import type { LlmStreamPreview } from './UploadPanel'

interface LlmExamplePanelProps {
  examples: LlmExample[]
  disabled?: boolean
  loading: boolean
  optimizing: boolean
  optimizationStale: boolean
  error: string | null
  llmStream?: LlmStreamPreview | null
  onUpload: (
    sample: File,
    answer: Record<string, unknown>,
    category: 'target' | 'non_target',
  ) => Promise<void>
  onDelete: (id: number) => Promise<void>
  onOptimize: () => Promise<void>
}

const SAMPLE_ACCEPT =
  'application/pdf,.pdf,image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp'

export function LlmExamplePanel({
  examples,
  disabled = false,
  loading,
  optimizing,
  optimizationStale,
  error,
  llmStream = null,
  onUpload,
  onDelete,
  onOptimize,
}: LlmExamplePanelProps) {
  const sampleRef = useRef<HTMLInputElement>(null)
  const answerFileRef = useRef<HTMLInputElement>(null)
  const streamRef = useRef<HTMLPreElement>(null)
  const [sample, setSample] = useState<File | null>(null)
  const [answerText, setAnswerText] = useState('')
  const [category, setCategory] = useState<'target' | 'non_target'>('target')
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    const el = streamRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [llmStream?.text, llmStream?.label])

  const parseAnswerText = (): Record<string, unknown> | null => {
    const trimmed = answerText.trim()
    if (!trimmed) {
      if (category === 'target') {
        setLocalError('目标样例必须填写答案 JSON')
        return null
      }
      return { category }
    }
    try {
      const value = JSON.parse(trimmed) as unknown
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('答案 JSON 必须是对象')
      }
      return value as Record<string, unknown>
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : '答案 JSON 无效')
      return null
    }
  }

  const handleUpload = async () => {
    if (!sample) {
      setLocalError('请选择样例文件（PDF 或图片）')
      return
    }
    const parsed = parseAnswerText()
    if (!parsed) return
    parsed.category = category
    setBusy(true)
    setLocalError(null)
    try {
      await onUpload(sample, parsed, category)
      setSample(null)
      setAnswerText('')
      if (sampleRef.current) sampleRef.current.value = ''
      if (answerFileRef.current) answerFileRef.current.value = ''
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : '上传样例失败')
    } finally {
      setBusy(false)
    }
  }

  const handleImportAnswerFile = async (file: File | undefined) => {
    if (!file) return
    try {
      const text = await file.text()
      JSON.parse(text)
      setAnswerText(text)
      setLocalError(null)
    } catch {
      setLocalError('所选 JSON 文件无效')
    }
  }

  return (
    <section className="llm-example-panel">
      <div className="llm-example-header">
        <div>
          <h3>样例驱动优化</h3>
          <p>
            上传同版式样例（PDF 或图片）。样例用于优化低清预判：只学习「是否为目标单证」，不修改字段抽取提示词。
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={disabled || loading || optimizing || examples.length === 0}
          onClick={() => void onOptimize()}
        >
          {optimizing ? '正在优化…' : optimizationStale ? '重新优化判定' : '优化目标判定'}
        </button>
      </div>

      {optimizing && llmStream && (
        <div className="llm-stream-live">
          <div className="llm-stream-live-label">{llmStream.label}</div>
          <pre ref={streamRef} className="llm-stream-live-text">
            {llmStream.text || '等待模型流式输出…'}
          </pre>
        </div>
      )}

      <div className="llm-example-upload">
        <div className="llm-example-upload-row">
          <select
            value={category}
            disabled={disabled || busy}
            onChange={(event) =>
              setCategory(event.target.value as 'target' | 'non_target')
            }
            aria-label="样例类别"
          >
            <option value="target">目标样例</option>
            <option value="non_target">非目标样例</option>
          </select>
          <label>
            <span>样例文件（PDF / 图片）</span>
            <input
              ref={sampleRef}
              type="file"
              accept={SAMPLE_ACCEPT}
              disabled={disabled || busy}
              onChange={(event) => setSample(event.target.files?.[0] ?? null)}
            />
          </label>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            disabled={disabled || busy}
            onClick={() => void handleUpload()}
          >
            {busy ? '上传中…' : '添加样例'}
          </button>
        </div>

        <div className="llm-example-answer">
          <div className="llm-example-answer-header">
            <span>答案 JSON{category === 'non_target' ? '（可选）' : ''}</span>
            <label className="llm-example-import-json">
              <span>从文件导入</span>
              <input
                ref={answerFileRef}
                type="file"
                accept="application/json,.json"
                disabled={disabled || busy}
                onChange={(event) => {
                  void handleImportAnswerFile(event.target.files?.[0])
                  event.target.value = ''
                }}
              />
            </label>
          </div>
          <textarea
            className="llm-example-answer-textarea"
            value={answerText}
            disabled={disabled || busy}
            onChange={(event) => {
              setAnswerText(event.target.value)
              setLocalError(null)
            }}
            placeholder={
              category === 'target'
                ? '{\n  "category": "target",\n  "fields": { "invoice_no": "示例值" }\n}'
                : '非目标样例可不填，或填写 {"category": "non_target"}'
            }
            spellCheck={false}
            rows={6}
          />
        </div>
      </div>

      {(localError || error) && (
        <p className="llm-config-error">{localError ?? error}</p>
      )}

      {loading ? (
        <p className="llm-config-hint">正在加载共享样例…</p>
      ) : examples.length === 0 ? (
        <p className="llm-config-hint">当前版式还没有样例，将使用默认提示词。</p>
      ) : (
        <div className="llm-example-list">
          {examples.map((example) => (
            <div key={example.id} className="llm-example-item">
              <div>
                <strong>{example.file_name}</strong>
                <span>
                  {example.category === 'target' ? '目标' : '非目标'} ·{' '}
                  {resolveExampleMediaType(example) === 'image' ? '图片' : 'PDF'} ·{' '}
                  {(example.file_size / 1024).toFixed(1)} KB ·{' '}
                  {example.created_by_username}
                </span>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={disabled}
                onClick={() => void onDelete(example.id)}
              >
                删除
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
