import { authFetch } from './auth'
import type { LlmExample } from '../types/llmExamples'
import { resolveExampleMediaType } from '../types/llmExamples'

async function responseError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { detail?: string }
    if (data.detail) return data.detail
  } catch {
    // ignore non-JSON error body
  }
  return `样例服务请求失败（${res.status}）`
}

export async function listLlmExamples(layoutTemplateId: string): Promise<LlmExample[]> {
  const params = new URLSearchParams({ layout_template_id: layoutTemplateId })
  const res = await authFetch(`/api/label/examples?${params}`)
  if (!res.ok) throw new Error(await responseError(res))
  const data = (await res.json()) as { examples?: LlmExample[] }
  return data.examples ?? []
}

export async function uploadLlmExample(params: {
  layoutTemplateId: string
  category: 'target' | 'non_target'
  sample: File
  answer: Record<string, unknown>
}): Promise<LlmExample> {
  const form = new FormData()
  form.set('layout_template_id', params.layoutTemplateId)
  form.set('category', params.category)
  form.set('answer_json', JSON.stringify(params.answer))
  form.set('sample', params.sample)
  const res = await authFetch('/api/label/examples', {
    method: 'POST',
    body: form,
  })
  if (!res.ok) throw new Error(await responseError(res))
  const data = (await res.json()) as { example: LlmExample }
  return data.example
}

export async function deleteLlmExample(exampleId: number): Promise<void> {
  const res = await authFetch(`/api/label/examples/${exampleId}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(await responseError(res))
}

export async function downloadLlmExampleFile(example: LlmExample): Promise<File> {
  const res = await authFetch(example.pdf_url)
  if (!res.ok) throw new Error(await responseError(res))
  const blob = await res.blob()
  const mime =
    resolveExampleMediaType(example) === 'image'
      ? blob.type || 'image/jpeg'
      : 'application/pdf'
  return new File([blob], example.file_name, { type: mime })
}

/** @deprecated 使用 downloadLlmExampleFile */
export const downloadLlmExamplePdf = downloadLlmExampleFile
