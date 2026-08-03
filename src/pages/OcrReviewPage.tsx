import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { checkLlmHealth } from '../api/llm'
import {
  cancelLlmJob,
  createLlmJob,
  downloadJobExportZip,
  fetchJobDocumentResult,
  fetchLlmJob,
  getStoredActiveJobId,
  isJobActive,
  jobDocumentFileUrl,
  patchJobDocument,
  setStoredActiveJobId,
  subscribeLlmJobEvents,
  type JobDocument,
  type JobPageOutcome,
  type LlmJob,
} from '../api/llmJobs'
import { LlmConfigPanel } from '../components/LlmConfigPanel'
import { PdfPreview } from '../components/PdfPreview'
import { UploadPanel } from '../components/UploadPanel'
import { HeaderFieldsForm } from '../components/labeling/HeaderFieldsForm'
import { InvoiceEntriesEditor } from '../components/labeling/InvoiceEntriesEditor'
import { InvoiceWithSublistEntriesEditor } from '../components/labeling/InvoiceWithSublistEntriesEditor'
import { SublistTableEditor } from '../components/labeling/SublistTableEditor'
import { usePersistedPanelWidth } from '../hooks/usePersistedPanelWidth'
import type {
  InvoiceEntry,
  SublistRow,
  TargetStructureType,
} from '../types/labeling'
import { STRUCTURE_OPTIONS } from '../types/labeling'
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
import type { PageOutcome, PdfExtractionResult, ReviewDocData } from '../utils/llmExtraction'
import { extractionToReviewData } from '../utils/llmExtraction'

const WORKFLOW_STEPS = [
  { key: 'upload', label: '上传 PDF' },
  { key: 'extract', label: '排队抽取' },
  { key: 'review', label: '字段审核' },
  { key: 'export', label: '导出 JSON' },
]

function pageNumbers(outcomes: PageOutcome[], status: PageOutcome['status']): number[] {
  return outcomes
    .filter((o) => o.status === status)
    .map((o) => o.pageIndex + 1)
}

function toPageOutcomes(outcomes: JobPageOutcome[]): PageOutcome[] {
  return outcomes.map((o) => ({
    pageIndex: o.pageIndex,
    status: o.status,
    error: o.error,
    raw: o.raw,
  }))
}

