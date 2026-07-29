import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { checkLlmHealth } from '../api/llm'
import {
  deleteLlmExample,
  listLlmExamples,
  uploadLlmExample,
} from '../api/examples'
import { LlmExamplePanel } from '../components/LlmExamplePanel'
import { LlmConfigPanel } from '../components/LlmConfigPanel'
import { PdfPreview } from '../components/PdfPreview'
import { UploadPanel } from '../components/UploadPanel'
import { HeaderFieldsForm } from '../components/labeling/HeaderFieldsForm'
import { InvoiceEntriesEditor } from '../components/labeling/InvoiceEntriesEditor'
import { InvoiceWithSublistEntriesEditor } from '../components/labeling/InvoiceWithSublistEntriesEditor'
import { SublistTableEditor } from '../components/labeling/SublistTableEditor'
import { useAuth } from '../contexts/AuthContext'
import { usePersistedPanelWidth } from '../hooks/usePersistedPanelWidth'
import type {
  InvoiceEntry,
  SublistRow,
  TargetStructureType,
} from '../types/labeling'
import { STRUCTURE_OPTIONS } from '../types/labeling'
import type { LlmExample, PromptOptimization } from '../types/llmExamples'
import { downloadJson } from '../utils'
import {
  buildDocumentExportPayload,
  createEmptyInvoiceEntry,
  createEmptySublistRow,
  documentExportFileName,
} from '../utils/labelingStorage'
import {
  applyTemplateDefaultsToInvoiceEntry,
  buildDefaultHeaderValues,
  buildDefaultSublistRows,
  DEFAULT_TEMPLATE_ID,
  getLabelTemplate,
  LABEL_TEMPLATES,
} from '../utils/labelTemplates'
import type { LlmExtractionConfig } from '../utils/llmConfig'
import {
  buildDefaultLlmConfig,
  clearLlmConfig,
  loadLlmConfig,
  parseRequestJson,
  saveLlmConfig,
} from '../utils/llmConfig'
import type {
  PageOutcome,
  PdfExtractionResult,
  ReviewDocData,
} from '../utils/llmExtraction'
import {
  extractionToReviewData,
  extractPdfFileWithLlm,
} from '../utils/llmExtraction'
import {
  applyPromptOptimization,
  buildClassificationAgentConfig,
  clearPromptOptimization,
  examplesRevision,
  loadPromptOptimization,
  optimizePromptFromExamples,
  savePromptOptimization,
} from '../utils/promptOptimizer'

type Phase = 'idle' | 'optimize' | 'classify' | 'extract'

const configuredClassificationThreshold = Number(
  import.meta.env.VITE_LLM_CLASSIFICATION_THRESHOLD ?? '0.8',
)
const CLASSIFICATION_THRESHOLD = Number.isFinite(configuredClassificationThreshold)
  ? Math.min(1, Math.max(0, configuredClassificationThreshold))
  : 0.8

const WORKFLOW_STEPS = [
  { key: 'upload', label: '上传 PDF' },
  { key: 'extract', label: '逐页抽取' },
  { key: 'review', label: '字段审核' },
  { key: 'export', label: '导出 JSON' },
]

function pageNumbers(outcomes: PageOutcome[], status: PageOutcome['status']): number[] {
  return outcomes
    .filter((o) => o.status  === status)
    .map((o) => o.pageIndex + 1)
}

