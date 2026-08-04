/** 服务端批量预识别任务 API */

export type JobDocStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'error'
  | 'cancelled'

export type JobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed'

export interface JobPageOutcome {
  pageIndex: number
  status: 'target' | 'skipped' | 'error'
  error?: string
  raw?: string
}

export interface JobDocument {
  id: string
  fileName: string
  fileSize: number
  status: JobDocStatus
  progress: { done: number; total: number }
  pageOutcomes: JobPageOutcome[]
  error?: string | null
  structureType?: string | null
  hasResult: boolean
  note: string
}

export interface JobCurrent {
  docId: string
  fileName: string
  pageIndex: number
  totalPages: number
  streamLabel: string
  streamText: string
}

export interface LlmJob {
  id: string
  createdAt: string
  updatedAt: string
  status: JobStatus
  templateId: string
  llmModel: string
  headerFields: Array<{ id: string; key: string; label: string }>
  sublistColumns: Array<{ id: string; key: string; label: string }>
  requiredSublistKeys: string[]
  documents: JobDocument[]
  current: JobCurrent | null
  error?: string | null
  cancelRequested?: boolean
}

export interface JobDocumentResult {
  exportPayload?: Record<string, unknown>
  structureType: string
  invoices: Array<{
    header: Record<string, string>
    sublist: Array<Record<string, string>>
  }>
  pageOutcomes: JobPageOutcome[]
}

export interface CreateLlmJobParams {
  files: File[]
  templateId: string
  requestJson: string
  headerFields: unknown
  sublistColumns: unknown
  requiredSublistKeys: string[]
  llmModel: string
}

const ACTIVE_JOB_KEY = 'ppocr-active-llm-job-id'

export function getStoredActiveJobId(): string | null {
  return localStorage.getItem(ACTIVE_JOB_KEY)
}

export function setStoredActiveJobId(jobId: string | null) {
  if (jobId) localStorage.setItem(ACTIVE_JOB_KEY, jobId)
  else localStorage.removeItem(ACTIVE_JOB_KEY)
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  if (!text.trim()) return `请求失败（${res.status}）`
  try {
    const data = JSON.parse(text) as { detail?: string }
    if (data.detail) return data.detail
  } catch {
    // ignore
  }
  return text.slice(0, 200)
}

export async function createLlmJob(params: CreateLlmJobParams): Promise<LlmJob> {
  const form = new FormData()
  for (const file of params.files) {
    form.append('files', file, file.name)
  }
  form.append('template_id', params.templateId)
  form.append('request_json', params.requestJson)
  form.append('header_fields', JSON.stringify(params.headerFields))
  form.append('sublist_columns', JSON.stringify(params.sublistColumns))
  form.append('required_sublist_keys', JSON.stringify(params.requiredSublistKeys))
  form.append('llm_model', params.llmModel)

  const res = await fetch('/api/label/llm-jobs', {
    method: 'POST',
    body: form,
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function fetchLlmJob(jobId: string): Promise<LlmJob> {
  const res = await fetch(`/api/label/llm-jobs/${jobId}`)
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function cancelLlmJob(jobId: string): Promise<LlmJob> {
  const res = await fetch(`/api/label/llm-jobs/${jobId}/cancel`, { method: 'POST' })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export function jobDocumentFileUrl(jobId: string, docId: string): string {
  return `/api/label/llm-jobs/${jobId}/documents/${docId}/file`
}

export async function fetchJobDocumentResult(
  jobId: string,
  docId: string,
): Promise<JobDocumentResult> {
  const res = await fetch(`/api/label/llm-jobs/${jobId}/documents/${docId}/result`)
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function patchJobDocument(
  jobId: string,
  docId: string,
  body: { note?: string; exportPayload?: Record<string, unknown> },
): Promise<void> {
  const res = await fetch(`/api/label/llm-jobs/${jobId}/documents/${docId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await readError(res))
}

export async function downloadJobExportZip(jobId: string): Promise<void> {
  const res = await fetch(`/api/label/llm-jobs/${jobId}/export.zip`)
  if (!res.ok) throw new Error(await readError(res))
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `llm-results-${jobId}.zip`
  a.click()
  URL.revokeObjectURL(url)
}

export type LlmJobEventHandler = (event: string, data: unknown) => void

/** 订阅任务 SSE；返回关闭函数。刷新后可再次连接，不会中断后台任务。 */
export function subscribeLlmJobEvents(
  jobId: string,
  onEvent: LlmJobEventHandler,
  onError?: (error: Event) => void,
): () => void {
  const source = new EventSource(`/api/label/llm-jobs/${jobId}/events`)
  const forward = (eventName: string) => (ev: MessageEvent) => {
    try {
      onEvent(eventName, JSON.parse(ev.data))
    } catch {
      onEvent(eventName, ev.data)
    }
  }

  source.addEventListener('snapshot', forward('snapshot'))
  source.addEventListener('job_status', forward('job_status'))
  source.addEventListener('doc_started', forward('doc_started'))
  source.addEventListener('page_done', forward('page_done'))
  source.addEventListener('stream', forward('stream'))
  source.addEventListener('doc_done', forward('doc_done'))
  source.addEventListener('doc_error', forward('doc_error'))
  source.onerror = (ev) => onError?.(ev)

  return () => {
    source.close()
  }
}

export function isJobActive(status: JobStatus): boolean {
  return status === 'queued' || status === 'running'
}