export default function OcrReviewPage() {
  const [step, setStep] = useState<'upload' | 'review'>('upload')
  const [files, setFiles] = useState<File[]>([])
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null)

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

  const [job, setJob] = useState<LlmJob | null>(null)
  const [llmStream, setLlmStream] = useState<{ label: string; text: string } | null>(
    null,
  )
  const [extraction, setExtraction] = useState<PdfExtractionResult | null>(null)
  const [review, setReview] = useState<ReviewDocData | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(true)
  const [loadedDocId, setLoadedDocId] = useState<string | null>(null)

  const previewUrlRef = useRef<string | null>(null)
  const unsubRef = useRef<(() => void) | null>(null)
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

  const revokePreview = () => {
    if (previewUrlRef.current?.startsWith('blob:')) {
      URL.revokeObjectURL(previewUrlRef.current)
    }
    previewUrlRef.current = null
    setPreviewUrl(null)
  }

  const setPreview = (url: string | null) => {
    if (previewUrlRef.current?.startsWith('blob:') && previewUrlRef.current !== url) {
      URL.revokeObjectURL(previewUrlRef.current)
    }
    previewUrlRef.current = url
    setPreviewUrl(url)
  }

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

  useEffect(() => {
    setLlmConfig(loadLlmConfig(template))
  }, [template])

  // 卸载时只断开 SSE，不取消后台任务
  useEffect(() => {
    return () => {
      unsubRef.current?.()
      unsubRef.current = null
      if (previewUrlRef.current?.startsWith('blob:')) {
        URL.revokeObjectURL(previewUrlRef.current)
      }
    }
  }, [])

  const applyJobSnapshot = useCallback((next: LlmJob) => {
    setJob(next)
    setStoredActiveJobId(next.id)
    if (next.current?.streamLabel) {
      setLlmStream({
        label: next.current.streamLabel,
        text: next.current.streamText || '',
      })
    }
    if (!isJobActive(next.status)) {
      setLlmStream((prev) =>
        prev
          ? {
              label:
                next.status === 'completed'
                  ? '批量抽取已完成'
                  : next.status === 'cancelled'
                    ? '任务已中断'
                    : '任务已结束',
              text: prev.text,
            }
          : prev,
      )
    }
  }, [])

  const subscribeJob = useCallback(
    (jobId: string) => {
      unsubRef.current?.()
      unsubRef.current = subscribeLlmJobEvents(
        jobId,
        (event, data) => {
          if (event === 'snapshot') {
            applyJobSnapshot(data as LlmJob)
            return
          }
          if (event === 'stream') {
            const current = data as LlmJob['current']
            if (current) {
              setLlmStream({
                label: current.streamLabel,
                text: current.streamText,
              })
              setJob((prev) =>
                prev
                  ? {
                      ...prev,
                      current,
                      documents: prev.documents.map((doc) =>
                        doc.id === current.docId
                          ? {
                              ...doc,
                              status: 'running',
                              progress: {
                                done: current.pageIndex,
                                total: current.totalPages,
                              },
                            }
                          : doc,
                      ),
                    }
                  : prev,
              )
            }
            return
          }
          if (event === 'page_done') {
            const payload = data as {
              docId: string
              outcome: JobPageOutcome
              done: number
              total: number
            }
            setJob((prev) => {
              if (!prev) return prev
              return {
                ...prev,
                documents: prev.documents.map((doc) =>
                  doc.id === payload.docId
                    ? {
                        ...doc,
                        status: 'running',
                        progress: { done: payload.done, total: payload.total },
                        pageOutcomes: [...doc.pageOutcomes, payload.outcome],
                      }
                    : doc,
                ),
              }
            })
            return
          }
          if (event === 'doc_started' || event === 'doc_done' || event === 'doc_error') {
            void fetchLlmJob(jobId).then(applyJobSnapshot).catch(() => undefined)
            return
          }
          if (event === 'job_status') {
            void fetchLlmJob(jobId).then(applyJobSnapshot).catch(() => undefined)
          }
        },
        () => {
          // SSE 短暂断开时用轮询兜底；不取消任务
          void fetchLlmJob(jobId)
            .then(applyJobSnapshot)
            .catch(() => undefined)
        },
      )
    },
    [applyJobSnapshot],
  )

  // 刷新后恢复未完成/可继续查看的任务
  useEffect(() => {
    let cancelled = false
    const restore = async () => {
      const jobId = getStoredActiveJobId()
      if (!jobId) {
        setRestoring(false)
        return
      }
      try {
        const existing = await fetchLlmJob(jobId)
        if (cancelled) return
        applyJobSnapshot(existing)
        if (isJobActive(existing.status)) {
          subscribeJob(existing.id)
        }
        const firstDone =
          existing.documents.find((d) => d.status === 'done') ??
          existing.documents[0] ??
          null
        if (firstDone) {
          setSelectedDocId(firstDone.id)
          setPreview(jobDocumentFileUrl(existing.id, firstDone.id))
        }
      } catch {
        if (!cancelled) setStoredActiveJobId(null)
      } finally {
        if (!cancelled) setRestoring(false)
      }
    }
    void restore()
    return () => {
      cancelled = true
    }
  }, [applyJobSnapshot, subscribeJob])

  const loadDocResult = useCallback(
    async (activeJob: LlmJob, doc: JobDocument) => {
      if (doc.status !== 'done') {
        setExtraction(null)
        setReview(null)
        setLoadedDocId(null)
        setNote(doc.note || '')
        return
      }
      try {
        const result = await fetchJobDocumentResult(activeJob.id, doc.id)
        const pageOutcomes = toPageOutcomes(result.pageOutcomes)
        const extractionResult: PdfExtractionResult = {
          structureType: result.structureType as TargetStructureType,
          invoices: result.invoices,
          pageOutcomes,
        }
        const reviewTemplate = getLabelTemplate(activeJob.templateId)
        setExtraction(extractionResult)
        setReview(extractionToReviewData(extractionResult, reviewTemplate))
        setLoadedDocId(doc.id)
        setNote(doc.note || '')
        setTemplateId(activeJob.templateId)
        setError(null)
        setStep('review')
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载识别结果失败')
      }
    },
    [],
  )

  const handleSelectDoc = async (docId: string) => {
    setSelectedDocId(docId)
    if (job) {
      const doc = job.documents.find((d) => d.id === docId)
      if (!doc) return
      setPreview(jobDocumentFileUrl(job.id, doc.id))
      await loadDocResult(job, doc)
      return
    }
    const index = files.findIndex((_, i) => `local-${i}-${files[i].name}` === docId)
    if (index >= 0) {
      setPreview(URL.createObjectURL(files[index]))
    }
  }

  const handleConfigChange = (patch: Partial<LlmExtractionConfig>) => {
    setLlmConfig((prev) => {
      const next = { ...prev, ...patch }
      saveLlmConfig(templateId, next)
      return next
    })
  }

  const handleConfigReset = () => {
    clearLlmConfig(templateId)
    setLlmConfig(buildDefaultLlmConfig(template))
  }

  const handleFilesSelect = (selected: File[]) => {
    if (job && isJobActive(job.status)) {
      setError('当前任务仍在运行。请先中断，或等任务结束后再新建。')
      return
    }
    // 新建本地选择会离开旧任务视图
    unsubRef.current?.()
    unsubRef.current = null
    setJob(null)
    setStoredActiveJobId(null)
    setFiles(selected)
    setSelectedDocId(selected[0] ? `local-0-${selected[0].name}` : null)
    setPreview(selected[0] ? URL.createObjectURL(selected[0]) : null)
    setExtraction(null)
    setReview(null)
    setLoadedDocId(null)
    setLlmStream(null)
    setNote('')
    setError(null)
    setStep('upload')
  }

  const handleReset = () => {
    if (job && isJobActive(job.status)) {
      if (!window.confirm('当前任务仍在后台运行。清空仅离开界面，不会中断任务。确定？')) {
        return
      }
    }
    unsubRef.current?.()
    unsubRef.current = null
    revokePreview()
    setFiles([])
    setSelectedDocId(null)
    setJob(null)
    setStoredActiveJobId(null)
    setExtraction(null)
    setReview(null)
    setLoadedDocId(null)
    setLlmStream(null)
    setNote('')
    setError(null)
    setStep('upload')
  }

  const handleRun = async () => {
    if (files.length === 0 || (job && isJobActive(job.status))) return

    const { error: requestError } = parseRequestJson(llmConfig.requestJson)
    if (requestError) {
      setError(`大模型请求配置有误：${requestError}`)
      return
    }

    setError(null)
    setExtraction(null)
    setReview(null)
    setLlmStream({ label: '上传文件并创建后台任务…', text: '' })

    try {
      const created = await createLlmJob({
        files,
        templateId,
        requestJson: llmConfig.requestJson,
        headerFields: template.headerFields,
        sublistColumns: template.sublistColumns,
        requiredSublistKeys: template.requiredSublistKeys ?? [],
        llmModel,
      })
      applyJobSnapshot(created)
      setFiles([])
      const first = created.documents[0]
      if (first) {
        setSelectedDocId(first.id)
        setPreview(jobDocumentFileUrl(created.id, first.id))
      }
      subscribeJob(created.id)
    } catch (err) {
      setLlmStream(null)
      setError(err instanceof Error ? err.message : '创建识别任务失败')
    }
  }

  const handleAbort = async () => {
    if (!job) return
    try {
      const cancelled = await cancelLlmJob(job.id)
      applyJobSnapshot(cancelled)
      setError('已请求中断；当前页推理结束后任务会停止')
    } catch (err) {
      setError(err instanceof Error ? err.message : '中断失败')
    }
  }

  const handleExportBatch = async () => {
    if (!job) return
    try {
      await downloadJobExportZip(job.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出 ZIP 失败')
    }
  }

  // 任务中某文档完成且当前选中它时，自动载入审核
  useEffect(() => {
    if (!job || !selectedDocId) return
    const doc = job.documents.find((d) => d.id === selectedDocId)
    if (!doc || doc.status !== 'done') return
    if (loadedDocId === doc.id) return
    void loadDocResult(job, doc)
  }, [job, selectedDocId, loadedDocId, loadDocResult])

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

  const selectedJobDoc = job?.documents.find((d) => d.id === selectedDocId) ?? null
  const selectedFileName =
    selectedJobDoc?.fileName ??
    (selectedDocId?.startsWith('local-')
      ? files.find((_, i) => `local-${i}-${files[i].name}` === selectedDocId)?.name
      : undefined)

  const handleExport = async () => {
    if (!review || !selectedFileName) return
    const headerFields = job?.headerFields?.length
      ? job.headerFields
      : template.headerFields
    const sublistColumns = job?.sublistColumns?.length
      ? job.sublistColumns
      : template.sublistColumns

    const payload = {
      ...buildDocumentExportPayload(
        {
          id: selectedDocId ?? 'llm-review',
          fileName: selectedFileName,
          fileSize: selectedJobDoc?.fileSize ?? 0,
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
        headerFields,
        sublistColumns,
      ),
      extraction: {
        engine: `ollama/${job?.llmModel || llmModel || '未设置'}`,
        layoutTemplateId: job?.templateId ?? templateId,
        totalPages: extraction?.pageOutcomes.length ?? 0,
        targetPages: pageNumbers(extraction?.pageOutcomes ?? [], 'target'),
        skippedPages: pageNumbers(extraction?.pageOutcomes ?? [], 'skipped'),
        errorPages: (extraction?.pageOutcomes ?? [])
          .filter((o) => o.status === 'error')
          .map((o) => ({ page: o.pageIndex + 1, error: o.error })),
      },
    }

    if (job && selectedDocId) {
      try {
        await patchJobDocument(job.id, selectedDocId, {
          note,
          exportPayload: payload,
        })
      } catch {
        // 本地导出仍继续
      }
    }

    downloadJson(payload, documentExportFileName(selectedFileName))
  }

  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      const stepPx = event.shiftKey ? 40 : 16
      const delta = event.key === 'ArrowLeft' ? stepPx : -stepPx
      setRightPanelWidth((current) => Math.min(960, Math.max(320, current + delta)))
    },
    [setRightPanelWidth],
  )

  const handleUploadResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      const stepPx = event.shiftKey ? 40 : 16
      const delta = event.key === 'ArrowLeft' ? stepPx : -stepPx
      setUploadConfigWidth((current) =>
        Math.min(
          uploadConfigMaxWidth,
          Math.max(uploadConfigMinWidth, current + delta),
        ),
      )
    },
    [setUploadConfigWidth, uploadConfigMaxWidth, uploadConfigMinWidth],
  )

  const isRecognizing = Boolean(job && isJobActive(job.status))
  const hasFiles = files.length > 0 || Boolean(job?.documents.length)
  const currentStepIndex =
    step === 'upload' ? (isRecognizing ? 1 : hasFiles ? 1 : 0) : 2

  const skippedPages = pageNumbers(extraction?.pageOutcomes ?? [], 'skipped')
  const errorOutcomes = (extraction?.pageOutcomes ?? []).filter(
    (o) => o.status === 'error',
  )

  const modelMissing =
    llmReady &&
    llmModels.length > 0 &&
    llmModel !== '' &&
    !llmModels.includes(llmModel) &&
    !llmModels.includes(`${llmModel}:latest`)

  const progressDone = job
    ? job.documents.reduce((sum, doc) => sum + (doc.progress?.done ?? 0), 0)
    : 0
  const progressTotal = job
    ? job.documents.reduce((sum, doc) => sum + (doc.progress?.total ?? 0), 0)
    : 0
  const docsDone = job?.documents.filter((d) => d.status === 'done').length ?? 0
  const docsTotal = job?.documents.length ?? 0

  return (
    <div className="ocr-review-page">
      <header className="page-header">
        <div className="brand">
          <h1>智能预识别审核</h1>
          <p>
            批量上传 PDF → 服务端排队抽取（关闭页面不中断）→ 审核修正 → 导出 JSON / ZIP
            <span className="engine-tag">
              引擎: ollama/{job?.llmModel || llmModel || '未设置'}
              {llmReady ? '' : '（未连接）'}
            </span>
          </p>
        </div>
        {step === 'review' && (
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => setStep('upload')}
          >
            返回队列
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
      {restoring && <div className="toast-banner">正在恢复上次识别任务…</div>}
      {!llmReady && step === 'upload' && (
        <div className="toast-banner">
          未连接到 Ollama 服务。请确认 Qwen3-VL 已启动，且 Ollama 监听 0.0.0.0:11434
          （OLLAMA_HOST=0.0.0.0:11434 ollama serve）。Docker 部署可执行 docker logs
          ppocr-web 查看 Ollama 连通性检测。
        </div>
      )}
      {modelMissing && step === 'upload' && !job && (
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
              files={files}
              jobDocuments={job?.documents}
              selectedDocId={selectedDocId}
              previewUrl={previewUrl}
              isRecognizing={isRecognizing}
              ocrReady={llmReady}
              llmStream={llmStream}
              job={job}
              onFilesSelect={handleFilesSelect}
              onSelectDoc={(id) => void handleSelectDoc(id)}
              onRunOcr={() => void handleRun()}
              onReset={handleReset}
              onCancelJob={() => void handleAbort()}
              onExportBatch={() => void handleExportBatch()}
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
                      disabled={isRecognizing || Boolean(job)}
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

            {(isRecognizing || (job && job.documents.some((d) => d.pageOutcomes.length))) && (
              <section className="llm-progress-card">
                <div className="llm-progress-header">
                  <strong>
                    {isRecognizing
                      ? `排队抽取中… 文件 ${docsDone}/${docsTotal}`
                      : `任务 ${job?.status} · 文件 ${docsDone}/${docsTotal}`}
                    {progressTotal > 0 ? ` · 页 ${progressDone}/${progressTotal}` : ''}
                  </strong>
                  {isRecognizing && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => void handleAbort()}
                    >
                      中断
                    </button>
                  )}
                </div>
                {job?.documents.map((doc) => (
                  <div key={doc.id} className="llm-batch-doc-progress">
                    <div className="llm-batch-doc-progress-title">
                      {doc.fileName}
                      <span>
                        {doc.status}
                        {doc.progress.total > 0
                          ? ` ${doc.progress.done}/${doc.progress.total}`
                          : ''}
                      </span>
                    </div>
                    {doc.pageOutcomes.length > 0 && (
                      <ul className="llm-progress-pages">
                        {doc.pageOutcomes.map((outcome) => (
                          <li
                            key={`${doc.id}-${outcome.pageIndex}`}
                            className={`llm-page-${outcome.status}`}
                          >
                            第 {outcome.pageIndex + 1} 页：
                            {outcome.status === 'target'
                              ? '已抽取'
                              : outcome.status === 'skipped'
                                ? '无目标字段，已跳过'
                                : `失败（${outcome.error ?? '未知错误'}）`}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
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
              {selectedJobDoc && (
                <span>{(selectedJobDoc.fileSize / 1024).toFixed(1)} KB</span>
              )}
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
                  <p className="label-current-file" title={selectedFileName}>
                    {selectedFileName}
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
                                : `失败（${outcome.error ?? '未知错误'}）`}
                          </div>
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
                      onClick={() => void handleExport()}
                    >
                      导出 JSON
                    </button>
                    {job && docsDone > 0 && (
                      <button
                        type="button"
                        className="btn btn-outline"
                        onClick={() => void handleExportBatch()}
                      >
                        导出全部 ZIP
                      </button>
                    )}
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