export default function OcrReviewPage() {
  const { user } = useAuth()
  const [step, setStep] = useState<'upload' | 'review'>('upload')
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  const [templateId, setTemplateId] = useState(DEFAULT_TEMPLATE_ID)
  const template = useMemo(() => getLabelTemplate(templateId), [templateId])
  const [llmConfig, setLlmConfig] = useState<LlmExtractionConfig>(() =>
    loadLlmConfig(getLabelTemplate(DEFAULT_TEMPLATE_ID)),
  )

  const llmModel = useMemo(
    () => parseRequestJson(llmConfig.requestJson).model,
    [llmConfig.requestJson],
  )

  const [llmReady, setLlmReady] = useState(false)
  const [llmModels, setLlmModels] = useState<string[]>([])
  const [examples, setExamples] = useState<LlmExample[]>([])
  const [examplesLoading, setExamplesLoading] = useState(false)
  const [examplesError, setExamplesError] = useState<string | null>(null)
  const [optimization, setOptimization] = useState<PromptOptimization | null>(() =>
    loadPromptOptimization(DEFAULT_TEMPLATE_ID),
  )

  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [pageOutcomes, setPageOutcomes] = useState<PageOutcome[]>([])
  const [llmStream, setLlmStream] = useState<{ label: string; text: string } | null>(
    null,
  )
  const [extraction, setExtraction] = useState<PdfExtractionResult | null>(null)
  const [review, setReview] = useState<ReviewDocData | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const { width: rightPanelWidth, setWidth: setRightPanelWidth, startResize } =
    usePersistedPanelWidth()
  const {
    width: uploadConfigWidth,
    setWidth: setUploadConfigWidth,
    startResize: startUploadResize,
    minWidth: uploadConfigMinWidth,
    maxWidth: uploadConfigMaxWidth,
  } = usePersistedPanelWidth({
    storageKey: 'ppocr-llm-upload-config-width',
    defaultWidth: 560,
    minWidth: 360,
    maxWidth: 900,
  })

  // 探测 Ollama 服务与已安装模型
  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      checkLlmHealth().then((health) => {
        if (cancelled) return
        setLlmReady(health.ready)
        setLlmModels(health.models)
      })
    }
    refresh()
    const timer = window.setInterval(refresh, 15000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  // 切换版式时载入该版式的提示词配置
  useEffect(() => {
    setLlmConfig(loadLlmConfig(template))
    setOptimization(loadPromptOptimization(template.id))
    if (!user) {
      setExamples([])
      setExamplesLoading(false)
      setExamplesError('请先在「单证标注」页面登录，再使用服务器共享样例')
      return
    }
    setExamplesLoading(true)
    setExamplesError(null)
    let cancelled = false
    void listLlmExamples(template.id)
      .then((items) => {
        if (!cancelled) setExamples(items)
      })
      .catch((err) => {
        if (!cancelled) {
          setExamples([])
          setExamplesError(err instanceof Error ? err.message : '加载共享样例失败')
        }
      })
      .finally(() => {
        if (!cancelled) setExamplesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [template, user])

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  const handleConfigChange = (patch: Partial<LlmExtractionConfig>) => {
    setLlmConfig((prev) => {
      const next = { ...prev, ...patch }
      saveLlmConfig(templateId, next)
      return next
    })
  }

  const handleConfigReset = () => {
    clearLlmConfig(templateId)
    clearPromptOptimization(templateId)
    setOptimization(null)
    setLlmConfig(buildDefaultLlmConfig(template))
  }

  const handleExampleUpload = async (
    sample: File,
    answer: Record<string, unknown>,
    category: 'target' | 'non_target',
  ) => {
    const created = await uploadLlmExample({
      layoutTemplateId: templateId,
      category,
      sample,
      answer,
    })
    setExamples((current) => [created, ...current])
  }

  const handleExampleDelete = async (id: number) => {
    await deleteLlmExample(id)
    setExamples((current) => current.filter((item) => item.id !== id))
  }

  const optimizeCurrentPrompt = async (
    signal?: AbortSignal,
  ): Promise<{ requestJson: string; optimization: PromptOptimization }> => {
    setLlmStream({ label: '正在根据样例学习目标/非目标判定特征…', text: '' })
    const nextOptimization = await optimizePromptFromExamples({
      examples,
      template,
      requestJson: llmConfig.requestJson,
      signal,
      onStreamUpdate: (event) => {
        setLlmStream({ label: event.label, text: event.text })
      },
    })
    const requestJson = applyPromptOptimization(
      llmConfig.requestJson,
      nextOptimization,
    )
    savePromptOptimization(templateId, nextOptimization)
    saveLlmConfig(templateId, { requestJson })
    setOptimization(nextOptimization)
    setLlmConfig({ requestJson })
    return { requestJson, optimization: nextOptimization }
  }

  const handleOptimize = async () => {
    if (phase !== 'idle') return
    const controller = new AbortController()
    abortRef.current = controller
    setError(null)
    setPhase('optimize')
    try {
      await optimizeCurrentPrompt(controller.signal)
    } catch (err) {
      setError(err instanceof Error ? err.message : '样例提示词优化失败')
    } finally {
      setPhase('idle')
      abortRef.current = null
    }
  }

  const handleFileSelect = (selected: File) => {
    if (previewUrl?.startsWith('blob:')) URL.revokeObjectURL(previewUrl)
    setFile(selected)
    setPreviewUrl(URL.createObjectURL(selected))
    setExtraction(null)
    setReview(null)
    setPageOutcomes([])
    setLlmStream(null)
    setNote('')
    setError(null)
    setStep('upload')
  }

  const handleReset = () => {
    abortRef.current?.abort()
    if (previewUrl?.startsWith('blob:')) URL.revokeObjectURL(previewUrl)
    setFile(null)
    setPreviewUrl(null)
    setExtraction(null)
    setReview(null)
    setPageOutcomes([])
    setLlmStream(null)
    setNote('')
    setError(null)
    setPhase('idle')
    setStep('upload')
  }

  const handleRun = async () => {
    if (!file || phase !== 'idle') return

    const { error: requestError } = parseRequestJson(llmConfig.requestJson)
    if (requestError) {
      setError(`大模型请求配置有误：${requestError}`)
      return
    }

    setError(null)
    setPageOutcomes([])
    setExtraction(null)
    setLlmStream({ label: '准备连接大模型…', text: '' })
    setPhase('classify')
    setProgress({ done: 0, total: 0 })

    const controller = new AbortController()
    abortRef.current = controller

    try {
      let requestJson = llmConfig.requestJson
      let classificationAgent = buildClassificationAgentConfig(optimization, llmModel)
      const revision = examplesRevision(examples)
      if (
        examples.length > 0 &&
        optimization?.examplesRevision !== revision
      ) {
        setPhase('optimize')
        const optimized = await optimizeCurrentPrompt(controller.signal)
        requestJson = optimized.requestJson
        classificationAgent = buildClassificationAgentConfig(
          optimized.optimization,
          llmModel,
        )
      }

      setPhase('classify')
      const result = await extractPdfFileWithLlm({
        file,
        requestJson,
        template,
        classificationAgent,
        classificationThreshold: CLASSIFICATION_THRESHOLD,
        signal: controller.signal,
        onClassifyDone: (outcome, done, total) => {
          if (outcome) {
            setPageOutcomes((prev) => [...prev, outcome])
          }
          setProgress({ done, total })
        },
        onExtractionStart: (total) => {
          setPhase('extract')
          setProgress({ done: 0, total })
        },
        onPageDone: (outcome, done, total) => {
          setPageOutcomes((prev) => [...prev, outcome])
          setProgress({ done, total })
        },
        onStreamUpdate: (event) => {
          const label =
            event.phase === 'classify'
              ? `低清预判 · PDF 第 ${event.pageIndex + 1}/${event.totalPages} 页`
              : `高清抽取 · PDF 第 ${event.pageIndex + 1} 页（共 ${event.totalPages} 页待抽取）`
          setLlmStream({ label, text: event.text })
        },
      })

      setExtraction(result)
      if (result.invoices.length === 0) {
        setReview(null)
        const errors = result.pageOutcomes.filter((o) => o.status === 'error')
        if (errors.length > 0) {
          setError(
            `未抽取到目标字段：${errors.length} 页请求失败，首个错误：${errors[0].error ?? '未知错误'}。` +
              '请检查「大模型请求配置」中的 model 是否与 ollama list 一致',
          )
        } else {
          const prefiltered = result.pageOutcomes.filter(
            (outcome) => outcome.status === 'prefiltered',
          )
          setError(
            prefiltered.length === result.pageOutcomes.length
              ? '低分辨率预判认为所有页面都不是目标单证，已停止高清抽取。请检查逐页判定理由、样例或版式。'
              : '模型将所有页都判定为不含目标字段，请检查样例、提示词或版式。',
          )
        }
        return
      }
      setReview(extractionToReviewData(result, template))
      setStep('review')
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setError('已中断抽取')
      } else {
        setError(err instanceof Error ? err.message : '抽取失败，请重试')
      }
    } finally {
      setPhase('idle')
      abortRef.current = null
    }
  }

  const handleAbort = () => {
    abortRef.current?.abort()
  }

  const patchReview = (patch: Partial<ReviewDocData>) => {
    setReview((prev) => (prev ? { ...prev, ...patch } : prev))
  }

  const handleStructureChange = (structureType: TargetStructureType) => {
    if (!review) return
    const patch: Partial<ReviewDocData> = { structureType }

    if (structureType === 'multi_invoice' && review.invoiceEntries.length === 0) {
      patch.invoiceEntries = [createEmptyInvoiceEntry(false)]
    }
    if (structureType === 'multi_invoice_with_sublist') {
      const entries =
        review.invoiceEntries.length > 0
          ? review.invoiceEntries
          : [createEmptyInvoiceEntry(true, templateId)]
      patch.invoiceEntries = entries.map((entry) => ({
        ...entry,
        sublistRows: entry.sublistRows?.length
          ? entry.sublistRows
          : [createEmptySublistRow()],
      }))
    }
    if (structureType === 'invoice_with_sublist' && review.sublistRows.length === 0) {
      patch.sublistRows = [createEmptySublistRow()]
    }

    patchReview(patch)
  }

  const handleSingleFieldChange = (fieldId: string, value: string) => {
    if (!review) return
    patchReview({ fieldValues: { ...review.fieldValues, [fieldId]: value } })
  }

  const handleInvoiceHeaderChange = (fieldId: string, value: string) => {
    if (!review) return
    patchReview({ invoiceHeader: { ...review.invoiceHeader, [fieldId]: value } })
  }

  const handleSublistRowsChange = (rows: SublistRow[]) => {
    patchReview({ sublistRows: rows })
  }

  const handleInvoiceEntriesChange = (entries: InvoiceEntry[]) => {
    patchReview({ invoiceEntries: entries })
  }

  const handleInvoiceEntryFieldChange = (
    entryId: string,
    fieldId: string,
    value: string,
  ) => {
    if (!review) return
    handleInvoiceEntriesChange(
      review.invoiceEntries.map((entry) =>
        entry.id === entryId
          ? { ...entry, fieldValues: { ...entry.fieldValues, [fieldId]: value } }
          : entry,
      ),
    )
  }

  const handleAddInvoice = () => {
    if (!review) return
    const withSublist = review.structureType === 'multi_invoice_with_sublist'
    handleInvoiceEntriesChange([
      ...review.invoiceEntries,
      createEmptyInvoiceEntry(withSublist, templateId),
    ])
  }

  const handleRemoveInvoice = (id: string) => {
    if (!review) return
    handleInvoiceEntriesChange(review.invoiceEntries.filter((e) => e.id !== id))
  }

  const handleAddSublistRow = () => {
    if (!review) return
    handleSublistRowsChange([...review.sublistRows, createEmptySublistRow()])
  }

  const handleRemoveSublistRow = (id: string) => {
    if (!review) return
    handleSublistRowsChange(review.sublistRows.filter((r) => r.id !== id))
  }

  const handleSublistCellChange = (rowId: string, columnId: string, value: string) => {
    if (!review) return
    handleSublistRowsChange(
      review.sublistRows.map((row) =>
        row.id === rowId
          ? { ...row, cells: { ...row.cells, [columnId]: value } }
          : row,
      ),
    )
  }

  const handleInvoiceSublistAddRow = (invoiceId: string) => {
    if (!review) return
    handleInvoiceEntriesChange(
      review.invoiceEntries.map((entry) =>
        entry.id === invoiceId
          ? {
              ...entry,
              sublistRows: [...(entry.sublistRows ?? []), createEmptySublistRow()],
            }
          : entry,
      ),
    )
  }

  const handleInvoiceSublistRemoveRow = (invoiceId: string, rowId: string) => {
    if (!review) return
    handleInvoiceEntriesChange(
      review.invoiceEntries.map((entry) =>
        entry.id === invoiceId
          ? {
              ...entry,
              sublistRows: (entry.sublistRows ?? []).filter((r) => r.id !== rowId),
            }
          : entry,
      ),
    )
  }

  const handleInvoiceSublistCellChange = (
    invoiceId: string,
    rowId: string,
    columnId: string,
    value: string,
  ) => {
    if (!review) return
    handleInvoiceEntriesChange(
      review.invoiceEntries.map((entry) =>
        entry.id === invoiceId
          ? {
              ...entry,
              sublistRows: (entry.sublistRows ?? []).map((row) =>
                row.id === rowId
                  ? { ...row, cells: { ...row.cells, [columnId]: value } }
                  : row,
              ),
            }
          : entry,
      ),
    )
  }

  const hasTemplateDefaults =
    Boolean(template.defaultHeaderValues) ||
    Boolean(template.defaultSublistRows?.length)

  const handleApplyTemplateDefaults = () => {
    if (!review) return
    if (
      !window.confirm(
        '将用当前版式的预填值覆盖发票头与子清单明细，已有内容会被替换。确定继续？',
      )
    ) {
      return
    }
    if (review.structureType === 'multi_invoice_with_sublist') {
      patchReview({
        invoiceEntries: review.invoiceEntries.map((entry) => ({
          ...entry,
          ...applyTemplateDefaultsToInvoiceEntry(template),
        })),
      })
    } else if (review.structureType === 'invoice_with_sublist') {
      patchReview({
        invoiceHeader: {
          ...review.invoiceHeader,
          ...buildDefaultHeaderValues(template),
        },
        sublistRows: buildDefaultSublistRows(template),
      })
    }
  }

  const handleApplyEntryTemplateDefaults = (invoiceId: string) => {
    if (!review) return
    if (
      !window.confirm(
        '将用当前版式的预填值覆盖该发票的头字段与子清单明细，已有内容会被替换。确定继续？',
      )
    ) {
      return
    }
    const defaults = applyTemplateDefaultsToInvoiceEntry(template)
    handleInvoiceEntriesChange(
      review.invoiceEntries.map((entry) =>
        entry.id === invoiceId ? { ...entry, ...defaults } : entry,
      ),
    )
  }

  const handleExport = () => {
    if (!review || !file) return
    const payload = {
      ...buildDocumentExportPayload(
        {
          id: 'llm-review',
          fileName: file.name,
          fileSize: file.size,
          previewUrl: null,
          category: 'target',
          structureType: review.structureType,
          fieldValues: review.fieldValues,
          invoiceEntries: review.invoiceEntries,
          invoiceHeader: review.invoiceHeader,
          sublistRows: review.sublistRows,
          note,
          updatedAt: new Date().toISOString(),
        },
        template.headerFields,
        template.sublistColumns,
      ),
      extraction: {
        engine: `ollama/${llmModel || '未设置'}`,
        layoutTemplateId: templateId,
        totalPages: extraction?.pageOutcomes.length ?? 0,
        targetPages: pageNumbers(extraction?.pageOutcomes ?? [], 'target'),
        skippedPages: pageNumbers(extraction?.pageOutcomes ?? [], 'skipped'),
        prefilteredPages: pageNumbers(
          extraction?.pageOutcomes ?? [],
          'prefiltered',
        ),
        errorPages: (extraction?.pageOutcomes ?? [])
          .filter((o) => o.status === 'error')
          .map((o) => ({ page: o.pageIndex + 1, error: o.error })),
      },
    }
    downloadJson(payload, documentExportFileName(file.name))
  }

  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      const step = event.shiftKey ? 40 : 16
      const delta = event.key === 'ArrowLeft' ? step : -step
      setRightPanelWidth((current) => Math.min(960, Math.max(320, current + delta)))
    },
    [setRightPanelWidth],
  )

  const handleUploadResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      const step = event.shiftKey ? 40 : 16
      const delta = event.key === 'ArrowLeft' ? step : -step
      setUploadConfigWidth((current) =>
        Math.min(
          uploadConfigMaxWidth,
          Math.max(uploadConfigMinWidth, current + delta),
        ),
      )
    },
    [
      setUploadConfigWidth,
      uploadConfigMaxWidth,
      uploadConfigMinWidth,
    ],
  )

  const isRecognizing = phase !== 'idle'
  const currentStepIndex =
    step === 'upload' ? (isRecognizing ? 1 : file ? 1 : 0) : 2

  const skippedPages = pageNumbers(extraction?.pageOutcomes ?? [], 'skipped')
  const prefilteredPages = pageNumbers(
    extraction?.pageOutcomes ?? [],
    'prefiltered',
  )
  const errorOutcomes = (extraction?.pageOutcomes ?? []).filter(
    (o) => o.status === 'error',
  )
  const optimizationStale =
    examples.length > 0 &&
    optimization?.examplesRevision !== examplesRevision(examples)

  // 请求的模型不在 Ollama 已安装列表时给出明确警告（不带 tag 时 Ollama 默认取 :latest）
  const modelMissing =
    llmReady &&
    llmModels.length > 0 &&
    llmModel !== '' &&
    !llmModels.includes(llmModel) &&
    !llmModels.includes(`${llmModel}:latest`)

  return (
    <div className="ocr-review-page">
      <header className="page-header">
        <div className="brand">
          <h1>智能预识别审核</h1>
          <p>
            上传 PDF → Qwen3-VL 逐页抽取（自动过滤无关页）→ 按版式审核修正 → 导出 JSON
            <span className="engine-tag">
              引擎: ollama/{llmModel || '未设置'}
              {llmReady ? '' : '（未连接）'}
            </span>
          </p>
        </div>
        {step === 'review' && (
          <button type="button" className="btn btn-outline" onClick={handleReset}>
            重新上传
          </button>
        )}
      </header>

      <nav className="workflow-steps">
        {WORKFLOW_STEPS.map((s, i) => (
          <div
            key={s.key}
            className={`workflow-step ${i <= currentStepIndex ? 'active' : ''} ${i < currentStepIndex ? 'done' : ''}`}
          >
            <span className="step-num">{i + 1}</span>
            <span className="step-label">{s.label}</span>
          </div>
        ))}
      </nav>

      {error && <div className="error-banner">{error}</div>}
      {!llmReady && step === 'upload' && (
        <div className="toast-banner">
          未连接到 Ollama 服务。请确认 Qwen3-VL 已启动，且 Ollama 监听 0.0.0.0:11434
          （OLLAMA_HOST=0.0.0.0:11434 ollama serve）。Docker 部署可执行 docker logs
          ppocr-web 查看 Ollama 连通性检测。
        </div>
      )}
      {modelMissing && step === 'upload' && (
        <div className="error-banner">
          请求配置中的模型「{llmModel}」不在 Ollama 已安装列表（已安装：
          {llmModels.join('、')}），请修改「大模型请求配置」中的 model 字段
        </div>
      )}

      {step === 'upload' ? (
        <main
          className="llm-upload-step"
          style={
            {
              '--llm-upload-config-width': `${uploadConfigWidth}px`,
            } as React.CSSProperties
          }
        >
          <section className="llm-upload-preview-panel">
            <UploadPanel
              file={file}
              previewUrl={previewUrl}
              isRecognizing={isRecognizing}
              ocrReady={llmReady}
              llmStream={llmStream}
              onFileSelect={handleFileSelect}
              onRunOcr={() => void handleRun()}
              onReset={handleReset}
            />
          </section>

          <div
            className="label-panel-resizer llm-upload-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整单证预览和配置区域宽度"
            tabIndex={0}
            onMouseDown={startUploadResize}
            onKeyDown={handleUploadResizeKeyDown}
            title="拖动调整单证预览和配置区域宽度"
          />

          <section className="llm-upload-config-panel">
            <section className="llm-template-section">
              <h3>抽取版式</h3>
              <p className="label-hint">
                与单证标注页一致：决定发票头字段、子清单列与默认提示词
              </p>
              <div className="label-template-options">
                {LABEL_TEMPLATES.map((item) => (
                  <label
                    key={item.id}
                    className={`label-template-option ${templateId === item.id ? 'active' : ''}`}
                  >
                    <input
                      type="radio"
                      name="llm-layout-template"
                      checked={templateId === item.id}
                      disabled={isRecognizing}
                      onChange={() => setTemplateId(item.id)}
                    />
                    <span className="option-title">{item.name}</span>
                    <span className="option-desc">{item.description}</span>
                  </label>
                ))}
              </div>
            </section>

            <LlmConfigPanel
              key={templateId}
              config={llmConfig}
              models={llmModels}
              onChange={handleConfigChange}
              onReset={handleConfigReset}
            />

            <LlmExamplePanel
              key={`examples-${templateId}`}
              examples={examples}
              disabled={!user || isRecognizing}
              loading={examplesLoading}
              optimizing={phase === 'optimize'}
              optimizationStale={optimizationStale}
              error={examplesError}
              llmStream={phase === 'optimize' ? llmStream : null}
              onUpload={handleExampleUpload}
              onDelete={handleExampleDelete}
              onOptimize={handleOptimize}
            />

            {isRecognizing && (
              <section className="llm-progress-card">
                <div className="llm-progress-header">
                  <strong>
                    {phase === 'optimize'
                      ? '正在根据样例优化目标单证判定…'
                      : phase === 'classify'
                        ? `正在低分辨率预判… ${progress.done}/${progress.total || '?'}`
                        : `正在高清抽取… ${progress.done}/${progress.total || '?'}`}
                  </strong>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={handleAbort}
                  >
                    中断
                  </button>
                </div>
                {pageOutcomes.length > 0 && (
                  <ul className="llm-progress-pages">
                    {pageOutcomes.map((outcome) => (
                      <li key={outcome.pageIndex} className={`llm-page-${outcome.status}`}>
                        第 {outcome.pageIndex + 1} 页：
                        {outcome.status === 'target'
                          ? '已抽取'
                          : outcome.status === 'skipped'
                            ? '无目标字段，已跳过'
                            : outcome.status === 'prefiltered'
                              ? `预判为非目标，已跳过（${Math.round(
                                  (outcome.classification?.confidence ?? 0) * 100,
                                )}%）`
                              : `失败（${outcome.error ?? '未知错误'}）`}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </section>
        </main>
      ) : (
        <main
          className="llm-review-layout"
          style={
            {
              '--label-right-panel-width': `${rightPanelWidth}px`,
            } as React.CSSProperties
          }
        >
          <section className="label-preview-panel">
            <div className="panel-title">
              <h2>PDF 预览</h2>
              {file && <span>{(file.size / 1024).toFixed(1)} KB</span>}
            </div>
            <div className="label-preview-scroll">
              {previewUrl ? (
                <PdfPreview url={previewUrl} className="label-pdf-preview" />
              ) : (
                <div className="empty-state label-preview-empty">
                  <p>暂无预览</p>
                </div>
              )}
            </div>
          </section>

          <div
            className="label-panel-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整录入面板宽度"
            tabIndex={0}
            onMouseDown={startResize}
            onKeyDown={handleResizeKeyDown}
            title="拖动调整录入面板宽度"
          />

          <section className="label-right-panel">
            {review && (
              <div className="label-annotation-panel">
                <div className="label-annotation-header">
                  <h2>抽取结果审核</h2>
                  <p className="label-current-file" title={file?.name}>
                    {file?.name}
                  </p>
                </div>

                {extraction && (
                  <div className="llm-extract-summary">
                    <span>共 {extraction.pageOutcomes.length} 页</span>
                    <span>
                      有效 {pageNumbers(extraction.pageOutcomes, 'target').length} 页
                    </span>
                    {skippedPages.length > 0 && (
                      <span>已跳过：第 {skippedPages.join('、')} 页</span>
                    )}
                    {prefilteredPages.length > 0 && (
                      <span>预判跳过：第 {prefilteredPages.join('、')} 页</span>
                    )}
                    {errorOutcomes.length > 0 && (
                      <span className="llm-extract-errors">
                        失败：第{' '}
                        {errorOutcomes.map((o) => o.pageIndex + 1).join('、')} 页
                      </span>
                    )}
                  </div>
                )}

                {extraction && extraction.pageOutcomes.length > 0 && (
                  <details className="llm-page-details">
                    <summary>逐页抽取详情（模型原始输出，用于排查）</summary>
                    <div className="llm-page-details-list">
                      {extraction.pageOutcomes.map((outcome) => (
                        <div key={outcome.pageIndex} className="llm-page-detail-item">
                          <div className={`llm-page-detail-head llm-page-${outcome.status}`}>
                            第 {outcome.pageIndex + 1} 页：
                            {outcome.status === 'target'
                              ? '已抽取'
                              : outcome.status === 'skipped'
                                ? '判定为无目标字段'
                                : outcome.status === 'prefiltered'
                                  ? `低分辨率预判为非目标（置信度 ${Math.round(
                                      (outcome.classification?.confidence ?? 0) *
                                        100,
                                    )}%）`
                                  : `失败（${outcome.error ?? '未知错误'}）`}
                          </div>
                          {outcome.classification && (
                            <p className="llm-page-classification-reason">
                              {outcome.classification.reason}
                            </p>
                          )}
                          {outcome.raw && (
                            <pre className="llm-page-detail-raw">{outcome.raw}</pre>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                <section className="label-structure-section">
                  <h3>单证结构（模型判定，可修改）</h3>
                  <div className="label-structure-options">
                    {STRUCTURE_OPTIONS.map((opt) => (
                      <label
                        key={opt.value}
                        className={`label-structure-option ${review.structureType === opt.value ? 'active' : ''}`}
                      >
                        <input
                          type="radio"
                          name="llm-structure"
                          checked={review.structureType === opt.value}
                          onChange={() => handleStructureChange(opt.value)}
                        />
                        <span className="option-title">{opt.label}</span>
                        <span className="option-desc">{opt.desc}</span>
                      </label>
                    ))}
                  </div>
                </section>

                <section className="label-fields-section">
                  {review.structureType === 'single' && (
                    <>
                      <h3>发票字段</h3>
                      <HeaderFieldsForm
                        fields={template.headerFields}
                        values={review.fieldValues}
                        onChange={handleSingleFieldChange}
                      />
                    </>
                  )}

                  {review.structureType === 'multi_invoice' && (
                    <>
                      <h3>多张发票</h3>
                      <InvoiceEntriesEditor
                        entries={review.invoiceEntries}
                        fields={template.headerFields}
                        onAdd={handleAddInvoice}
                        onRemove={handleRemoveInvoice}
                        onChange={handleInvoiceEntryFieldChange}
                      />
                    </>
                  )}

                  {review.structureType === 'invoice_with_sublist' && (
                    <>
                      <h3>发票头信息</h3>
                      <HeaderFieldsForm
                        fields={template.headerFields}
                        values={review.invoiceHeader}
                        onChange={handleInvoiceHeaderChange}
                      />
                      <h3 className="label-subsection-title">子清单明细</h3>
                      {hasTemplateDefaults && (
                        <button
                          type="button"
                          className="btn btn-outline btn-sm label-template-fill-btn"
                          onClick={handleApplyTemplateDefaults}
                        >
                          填入版式预填值
                        </button>
                      )}
                      <SublistTableEditor
                        rows={review.sublistRows}
                        columns={template.sublistColumns}
                        headerFields={template.headerFields}
                        headerValues={review.invoiceHeader}
                        onAddRow={handleAddSublistRow}
                        onRemoveRow={handleRemoveSublistRow}
                        onCellChange={handleSublistCellChange}
                      />
                    </>
                  )}

                  {review.structureType === 'multi_invoice_with_sublist' && (
                    <>
                      <h3>多张发票（各含子清单）</h3>
                      {hasTemplateDefaults && (
                        <button
                          type="button"
                          className="btn btn-outline btn-sm label-template-fill-btn"
                          onClick={handleApplyTemplateDefaults}
                        >
                          填入版式预填值（全部发票）
                        </button>
                      )}
                      <InvoiceWithSublistEntriesEditor
                        entries={review.invoiceEntries}
                        headerFields={template.headerFields}
                        sublistColumns={template.sublistColumns}
                        hasTemplateDefaults={hasTemplateDefaults}
                        onAdd={handleAddInvoice}
                        onRemove={handleRemoveInvoice}
                        onHeaderChange={handleInvoiceEntryFieldChange}
                        onApplyEntryDefaults={handleApplyEntryTemplateDefaults}
                        onAddSublistRow={handleInvoiceSublistAddRow}
                        onRemoveSublistRow={handleInvoiceSublistRemoveRow}
                        onSublistCellChange={handleInvoiceSublistCellChange}
                      />
                    </>
                  )}
                </section>

                <section className="label-note-section">
                  <label className="field-label-input">
                    <span>备注（可选）</span>
                    <textarea
                      className="label-note-input"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="补充说明…"
                      rows={3}
                    />
                  </label>
                </section>

                <div className="label-annotation-actions">
                  <div className="label-annotation-buttons">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={handleExport}
                    >
                      导出 JSON
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>
        </main>
      )}
    </div>
  )
}
